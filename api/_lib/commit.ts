/**
 * StateChanges → idempotent Zoho writes.
 *
 * Every write is an upsert keyed by the row's own business key (App ID, Series,
 * Setting), which is what makes a commit safe to retry after a partial failure: the
 * second attempt re-writes the same rows rather than duplicating ledger lines — the one
 * exception is the audit trail, which is insert-only: an upsert naming an App ID that
 * already exists is skipped, so no commit (and no retry) can rewrite history. The
 * revision row is bumped last so a reader either sees the old plant whole or the new
 * plant whole — unless nothing landed: a commit whose every row was already exactly
 * what it carried (an idempotent retry end to end) writes nothing, bumps nothing and
 * answers the unchanged token, because a bump would order every device in the plant
 * to re-sweep for a nothing-burger. Tables gated behind a permission the caller
 * lacks are refused here — this is the RLS of the fork, and the client maps the 403
 * to the same 'forbidden' message it always had.
 *
 * A commit is also refused, whole, before a single write lands, when any row it
 * would replace no longer matches the version the caller based their edit on
 * (`expect`, carried per row by src/lib/sync.ts). That is what makes a
 * simultaneous edit a refused save instead of a silent overwrite, and what makes
 * two devices minting the same document number a refused insert instead of one
 * receipt quietly replacing the other while both ledger lines survive.
 */
import { ZohoApiError, ZohoCasConflictError } from './zoho.js'
import type { ZohoClient, ZohoRecord } from './zoho.js'
import type { TableRef } from './baseSchema.js'
import { T, TABLE_FOR } from './baseSchema.js'
import { columnsFor, ledgerColumns, auditColumns, buildLinkMaps, mergeLinkRows, type LinkTableKey } from './mappers.js'
import { FIXED_VENDOR_TYPES } from '../../src/lib/vendorTypes.js'
import { COLLECTIONS } from '../../src/lib/tables.js'
import type { StateChanges } from '../../src/lib/sync.js'
import type { Caller } from './auth.js'
import { cachedLedgerWatermark, noteCommitApplied, noteRevision } from './snapshot.js'
import {
  Conflict,
  detectRowConflicts,
  expectedPeriodOf,
  gateAuditRemove,
  gateAuditRide,
  gateConfigKeys,
  gateCounterJumps,
  gateTablePermissions,
  jsonEq,
  provenanceDetails,
  versionNumberOf,
  versionTokenOf,
} from './commitGates.js'

// The gates' public surface keeps its address: the route and the tests import
// the error classes and validateChanges from here, exactly as they did before
// the extraction — the D1 engine (Phase 4) imports them from commitGates
// directly, so the two engines cannot drift.
export { Forbidden, Malformed, validateChanges, Conflict } from './commitGates.js'
export type { RowConflict } from './commitGates.js'

/**
 * The version-token plan for one row write — S2-5's cross-instance optimistic
 * concurrency. The Version column (added to the 21 editable tables of both
 * bases, 2026-10-07) holds the composite token "<AppID>:<n>"; the criteria
 * grammar has no AND (every shape answers 500 — probe-version.mjs, 2026-10-07),
 * so row identity rides INSIDE the token value and the conditional write is one
 * text equality on it, update-only (`is_upsert_needed: false`; upsert-true on a
 * no-match mints a duplicate row — pinned live). An empty `records.updated`
 * answer is the conflict: the row moved between this commit's pre-flight and
 * its write, on this instance or any other — the one race the per-process
 * commit queue could never see.
 *
 * Rows of tables without the column (ledger, audits, vendor types) keep
 * today's unconditional keyed upsert. Rows whose token is empty (every legacy
 * row), malformed, or not this row's own (a hand edit in the Zoho UI) keep
 * today's shape too and stamp their first token — the live base migrates
 * lazily, one row per first edit, no backfill; nothing about the client
 * protocol changes. The strict "<appId>:<digits>" parse is what keeps the
 * criteria unambiguous: only this row's own token can match it.
 */
export function versionPlan(
  table: TableRef,
  appId: string,
  stored: ZohoRecord | undefined,
): { versionFieldId: string; cas: { versionFieldId: string; expected: string } | null; stamp: string } {
  const versionFieldId = table.fields['Version'] ?? ''
  if (!versionFieldId) return { versionFieldId: '', cas: null, stamp: '' }
  const storedToken = stored ? String(stored.data[versionFieldId] ?? '') : ''
  // The "<appId>:<digits>" grammar lives in commitGates (versionTokenOf /
  // versionNumberOf) so the D1 engine stamps the same tokens — the compliance
  // register's client-visible baseVersion shares it.
  const n = versionNumberOf(appId, storedToken)
  if (n !== null) {
    const expected = storedToken
    return { versionFieldId, cas: { versionFieldId, expected }, stamp: versionTokenOf(appId, n + 1) }
  }
  return { versionFieldId, cas: null, stamp: versionTokenOf(appId, 1) }
}

/**
 * Mapper columns arrive keyed by field NAME (readable, checked against the base by
 * eye); the wire speaks field IDs — `upsertByKey` sends `is_ids_used_in_data: true`,
 * so a name in that map is read as a bogus ID and the live API answers
 * 500 INTERNAL SERVER ERROR (pinned against the scratch base, 2026-09-22: every
 * name-keyed enrichment 500s while the same row with ID keys succeeds). Names the
 * generated schema does not know are dropped silently — the enrichment is
 * best-effort by contract; only App ID and Data JSON are load-bearing.
 */
export function columnsByFieldId(
  table: TableRef,
  columns: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(columns)) {
    if (value === undefined) continue
    const fieldId = table.fields[name]
    if (fieldId) out[fieldId] = value
  }
  return out
}

async function linkMaps(zoho: ZohoClient) {
  const grab = async (base: string) => zoho.fetchAll(T[base].id)
  return buildLinkMaps(
    {
      vendors: await grab('Vendors'),
      vendorTypes: await grab('Vendor Types'),
      purchaseProducts: await grab('Purchase Products'),
      storageLocations: await grab('Storage Locations'),
      items: await grab('Items'),
      customers: await grab('Customers'),
      products: await grab('Products'),
      batches: await grab('Batches'),
      staff: await grab('Staff'),
    },
    {
      vendors: T['Vendors'], vendorTypes: T['Vendor Types'], purchaseProducts: T['Purchase Products'], storageLocations: T['Storage Locations'], items: T['Items'],
      customers: T['Customers'], products: T['Products'], batches: T['Batches'], staff: T['Staff'],
    },
  )
}

/**
 * The last link maps this process built, with the revision they were read at.
 *
 * A commit spends nine reads on masters for column enrichment (the four the fork
 * started with, plus customers, products, batches, staff and vendor types for the
 * Plan 2 link columns), and enrichment is best-effort by contract (only App ID and Data JSON
 * are load-bearing) — but the masters only ever change through a commit, and every
 * commit bumps the revision last, so maps read at revision R are exactly what a
 * fresh read at R would return. The revision a commit already reads (the config
 * gate below) answers whether the memo still stands; a commit that itself wrote a
 * master table drops it. Same argument, same shape as the snapshot cache — and
 * eight reads back per commit.
 */
let linkMemo: { revision: string; maps: Awaited<ReturnType<typeof linkMaps>> } | null = null

/** The base tables whose rows feed link maps — a commit touching any of them spends the memo. */
const LINK_TABLES = new Set(['Vendor Types', 'Vendors', 'Purchase Products', 'Storage Locations', 'Items', 'Customers', 'Products', 'Batches', 'Staff'])

/** The link-table keys a client table name feeds — the same-commit fixup refreshes
 *  maps for exactly the link tables the commit itself wrote rows into. Vendor
 *  Types is absent: no client collection writes it, the seed below is its only
 *  writer and refreshes its map itself. */
const LINK_KEY_FOR: Partial<Record<string, LinkTableKey>> = {
  vendors: 'vendors',
  purchase_products: 'purchaseProducts',
  storage_locations: 'storageLocations',
  items: 'items',
  customers: 'customers',
  products: 'products',
  batches: 'batches',
  staff: 'staff',
}

async function linkMapsCached(zoho: ZohoClient, revision: string) {
  if (linkMemo && linkMemo.revision === revision) return linkMemo.maps
  const maps = await linkMaps(zoho)
  linkMemo = { revision, maps }
  return maps
}

/** One Config row per Setting — the one Config read a commit spends, reused by the
 *  config gate, the counter-period rule and the revision bump. */
async function configBySetting(zoho: ZohoClient): Promise<Map<string, string>> {
  const config = T['Config']
  const rows = await zoho.fetchAll(config.id)
  const out = new Map<string, string>()
  for (const r of rows) {
    const setting = String(r.data[config.fields['Setting']] ?? '')
    if (setting) out.set(setting, String(r.data[config.fields['Value']] ?? ''))
  }
  return out
}

/**
 * The row as the client would have written it, from what is stored — the shape
 * `expect` and incoming upserts are compared in. Null when the stored row has no
 * Data JSON (a row staged by hand that the app itself cannot even read); writing
 * such a row is what makes it readable, so it never counts as a conflict.
 */
function storedPayload(table: TableRef, stored: ZohoRecord): Record<string, unknown> | null {
  if (!table.dataJson) return null
  const raw = stored.data[table.dataJson]
  if (raw === undefined || raw === null || raw === '') return null
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The leading integer of a revision token ('7:ab3' → 7) — 0 for anything unparseable. */
const revisionNumberOf = (rev: string | undefined): number => parseInt(String(rev ?? ''), 10) || 0

/**
 * Bumps the revision row to a fresh token and returns it.
 *
 * The value is `<n>:<nonce>`, not a bare number: two commits reading the same
 * current revision and both writing `n+1` used to leave every reader that had
 * already cached `n+1` believing itself current, with the second commit's rows
 * committed but invisible plant-wide. A token is unique per write, so any reader
 * comparing for equality always sees the row move. Nothing ever orders revisions
 * numerically — every consumer, client and server, compares with `===`; the
 * number is for humans, and parsed (not Number()'d — a token NaNs it) so it
 * keeps counting instead of quietly resetting to 1 forever.
 */
export async function bumpRevision(zoho: ZohoClient, stored: Map<string, string>): Promise<string> {
  return bumpRevisionTo(zoho, revisionNumberOf(stored.get('app_revision')))
}

/** bumpRevision against a revision number the caller already holds — the admin
 *  audit's path, which knows it from the snapshot cache without reading Config. */
export async function bumpRevisionTo(zoho: ZohoClient, current: number): Promise<string> {
  const config = T['Config']
  const token = `${current + 1}:${Math.random().toString(36).slice(2, 8)}`
  await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_revision', {
    [config.fields['Setting']]: 'app_revision',
    [config.fields['Value']]: token,
  })
  return token
}

/**
 * One commit at a time per process. The `expect` pre-flight refuses a commit whose
 * rows moved under it, but ledger lines and audit rows carry no `expect` (sync.ts
 * sends them bare) — so for those tables the only in-process defense against two
 * interleaved commits double-posting movements is serializing the check-then-act
 * window itself. Polls, sweeps and admin actions keep overlapping freely through
 * the client's concurrency pool; only commits queue here, first come first served.
 * A rejected commit does not jam the queue — the chain swallows the outcome and
 * the next waiter runs.
 */
let commitQueue: Promise<unknown> = Promise.resolve()

/** What a commit did to the base: the revision it sits at, and whether the commit
 *  was the thing that moved it. */
export interface CommitResult {
  /** The base's revision after this commit — a fresh token when it wrote, the
   *  unchanged one when it did not. */
  token: string
  /** Whether ANY write landed (upsert, remove, config, counter). False means the
   *  whole commit was already exactly true — no reader needs to re-sweep. */
  wrote: boolean
}

export function commitChanges(zoho: ZohoClient, caller: Caller, changes: StateChanges): Promise<CommitResult> {
  const run = commitQueue.then(() => commitLocked(zoho, caller, changes))
  commitQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function commitLocked(zoho: ZohoClient, caller: Caller, changes: StateChanges): Promise<CommitResult> {
  // 1. permission gates — the RLS of this fork, shared verbatim with the D1
  //    engine (commitGates.ts): the pure verdicts first, then the two gates
  //    whose evidence is one read away (config, counters).
  const rides = gateTablePermissions(caller, changes)
  // config writes and audit deletions carry their own gates: the trail is
  // insert-only for callers without the Audit page (sync.ts only ever emits
  // audit removals from admin-side edits), and config is one stored row, so
  // its gate diffs the incoming object against what is stored and judges only
  // the keys that actually changed — sync sends the whole config, and a lab
  // tester may carry the numbering series unchanged in their payload without
  // it reading as an attempt to change it. No stored row means every key is
  // new, and first-time config is the Settings page's business.
  const storedConfig = await configBySetting(zoho)
  // Whether any config key genuinely moved under a permission this caller
  // holds — the third honest ride for an audit insert (a settings change files
  // its own audit row with no collection change behind it).
  const ownsConfigChange = gateConfigKeys(changes, storedConfig, rides.held)
  // The audits ride-along refusal stands after the config gate: an audit
  // insert a scoped caller files must stand on a collection change whose page
  // they hold, the Storage page's move shape, or a config key that genuinely
  // moved under them. Anything else is a crafted audit-only POST — the trail
  // is evidence, not a page anyone may write.
  gateAuditRide(rides, ownsConfigChange)
  gateAuditRemove(changes, rides.held)

  // Counter vaulting is refused with the other permission gates, before any
  // write lands — a refused commit is whole, rows included. Its evidence is
  // what the Counters table holds, so that read comes up here too (step 5
  // reuses it; the read is spent either way, only its order moves).
  const counters = T['Counters']
  const seriesKeys = Object.keys(changes.counters).filter((k) => !k.startsWith('period:'))
  const storedNext = new Map<string, number>()
  if (seriesKeys.length) {
    const rows = await zoho.fetchByKeyIn(counters.id, counters.fields['Series'], seriesKeys)
    for (const r of rows) {
      const series = String(r.data[counters.fields['Series']] ?? '')
      if (series) storedNext.set(series, Number(r.data[counters.fields['Next']]) || 0)
    }
    gateCounterJumps(changes.counters, storedNext, rides.admin)
  }

  // 2. link maps for column enrichment — memoized per revision (see linkMemo):
  // four reads for the first commit after anything changed, none behind it.
  const links = await linkMapsCached(zoho, storedConfig.get('app_revision') ?? '0')

  // 3. pre-flight: read every touched row once, by key, and refuse the whole
  // commit if any row moved under the caller. All-or-nothing happens here,
  // before a single write, so a refused race never leaves half a posting. The
  // verdict itself is engine-neutral (detectRowConflicts, commitGates.ts); the
  // reads that feed it stay here, and the fetched rows ride forward to step 4's
  // insert-only skip and idempotence checks.
  const existingByTable = new Map<string, Map<string, ZohoRecord>>()
  for (const change of changes.tables) {
    const base = TABLE_FOR[change.table]
    if (!base) throw new Error(`unknown table ${change.table}`)
    const table = T[base]
    const ids = [
      ...change.upsert.map((row) => String(row.id)),
      ...change.remove.map((id) => String(id)),
    ]
    const rows = await zoho.fetchByKeyIn(table.id, table.appId, ids)
    existingByTable.set(change.table, new Map(rows.map((r) => [String(r.data[table.appId] ?? ''), r])))
  }
  const conflicts = detectRowConflicts(changes, (table, id) => {
    const stored = existingByTable.get(table)?.get(id)
    return stored ? storedPayload(T[TABLE_FOR[table]], stored) : undefined
  })
  if (conflicts.length) throw new Conflict(conflicts)

  // Whether ANY write landed past this point (upsert, remove, config, counter).
  // The skips below are what make an idempotent retry free: a commit whose every
  // row was already exactly what it carried reaches step 7 with this still false
  // and the revision never moves.
  let wrote = false

  // 3b. seed the fixed vendor types this commit's vendors reference but the base
  // lacks. The types are app constants (src/lib/vendorTypes.ts): no page edits
  // them and the client's diff always sees both sides holding the same list, so
  // no device can ever write them up — without this, a fresh base's Vendor Types
  // table stays empty forever and the Vendors 'Vendor Type' link column has no
  // row to point at (the gap the scratch-base eyeball caught, 2026-10-06).
  // Keyed upserts by App ID: idempotent, one write per type per base lifetime.
  // An id the app does not know as fixed is left alone — its link stays empty
  // and the Data JSON keeps the claim.
  const seededTypes: string[] = []
  {
    const referenced = new Set<string>()
    for (const change of changes.tables) {
      if (change.table !== 'vendors') continue
      for (const row of change.upsert) {
        const t = String(((row as { data?: { vendorTypeId?: unknown } }).data ?? {}).vendorTypeId ?? '')
        if (t) referenced.add(t)
      }
    }
    const table = T['Vendor Types']
    for (const id of referenced) {
      if (links.vendorTypes.has(id)) continue
      const doc = FIXED_VENDOR_TYPES.find((v) => v.id === id)
      if (!doc) continue
      await zoho.upsertByKey(table.id, table.appId, id, {
        [table.appId]: id,
        ...(table.dataJson ? { [table.dataJson]: JSON.stringify(doc) } : {}),
        ...columnsByFieldId(table, columnsFor('vendorTypes', doc as unknown as Record<string, unknown>, links)),
      })
      wrote = true
      seededTypes.push(id)
    }
    if (seededTypes.length) {
      // the fresh record ids the seeded rows carry — the vendor rows below link
      // to them, and the maps were read before the rows existed
      const rows = await zoho.fetchByKeyIn(table.id, table.appId, seededTypes)
      mergeLinkRows(links, 'vendorTypes', rows, table)
    }
  }

  // 4. collection rows — { id, data } upserts; ledger and audits arrive flat. Audits are
  // the one insert-only table: an upsert naming an existing id is SKIPPED — a
  // crafted commit cannot rewrite history, and a retried commit re-posting its own
  // audit rows is a no-op for them (new ids still write normally). Audit actors
  // are stamped from the authenticated caller; the payload's claim about who did
  // it is not evidence — though a well-formed differing claim is preserved in
  // Details as shared-device provenance (provenanceDetails below). Every row
  // that actually lands is queued for the same-commit link fixup below (4b).
  const fixupQueue: {
    changeTable: string
    table: (typeof T)[string]
    appId: string
    values: Record<string, unknown>
    spec: (typeof COLLECTIONS)[number] | null
    payload: Record<string, unknown>
    cas: { versionFieldId: string; expected: string } | null
  }[] = []
  for (const change of changes.tables) {
    const base = TABLE_FOR[change.table]
    if (!base) throw new Error(`unknown table ${change.table}`)
    const table = T[base]
    // look the spec up by TABLE name (change.table is 'sticker_templates', the key is
    // 'stickerTemplates' — find-by-table is the one that is correct for both)
    const spec = COLLECTIONS.find((c) => c.table === change.table) ?? null
    const byApp = existingByTable.get(change.table) ?? new Map<string, ZohoRecord>()

    for (const row of change.upsert) {
      const appId = String(row.id)
      const stored = byApp.get(appId)
      if (change.table === 'audits' && stored) continue // insert-only: never rewrite an audit row
      const storedDoc = stored ? storedPayload(table, stored) : null
      const stamped =
        change.table === 'audits'
          ? { ...row, actor: caller.email, details: provenanceDetails(row, caller.email) }
          : row
      const incoming = spec ? ((stamped as { data: Record<string, unknown> }).data ?? {}) : stamped
      if (storedDoc && jsonEq(storedDoc, incoming)) continue // idempotent retry: the row is already exactly this
      let values: Record<string, unknown>
      if (change.table === 'ledger') {
        values = { [table.appId]: appId, ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}), ...columnsByFieldId(table, ledgerColumns(row, links)) }
      } else if (change.table === 'audits') {
        values = { [table.appId]: appId, ...(table.dataJson ? { [table.dataJson]: JSON.stringify(stamped) } : {}), ...columnsByFieldId(table, auditColumns(stamped)) }
      } else {
        const doc = (row as { data: Record<string, unknown> }).data
        values = {
          [table.appId]: appId,
          ...(table.dataJson ? { [table.dataJson]: JSON.stringify(doc) } : {}),
          ...(spec ? columnsByFieldId(table, columnsFor(spec.key, doc, links)) : {}),
        }
      }
      // S2-5: stamp the next token and make the write conditional on the token
      // the pre-flight observed. A row another instance moved in the window
      // between pre-flight and write refuses the whole commit with the same
      // 409 'changed' the pre-flight itself produces — the client's adoption
      // path needs no new shape. (Rows already landed when the conflict fires
      // are the same recoverable pause a mid-commit lock always was: the retry
      // skips them free through the jsonEq idempotence check.)
      const plan = versionPlan(table, appId, stored)
      if (plan.stamp) values[plan.versionFieldId] = plan.stamp
      try {
        await zoho.upsertByKey(table.id, table.appId, appId, values, plan.cas ?? undefined)
      } catch (e) {
        if (e instanceof ZohoCasConflictError) {
          throw new Conflict([{ table: change.table, id: appId, kind: 'changed' }])
        }
        throw e
      }
      wrote = true
      // audits carry no links — everything else may need the 4b pass
      if (change.table !== 'audits') {
        fixupQueue.push({
          changeTable: change.table,
          table,
          appId,
          values,
          spec,
          payload: spec ? ((row as { data?: Record<string, unknown> }).data ?? {}) : row,
          // the fixup's own conditional write gates on the token THIS commit just
          // stamped — see 4b for what a refusal there means
          cas: plan.stamp ? { versionFieldId: plan.versionFieldId, expected: plan.stamp } : null,
        })
      }
    }

    for (const id of change.remove) {
      const rid = byApp.get(String(id))?.recordID
      // An id with no row is already gone — the outcome the caller asked for.
      if (!rid) continue
      wrote = true // the delete attempt itself, even where the race below swallows it
      try {
        await zoho.deleteRecord(table.id, rid)
      } catch (e) {
        // The row stood at pre-flight yet the delete still came back refused. A
        // refusal is not proof the row is gone — it may be a genuine 400 (a
        // field-level refusal) with the row still standing, and swallowing that
        // reports a deletion that never happened while the revision bump tells
        // every device the lie is truth. Only a confirming read may decide:
        // the key is fetched back, what is truly gone is skipped (something
        // outside this process removed it inside our window — with commits
        // serialized here that cannot have been a sibling commit, and the
        // outcome the caller asked for is already true), and what still stands
        // rethrows as the honest failure it is. Anything that is not an API
        // refusal — a lock, a network fault — throws regardless.
        if (!(e instanceof ZohoApiError)) throw e
        const survivors = await zoho.fetchByKeyIn(table.id, table.appId, [String(id)])
        if (survivors.length) throw e
        console.warn(`[commit] ${change.table} ${id} vanished before its delete landed — skipped`)
      }
    }
  }

  // 4b. same-commit link fixup. The link maps were read before any row landed, so
  // a carrier whose target was written by THIS commit went out with its link
  // column empty — a raw-material save creates the item and its purchase product
  // in one state update, and before this pass the Item column stayed empty until
  // somebody happened to re-save the product, which nobody ever does (the
  // scratch-base eyeball, 2026-10-06). The rows this commit just wrote are the
  // missing map entries: read their record ids back, refresh the maps, and
  // re-send only the rows whose link columns gained values. Masters are never
  // removed (only deactivated), so a remove can never orphan a map entry
  // mid-commit. All of it — the reads and the re-sends — goes through the same
  // write-budget waiter every other Zoho call waits behind.
  if (fixupQueue.length) {
    const writtenTargets = new Map<string, { key: LinkTableKey; table: (typeof T)[string]; appIds: string[] }>()
    for (const item of fixupQueue) {
      const key = LINK_KEY_FOR[item.changeTable]
      if (!key) continue
      const entry = writtenTargets.get(item.changeTable) ?? { key, table: item.table, appIds: [] }
      entry.appIds.push(item.appId)
      writtenTargets.set(item.changeTable, entry)
    }
    for (const { key, table, appIds } of writtenTargets.values()) {
      mergeLinkRows(links, key, await zoho.fetchByKeyIn(table.id, table.appId, appIds), table)
    }
    for (const item of fixupQueue) {
      const fresh = item.spec
        ? columnsByFieldId(item.table, columnsFor(item.spec.key, item.payload, links))
        : columnsByFieldId(item.table, ledgerColumns(item.payload, links))
      const gained: Record<string, string> = {}
      for (const [fid, v] of Object.entries(fresh)) {
        if (item.values[fid] === undefined && v !== undefined) gained[fid] = v
      }
      if (!Object.keys(gained).length) continue
      try {
        await zoho.upsertByKey(
          item.table.id,
          item.table.appId,
          item.appId,
          { ...item.values, ...gained },
          item.cas ?? undefined,
        )
      } catch (e) {
        // The row moved between this commit's own write and its link fixup —
        // another instance's edit landed inside the window. The fixup is a
        // cosmetic completion (link columns that left empty), so it SKIPS: re-
        // sending the full row would overwrite the winner's content, the exact
        // destruction the conditional write exists to prevent. The links
        // complete on that row's next save.
        if (e instanceof ZohoCasConflictError) {
          console.warn(
            `[commit] ${item.changeTable} ${item.appId} moved before its link fixup — links deferred to the next save`,
          )
          continue
        }
        throw e
      }
      wrote = true
    }
  }

  // 5. counters — upsert by Series (Next is a plain column). A `period:*` value is a
  // STRING ('YYYY:2026') and Next is a NUMBER field that silently drops strings, so
  // periods travel in the Config table instead, whose Value is text — which is where
  // the snapshot reader has always looked for them.
  //
  // Next only ever moves forward. A value below what is stored is a client whose
  // counters went stale (its poll is skipped while it holds unsaved work), and
  // writing it would re-issue numbers — the one exception is a genuine period
  // reset, which arrives together with the new `period:*` value and must land.
  //
  // A period claim that is not the period the series' own pattern computes to
  // right now moves nothing — not the period row, and not the counter the reset
  // rule would have unlocked. Anything else re-issues numbers whose upserts
  // overwrite the original documents while their ledger lines dangle: a forged
  // value ('x') used to pass the mere String-inequality reset rule and rewind
  // the series, and a merely-CURRENT value ('YYYY:2026|MM:10' against a series
  // that only carries {YYYY}) slipped the clock check the first fix built — so
  // the claim is bound to the stored pattern, the same arithmetic the honest
  // client mints with. An echo of what is already stored always stays legal,
  // whatever the clock says.
  const configTable = T['Config']
  const unlocksReset = (series: string): boolean => {
    const periodKey = `period:${series}`
    const newPeriod = changes.counters[periodKey]
    return (
      newPeriod !== undefined &&
      String(newPeriod) !== (storedConfig.get(periodKey) ?? '') &&
      String(newPeriod) === expectedPeriodOf(storedConfig, series)
    )
  }
  for (const [series, value] of Object.entries(changes.counters)) {
    if (series.startsWith('period:')) {
      const stored = storedConfig.get(series)
      const claimed = String(value)
      if (stored !== undefined && stored === claimed) continue // unchanged — nothing to write
      if (claimed !== expectedPeriodOf(storedConfig, series.slice('period:'.length)))
        continue // not this series' period: forged, stale, or merely current — write nothing
      await zoho.upsertByKey(configTable.id, configTable.fields['Setting'], series, {
        [configTable.fields['Setting']]: series,
        [configTable.fields['Value']]: claimed,
      })
      wrote = true
      continue
    }
    const incoming = Number(value) || 0
    const stored = storedNext.get(series)
    if (stored !== undefined) {
      if (incoming === stored) continue // unchanged — nothing to write
      if (incoming < stored && !unlocksReset(series)) {
        continue // stale regression: the insert gate and the next sync heal it
      }
      // forward jumps within the ceiling were judged before any write landed
      // (COUNTER_JUMP_MAX, beside the other gates above)
    }
    await zoho.upsertByKey(counters.id, counters.fields['Series'], series, {
      [counters.fields['Series']]: series,
      [counters.fields['Next']]: String(value),
    })
    wrote = true
  }

  // 6. config — written only when a key genuinely moved (the gate's own verdict):
  // a client echoing the stored config back unchanged rewrites byte-for-byte what
  // is already there, which is a write spent and a revision bumped for nothing.
  const config = T['Config']
  if (changes.config && ownsConfigChange) {
    await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_config', {
      [config.fields['Setting']]: 'app_config',
      [config.fields['Value']]: JSON.stringify(changes.config),
    })
    wrote = true
  }

  // 7. revision, last — a reader sees the old plant whole or the new plant whole.
  // Nothing landed means nothing moved: the commit was an idempotent retry of the
  // caller's own writes end to end, the base still sits at the revision the
  // pre-flight read, and bumping anyway would push every device in the plant off a
  // cache that is still exactly true. The unchanged token goes back instead, and
  // the caller adopts it the same way — it is what a fresh read would return.
  if (!wrote) return { token: storedConfig.get('app_revision') ?? '0', wrote: false }
  const token = await bumpRevision(zoho, storedConfig)
  noteRevision(zoho.baseId, token)
  // Hints for the next sweep (snapshot substrate cache): the delta read cannot
  // see behind its watermark, so this commit flags what landed there — rows it
  // removed, and ledger rows written with an `at` under the watermark (PM
  // receipts backdate). Rows written at `at` = now are exactly what the bucket
  // delta finds; only the blind spots need flagging.
  const watermark = cachedLedgerWatermark(zoho.baseId)
  const backdatedLedger =
    watermark !== null &&
    changes.tables.some(
      (t) =>
        t.table === 'ledger' &&
        t.upsert.some((row) => {
          const at = (row as { at?: unknown }).at
          return typeof at === 'string' && at < watermark
        }),
    )
  noteCommitApplied(zoho.baseId, token, {
    removedTables: changes.tables.filter((t) => t.remove.length > 0).map((t) => t.table),
    backdatedLedger,
    touchedTables: changes.tables.filter((t) => t.upsert.length > 0 || t.remove.length > 0).map((t) => t.table),
  })
  // Link-memo upkeep: this commit moved the base to `token`. If it wrote a master
  // table — or seeded a vendor type, a write the client's table list cannot name —
  // the memo's maps are spent: drop them. If it did not, the maps still describe
  // the base as of `token` (our own writes changed nothing they hold), so the memo
  // rides forward and the next commit skips its nine reads.
  if (linkMemo) {
    if (seededTypes.length || changes.tables.some((t) => LINK_TABLES.has(TABLE_FOR[t.table] ?? ''))) linkMemo = null
    else linkMemo = { revision: token, maps: linkMemo.maps }
  }
  return { token, wrote: true }
}
