/**
 * StateChanges → idempotent Zoho writes.
 *
 * Every write is an upsert keyed by the row's own business key (App ID, Series,
 * Setting), which is what makes a commit safe to retry after a partial failure: the
 * second attempt re-writes the same rows rather than duplicating ledger lines — the one
 * exception is the audit trail, which is insert-only: an upsert naming an App ID that
 * already exists is skipped, so no commit (and no retry) can rewrite history. The
 * revision row is bumped last so a reader either sees the old plant whole or the new
 * plant whole. Tables gated behind a permission the caller lacks are refused here —
 * this is the RLS of the fork, and the client maps the 403 to the same 'forbidden'
 * message it always had.
 *
 * A commit is also refused, whole, before a single write lands, when any row it
 * would replace no longer matches the version the caller based their edit on
 * (`expect`, carried per row by src/lib/sync.ts). That is what makes a
 * simultaneous edit a refused save instead of a silent overwrite, and what makes
 * two devices minting the same document number a refused insert instead of one
 * receipt quietly replacing the other while both ledger lines survive.
 */
import { ZohoApiError } from './zoho.js'
import type { ZohoClient, ZohoRecord } from './zoho.js'
import type { TableRef } from './baseSchema.js'
import { T, TABLE_FOR } from './baseSchema.js'
import { columnsFor, ledgerColumns, auditColumns, buildLinkMaps } from './mappers.js'
import { COLLECTIONS } from '../../src/lib/tables.js'
import type { StateChanges } from '../../src/lib/sync.js'
import { TABLE_WRITE_PERMISSION, CONFIG_KEY_WRITE_PERMISSION, isAdminPermissions } from '../../src/lib/permissions.js'
import { pageScope } from '../../src/lib/pages.js'
import type { ViewId } from '../../src/types.js'
import type { Caller } from './auth.js'
import { cachedLedgerWatermark, noteCommitApplied, noteRevision } from './snapshot.js'

export class Forbidden extends Error {
  readonly table: string
  constructor(table: string) {
    super(`You do not have permission to change ${table.replace(/_/g, ' ')}.`)
    this.table = table
  }
}

/** One row the commit would have clobbered; the client adopts the winning version. */
export interface RowConflict {
  table: string
  id: string
  /** The caller's base no longer matches the stored row — a genuine edit race. */
  kind: 'changed'
  /** The caller is inserting a key that already exists — a minted-code collision. */
  | 'exists'
}

export class Conflict extends Error {
  readonly conflicts: RowConflict[]
  constructor(conflicts: RowConflict[]) {
    super(
      conflicts.length
        ? `Another device saved ${conflicts.map((c) => c.id).join(', ')} first.`
        : 'Another device saved these records first.',
    )
    this.conflicts = conflicts
  }
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
  return buildLinkMaps(await grab('Vendors'), await grab('Purchase Products'), await grab('Storage Locations'), await grab('Items'), {
    vendors: T['Vendors'], purchaseProducts: T['Purchase Products'], storageLocations: T['Storage Locations'], items: T['Items'],
  })
}

/**
 * The last link maps this process built, with the revision they were read at.
 *
 * A commit spends four reads on masters for column enrichment, and enrichment is
 * best-effort by contract (only App ID and Data JSON are load-bearing) — but the
 * masters only ever change through a commit, and every commit bumps the revision
 * last, so maps read at revision R are exactly what a fresh read at R would return.
 * The revision a commit already reads (the config gate below) answers whether the
 * memo still stands; a commit that itself wrote a master table drops it. Same
 * argument, same shape as the snapshot cache — and four reads back per commit.
 */
let linkMemo: { revision: string; maps: Awaited<ReturnType<typeof linkMaps>> } | null = null

/** The base tables whose rows feed link maps — a commit touching any of them spends the memo. */
const LINK_TABLES = new Set(['Vendors', 'Purchase Products', 'Storage Locations', 'Items'])

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

const jsonEq = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(a) === JSON.stringify(b)

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

export function commitChanges(zoho: ZohoClient, caller: Caller, changes: StateChanges): Promise<string> {
  const run = commitQueue.then(() => commitLocked(zoho, caller, changes))
  commitQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function commitLocked(zoho: ZohoClient, caller: Caller, changes: StateChanges): Promise<string> {
  // 1. permission gate — the RLS of this fork
  const held = new Set(caller.permissions)
  const holdsAny = (perm: string | readonly string[]) =>
    typeof perm === 'string' ? held.has(perm) : perm.some((p) => held.has(p))
  for (const change of changes.tables) {
    const spec = COLLECTIONS.find((c) => c.table === change.table)
    if (spec?.writePermission && !holdsAny(spec.writePermission)) throw new Forbidden(change.table)
  }
  // Page narrowing: a caller holding any page.* slug is scoped to those pages,
  // and the day's work stops being open — they may write only the tables whose
  // page they hold. The default caller (no page permissions, the operator) is
  // untouched; a full administrator is simply a caller holding every page. The
  // BFF is what makes this real: the UI's nav hiding a page would matter little
  // to a crafted POST without this loop.
  const pages = pageScope(caller.permissions)
  if (pages && !isAdminPermissions([...held])) {
    const holdsPage = (page: ViewId | readonly ViewId[]) =>
      typeof page === 'string' ? pages.has(page) : page.some((p) => pages.has(p))
    for (const change of changes.tables) {
      const spec = COLLECTIONS.find((c) => c.table === change.table)
      if (spec?.page && !holdsPage(spec.page)) throw new Forbidden(change.table)
    }
    // Ride-alongs: ledger lines, audit inserts and counter moves are part of a
    // document's posting, owned by no page. A scoped caller may write them only
    // alongside a collection change whose page they hold — otherwise a crafted
    // POST moves stock, resets numbering or files audit rows through the tables
    // this gate never covered, precisely the tables where integrity lives.
    const ownsCollectionChange = changes.tables.some((t) => {
      const spec = COLLECTIONS.find((c) => c.table === t.table)
      return !!spec?.page && holdsPage(spec.page) && (t.upsert?.length || t.remove?.length)
    })
    const ledgerRemove = changes.tables.some((t) => t.table === 'ledger' && !!t.remove?.length)
    const ledgerWrites = changes.tables.some(
      (t) => t.table === 'ledger' && (t.upsert?.length || t.remove?.length),
    )
    const counterWrites = Object.keys(changes.counters || {}).some((k) => !k.startsWith('period:'))
    // One honest exception: moving stock between rooms is the Storage page's own
    // job, and it posts ledger lines and an audit row while owning no collection
    // row to hang them on — so that page stands in for one. A holder may upsert
    // ledger lines with no collection change; removals and counters still need a
    // document behind them, because a move never deletes history and never mints
    // a number.
    const stockMove = ledgerWrites && !ledgerRemove && holdsPage('storage')
    if ((ledgerWrites && !ownsCollectionChange && !stockMove) || (counterWrites && !ownsCollectionChange)) {
      throw new Forbidden('ledger')
    }
  }
  // config writes and audit deletions carry their own gates: the trail is
  // insert-only for callers without the Audit page (sync.ts only ever emits
  // audit removals from admin-side edits), and config is one stored row, so its
  // gate diffs the incoming object against what is stored and judges only the
  // keys that actually changed — sync sends the whole config, and a lab tester
  // may carry the numbering series unchanged in their payload without it
  // reading as an attempt to change it. A key listed in
  // CONFIG_KEY_WRITE_PERMISSION passes on any one of its permissions (the
  // report types are the lab's own); every other key needs the Settings page.
  // No stored row means every key is new, and first-time config is the Settings
  // page's business.
  const storedConfig = await configBySetting(zoho)
  if (changes.config) {
    // app_config is in the very map the gate just read — the second Config sweep
    // this branch used to make was the same rows fetched twice per commit.
    let stored: Record<string, unknown> = {}
    try {
      stored = JSON.parse(storedConfig.get('app_config') ?? '{}') as Record<string, unknown>
    } catch {
      stored = {}
    }
    // The union of keys, not just the payload's: a key the payload drops is a
    // change too (a partial payload must not read as "leave the rest alone" —
    // the write replaces the whole row, so it would wipe what it omits).
    for (const key of new Set([...Object.keys(changes.config), ...Object.keys(stored)])) {
      if (JSON.stringify(stored[key]) === JSON.stringify(changes.config[key])) continue
      const gate =
        (CONFIG_KEY_WRITE_PERMISSION as Record<string, readonly string[] | undefined>)[key] ??
        [TABLE_WRITE_PERMISSION.app_config]
      if (!gate.some((p) => held.has(p))) throw new Forbidden(`app_config ${key}`)
    }
  }
  const auditRemove = changes.tables.some((t) => t.table === 'audits' && t.remove?.length)
  if (auditRemove && !held.has(TABLE_WRITE_PERMISSION.audits)) throw new Forbidden('audits')

  // 2. link maps for column enrichment — memoized per revision (see linkMemo):
  // four reads for the first commit after anything changed, none behind it.
  const links = await linkMapsCached(zoho, storedConfig.get('app_revision') ?? '0')

  // 3. pre-flight: read every touched row once, by key, and refuse the whole
  // commit if any row moved under the caller. All-or-nothing happens here,
  // before a single write, so a refused race never leaves half a posting.
  const conflicts: RowConflict[] = []
  const existingByTable = new Map<string, Map<string, ZohoRecord>>()
  for (const change of changes.tables) {
    const base = TABLE_FOR[change.table]
    if (!base) throw new Error(`unknown table ${change.table}`)
    const table = T[base]
    const spec = COLLECTIONS.find((c) => c.table === change.table) ?? null

    const ids = [
      ...change.upsert.map((row) => String(row.id)),
      ...change.remove.map((id) => String(id)),
    ]
    const rows = await zoho.fetchByKeyIn(table.id, table.appId, ids)
    const byApp = new Map(rows.map((r) => [String(r.data[table.appId] ?? ''), r]))
    existingByTable.set(change.table, byApp)
    if (change.table === 'audits') continue // insert-only: existence is checked at write time

    for (const row of change.upsert) {
      const appId = String(row.id)
      const stored = byApp.get(appId)
      if (!stored) continue
      const storedDoc = storedPayload(table, stored)
      if (!storedDoc) continue
      const incoming = spec ? ((row as { data: Record<string, unknown> }).data ?? {}) : row
      if (jsonEq(storedDoc, incoming)) continue // a retry of our own write — skipped below, never a conflict
      const expected = change.expect?.[appId]
      if (expected) {
        const expectedDoc = spec ? ((expected as { data: Record<string, unknown> }).data ?? {}) : expected
        if (!jsonEq(storedDoc, expectedDoc)) conflicts.push({ table: change.table, id: appId, kind: 'changed' })
      } else {
        // the caller never saw this row, yet it exists with different content:
        // either a minted code landed on another device's document, or a null-base
        // push would replace live work — both refused
        conflicts.push({ table: change.table, id: appId, kind: 'exists' })
      }
    }
  }
  if (conflicts.length) throw new Conflict(conflicts)

  // 4. collection rows — { id, data } upserts; ledger and audits arrive flat. Audits are
  // the one insert-only table: an upsert naming an existing id is SKIPPED — a
  // crafted commit cannot rewrite history, and a retried commit re-posting its own
  // audit rows is a no-op for them (new ids still write normally). Audit actors
  // are stamped from the authenticated caller; the payload's claim about who did
  // it is not evidence.
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
      const stamped = change.table === 'audits' ? { ...row, actor: caller.email } : row
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
      await zoho.upsertByKey(table.id, table.appId, appId, values)
    }

    for (const id of change.remove) {
      const rid = byApp.get(String(id))?.recordID
      // An id with no row is already gone — the outcome the caller asked for.
      if (!rid) continue
      try {
        await zoho.deleteRecord(table.id, rid)
      } catch (e) {
        // The row stood at pre-flight yet the delete still came back refused:
        // something outside this process — another instance, a hand edit —
        // removed it inside our window. With commits serialized here that cannot
        // have been a sibling commit, and the outcome the caller asked for (the
        // row gone) is already true, so the commit completes. Anything that is
        // not an API refusal — a lock, a network fault — is an honest failure
        // and still throws.
        if (!(e instanceof ZohoApiError)) throw e
        console.warn(`[commit] ${change.table} ${id} vanished before its delete landed — skipped`)
      }
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
  const counters = T['Counters']
  const configTable = T['Config']
  const seriesKeys = Object.keys(changes.counters).filter((k) => !k.startsWith('period:'))
  const storedNext = new Map<string, number>()
  if (seriesKeys.length) {
    const rows = await zoho.fetchByKeyIn(counters.id, counters.fields['Series'], seriesKeys)
    for (const r of rows) {
      const series = String(r.data[counters.fields['Series']] ?? '')
      if (series) storedNext.set(series, Number(r.data[counters.fields['Next']]) || 0)
    }
  }
  for (const [series, value] of Object.entries(changes.counters)) {
    if (series.startsWith('period:')) {
      await zoho.upsertByKey(configTable.id, configTable.fields['Setting'], series, {
        [configTable.fields['Setting']]: series,
        [configTable.fields['Value']]: String(value),
      })
      continue
    }
    const incoming = Number(value) || 0
    const stored = storedNext.get(series)
    if (stored !== undefined) {
      if (incoming === stored) continue // unchanged — nothing to write
      if (incoming < stored) {
        const periodKey = `period:${series}`
        const newPeriod = changes.counters[periodKey]
        const periodReset =
          newPeriod !== undefined && String(newPeriod) !== (storedConfig.get(periodKey) ?? '')
        if (!periodReset) continue // stale regression: the insert gate and the next sync heal it
      }
    }
    await zoho.upsertByKey(counters.id, counters.fields['Series'], series, {
      [counters.fields['Series']]: series,
      [counters.fields['Next']]: String(value),
    })
  }

  // 6. config
  const config = T['Config']
  if (changes.config) {
    await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_config', {
      [config.fields['Setting']]: 'app_config',
      [config.fields['Value']]: JSON.stringify(changes.config),
    })
  }

  // 7. revision, last — a reader sees the old plant whole or the new plant whole
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
  // table the memo's maps are spent — drop them. If it did not, the maps still
  // describe the base as of `token` (our own writes changed nothing they hold),
  // so the memo rides forward and the next commit skips its four reads.
  if (linkMemo) {
    if (changes.tables.some((t) => LINK_TABLES.has(TABLE_FOR[t.table] ?? ''))) linkMemo = null
    else linkMemo = { revision: token, maps: linkMemo.maps }
  }
  return token
}
