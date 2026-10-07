/**
 * Working out what actually changed.
 *
 * Every operation in this app still edits one in-memory `AppState` and hands back a
 * new one — that model is good, it is what makes the posting rules pure and testable,
 * and none of it changed in the move to real tables. What changed is what happens
 * next: instead of writing the whole plant back over itself, the new state is compared
 * with the last one the database is known to hold, and only the rows that differ are
 * written.
 *
 * That is the difference between two operators overwriting each other's mornings and
 * two operators posting two receipts.
 */

// Extension is explicit: this file is also compiled by the nodenext api build (the
// BFF's commit writer imports its StateChanges type), where extensionless imports
// do not resolve. And the extension is .js, not .ts: a value import spelled .ts
// needs allowImportingTsExtensions, which the deploy-time function build's own
// compiler options do not carry — .js resolves under bundler and nodenext alike.
import {
  AUDIT_TABLE,
  COLLECTIONS,
  LEDGER_TABLE,
  auditToRow,
  ledgerToRow,
  type CollectionSpec,
} from './tables.js'
import type { AppState } from '../types.ts'

export interface TableChange {
  table: string
  /** Rows to insert or replace, already in database shape. */
  upsert: Record<string, unknown>[]
  /** Primary keys to delete. */
  remove: string[]
  /**
   * The base version of each upserted row, keyed by its id — the precondition
   * that makes a commit safe to race. The BFF refuses an upsert whose stored row
   * no longer matches this (another device saved first), so a document can never
   * be silently replaced and a minted code can never land on somebody else's
   * row. Absent for rows the client never saw (inserts) and for a null-base
   * push, where the server applies the weaker insert rule instead.
   */
  expect?: Record<string, Record<string, unknown> | null>
}

export interface StateChanges {
  tables: TableChange[]
  /** Counter values that moved, as `{ key: value }`. */
  counters: Record<string, number | string>
  /** Present when the configuration itself changed. */
  config?: Record<string, unknown>
  /** Nothing to write. */
  empty: boolean
}

/**
 * Rows to write for one collection.
 *
 * `immutable` collections — the ledger, the audit trail, sticker print history — are
 * compared by identity alone. Nothing ever edits a line that has already been written;
 * documents reverse and re-post, which shows up as a removal and an insertion. Skipping
 * the content comparison keeps a save cheap as the ledger grows into six figures.
 */
export function diffRows<T>(
  prev: T[] | undefined,
  next: T[] | undefined,
  idOf: (row: T) => string,
  toRow: (row: T) => Record<string, unknown>,
  immutable = false,
): {
  upsert: Record<string, unknown>[]
  remove: string[]
  expect: Record<string, Record<string, unknown>>
} {
  const before = new Map<string, T>()
  for (const row of prev || []) before.set(idOf(row), row)

  const upsert: Record<string, unknown>[] = []
  const expect: Record<string, Record<string, unknown>> = {}
  const seen = new Set<string>()

  for (const row of next || []) {
    const id = idOf(row)
    seen.add(id)
    const was = before.get(id)
    if (!was) {
      upsert.push(toRow(row))
      continue
    }
    if (immutable) continue
    if (JSON.stringify(was) !== JSON.stringify(row)) {
      upsert.push(toRow(row))
      // the row as the client's base held it — what the server must still find
      // in place before this write may land
      expect[id] = toRow(was)
    }
  }

  const remove: string[] = []
  for (const id of before.keys()) if (!seen.has(id)) remove.push(id)

  return { upsert, remove, expect }
}

const asRow = (spec: CollectionSpec) => (row: Record<string, unknown>) => ({
  id: spec.id(row),
  data: row,
})

const hasKeys = (o: Record<string, unknown>) => Object.keys(o).length > 0

/**
 * Everything that has to reach the database for `next` to be what it holds.
 *
 * `prev` must be the base this client's copy was actually built from — never a
 * fresher server state. Rows present in `prev` but absent from `next` are the
 * removals, so a `prev` that contains rows the client never saw (a fresh server
 * snapshot) would delete every one of them on the next save. A `prev` of null
 * means this client has no idea what is up there: everything is written as an
 * upsert keyed by the document's own code and nothing is removed — the safe
 * direction to be wrong in.
 */
export function diffState(prev: AppState | null, next: AppState): StateChanges {
  const tables: TableChange[] = []

  for (const spec of COLLECTIONS) {
    const { upsert, remove, expect } = diffRows(
      prev?.[spec.key] as unknown as Record<string, unknown>[] | undefined,
      next[spec.key] as unknown as Record<string, unknown>[],
      spec.id,
      asRow(spec),
      spec.immutable,
    )
    if (upsert.length || remove.length) {
      tables.push({ table: spec.table, upsert, remove, ...(hasKeys(expect) ? { expect } : {}) })
    }
  }

  const ledger = diffRows(prev?.ledger, next.ledger, (l) => l.id, ledgerToRow, true)
  if (ledger.upsert.length || ledger.remove.length) {
    // immutable inserts carry no expectation: a ledger line is only ever new
    tables.push({ table: LEDGER_TABLE, upsert: ledger.upsert, remove: ledger.remove })
  }

  // The trail is insert-only in the database. Removals only ever arrive from an
  // administrator clearing records from a date, which has its own policy.
  const audits = diffRows(prev?.audits, next.audits, (a) => String(a.id), auditToRow, true)
  if (audits.upsert.length || audits.remove.length) {
    tables.push({ table: AUDIT_TABLE, upsert: audits.upsert, remove: audits.remove })
  }

  const counters: Record<string, number | string> = {}
  for (const [key, value] of Object.entries(next.counters || {})) {
    if ((prev?.counters as Record<string, unknown> | undefined)?.[key] !== value) {
      counters[key] = value as number
    }
  }
  // The period a counter belongs to travels with it — a series that resets each year
  // has to know which year the number it is holding was issued in.
  for (const [key, value] of Object.entries(next.counterPeriods || {})) {
    if (prev?.counterPeriods?.[key] !== value) counters[`period:${key}`] = value
  }

  const configChanged = JSON.stringify(prev?.config) !== JSON.stringify(next.config)

  return {
    tables,
    counters,
    config: configChanged ? (next.config as unknown as Record<string, unknown>) : undefined,
    empty: !tables.length && !Object.keys(counters).length && !configChanged,
  }
}

/** Row ids by state key — the collections, plus the ledger and audit trail. */
const ROW_IDS: Record<string, (row: unknown) => string> = (() => {
  const map: Record<string, (row: unknown) => string> = {
    ledger: (l) => (l as { id: string }).id,
    audits: (a) => String((a as { id: unknown }).id),
  }
  for (const spec of COLLECTIONS) map[spec.key] = (row) => spec.id(row as Record<string, unknown>)
  return map
})()

const sameValue = (a: unknown, b: unknown) =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b))

/** One keyed collection, merged three ways: live's changes against `base` win;
 *  everything else takes `source`, including its absence. */
function mergeRows(
  key: string,
  live: unknown[] | undefined,
  base: unknown[] | undefined,
  source: unknown[] | undefined,
): unknown[] {
  const idOf = ROW_IDS[key] ?? ((r: unknown) => String((r as { id?: unknown })?.id ?? ''))
  const toMap = (rows: unknown[] | undefined) => {
    const m = new Map<string, unknown>()
    for (const r of rows || []) m.set(idOf(r), r)
    return m
  }
  const liveRows = toMap(live)
  const baseRows = toMap(base)
  const srcRows = toMap(source)

  const out: unknown[] = []
  // Live order first. A row this device deleted simply does not appear here,
  // and the base row it deleted must keep the server's copy out too — the
  // append below refuses any id the base holds.
  const seen = new Set<string>()
  for (const [id, lr] of liveRows) {
    seen.add(id)
    const br = baseRows.get(id)
    if (br === undefined || !sameValue(lr, br)) {
      out.push(lr) // edited here, or added here — the pending push settles it
      continue
    }
    const sr = srcRows.get(id)
    if (sr !== undefined) out.push(sr) // untouched: the server's version, whatever it now says
    // else: the server dropped an untouched row — a colleague's deletion arriving
  }
  // Rows only the server has: a posting this device has never seen. Ids in the
  // base are refused — those are this device's deletions, not news.
  for (const [id, sr] of srcRows) if (!seen.has(id) && !baseRows.has(id)) out.push(sr)
  return out
}

/**
 * Installs a server view over the live state without erasing live work.
 *
 * Every snapshot install — boot reconcile, poll, conflict adoption — used to
 * hand React a ready-made state, and React would replace whatever the operator
 * had queued while the read was in flight: an edit landing inside that window
 * was silently discarded and the state then read as clean. This is the three-way
 * merge that replaces the wholesale swap. Rows the live copy has moved off
 * `base` (edited, added, deleted) keep the live version — the pending push will
 * settle them against the server — while everything the live copy has not
 * touched takes `source`, *including its absence*, so a colleague's deletion
 * still arrives. Rows new on the server are appended. Scalars (config,
 * counters, periods) take the server's value unless live moved them.
 *
 * `base` is what the live copy was built from: the boot mirror at reconcile,
 * the last synced state in the poll. A null base makes every live row count as
 * locally changed — the same safe direction as the null-base push, nothing the
 * operator holds is dropped and nothing is removed.
 */
export function installOver(live: AppState, base: AppState | null, source: AppState): AppState {
  const liveRec = live as unknown as Record<string, unknown>
  const baseRec = (base ?? {}) as unknown as Record<string, unknown>
  const srcRec = source as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(liveRec), ...Object.keys(srcRec)])) {
    const lv = liveRec[key]
    const sv = srcRec[key]
    if (Array.isArray(lv) || Array.isArray(sv)) {
      out[key] = mergeRows(
        key,
        lv as unknown[] | undefined,
        baseRec[key] as unknown[] | undefined,
        sv as unknown[] | undefined,
      )
    } else {
      out[key] = sameValue(lv, baseRec[key]) ? sv : lv
    }
  }
  return out as unknown as AppState
}

/**
 * Puts back the tables a partial snapshot withheld, BEFORE anything downstream
 * looks at the state.
 *
 * The BFF projects each caller's snapshot to the pages they hold and names the
 * dropped keys in `withheld` (the write gates' read-side mirror). To the client,
 * an absent key is not "this table is none of my business" — migrateState would
 * seed it as never-written and installOver would treat it as "the server dropped
 * every untouched row", so the next save would emit removes for the whole table
 * or a storm of 'exists' conflicts. The restore bridges that: each withheld key
 * that the partial state is missing takes `from`'s value — this device's last
 * full view, which stays because the server was never asked about it. A key the
 * partial state DOES carry always keeps the fresh server value.
 *
 * Runs on the RAW remote state, ahead of migrateState: the migrate passes are
 * cross-key (melanges fold into items, ledger locations into storage
 * locations), so restoring after them would leave them looking at half a table.
 * A null state, an empty list and a null `from` all pass through untouched —
 * first boot has nothing to restore and nothing to lose.
 */
export function restoreWithheld(
  partial: { state: Partial<AppState> | null; revision: string; withheld?: string[] },
  from: AppState | null,
): { state: Partial<AppState> | null; revision: string } {
  if (!partial.state || !partial.withheld?.length || !from) return partial
  const src = from as unknown as Record<string, unknown>
  const state: Record<string, unknown> = { ...(partial.state as unknown as Record<string, unknown>) }
  for (const key of partial.withheld) {
    if (state[key] === undefined && src[key] !== undefined) state[key] = src[key]
  }
  return { state: state as Partial<AppState>, revision: partial.revision }
}

/** How many rows a set of changes touches. For the "still saving" indicator. */
export const changeSize = (changes: StateChanges) =>
  changes.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0) +
  Object.keys(changes.counters).length +
  (changes.config ? 1 : 0)

/** The AppState key a table name lives under ('grns' → grns; ledger/audits are theirs). */
function stateKeyForTable(table: string): string | null {
  if (table === 'ledger' || table === 'audits') return table
  return COLLECTIONS.find((c) => c.table === table)?.key ?? null
}

const idOfFor = (key: string) => {
  if (key === 'ledger' || key === 'audits') return (r: unknown) => String((r as { id?: unknown }).id ?? '')
  const spec = COLLECTIONS.find((c) => c.key === key)
  return (r: unknown) =>
    spec ? spec.id(r as Record<string, unknown>) : String((r as { id?: unknown }).id ?? '')
}

/**
 * Adopts the server's version of documents that lost a save race.
 *
 * A refused row never arrives alone: a document carries its ledger lines and
 * audit entries under its own code, and surrendering the row while still
 * pushing our lines for it would corrupt the winner's stock. So the whole
 * slice — the row, its lines, its entries — is taken from the server on both
 * sides of the diff (the state and the base it is diffed against), which makes
 * the re-save a no-op for the surrendered document and a clean push for
 * everything else this device did.
 *
 * Counters are the one field where taking the server's value wholesale was a
 * bug, not a courtesy: a device that minted offline past the server's counter
 * (it holds 7, the server says 6) has surviving unconflicted rows carrying
 * those numbers, and adopting 6 made its next mint 6+1 = "GRN-7" AGAIN — two
 * receipts sharing one id, the second edit of which rides an expect that
 * matches the first and overwrites it, no 409 ever fired. So the live state
 * takes the per-key max, keeping every number a surviving local row carries;
 * the base is adopted with `counters: 'server'` so the diff re-emits the
 * counter move and the server catches up on the re-save. Period strings stay
 * server-wins — the server is their judge.
 */
export function adoptServerRows(
  cur: AppState,
  server: Partial<AppState>,
  conflicts: ReadonlyArray<{ table: string; id: string; kind: string }>,
  opts: { counters?: 'max' | 'server' } = {},
): AppState {
  const touched = new Map<string, Set<string>>()
  const mark = (key: string, id: string) => {
    const ids = touched.get(key) ?? new Set<string>()
    ids.add(id)
    touched.set(key, ids)
  }
  for (const c of conflicts) {
    const key = stateKeyForTable(c.table)
    if (!key) continue
    mark(key, c.id)
    if (c.table !== 'ledger' && c.table !== 'audits') {
      for (const l of cur.ledger ?? []) if (l.doc === c.id) mark('ledger', l.id)
      for (const a of cur.audits ?? []) if (a.doc === c.id) mark('audits', String(a.id))
      for (const l of server.ledger ?? []) if (l.doc === c.id) mark('ledger', l.id)
      for (const a of server.audits ?? []) if (a.doc === c.id) mark('audits', String(a.id))
    }
  }
  const next: Record<string, unknown> = { ...(cur as unknown as Record<string, unknown>) }
  for (const [key, ids] of touched) {
    const idOf = idOfFor(key)
    const fromServer = ((server as Record<string, unknown>)[key] as unknown[] | undefined) ?? []
    const winners = fromServer.filter((r) => ids.has(idOf(r)))
    const ours = ((next[key] as unknown[] | undefined) ?? []).filter((r) => !ids.has(idOf(r)))
    next[key] = [...ours, ...winners]
  }
  if (server.counters) {
    const merged = { ...(next.counters as Record<string, unknown>) }
    for (const [key, value] of Object.entries(server.counters)) {
      merged[key] =
        opts.counters !== 'server' && typeof value === 'number' && typeof merged[key] === 'number'
          ? Math.max(merged[key] as number, value)
          : value
    }
    next.counters = merged
  }
  if (server.counterPeriods) {
    next.counterPeriods = { ...(next.counterPeriods as object), ...server.counterPeriods }
  }
  return next as unknown as AppState
}

/** What `offlineBootBase` needs from the device's mirror, already migrated. */
export interface BootBase {
  /** True while the mirror holds changes the database has not accepted. */
  dirty: boolean
  /** A clean mirror is a known-server state only when a revision was recorded with it. */
  hasRevision: boolean
  /** The recorded diff base — present only while dirty, lost on a quota spill. */
  base: AppState | null
  /** The mirror state itself. */
  mirror: AppState | null
}

/**
 * The diff base for a boot that could not reach the server.
 *
 * Null was the only answer here once, and null made every edit of an EXISTING
 * row a guaranteed loss at reconnect: the null-base push writes each row as a
 * bare insert, the server finds the row stored and differing, and answers
 * 409 'exists' even though nobody else touched it — the operator's correction
 * is adopted away with "re-enter your changes" for winning nothing. But a
 * device that has synced before always holds a legitimate view: a clean mirror
 * IS what the server stood at when its revision was recorded, and a dirty
 * mirror carries the base it was diffed against when the work was done. Either
 * is an honest expect-basis; only a mirror with neither (first run, quota
 * spill) falls back to null — the safe direction to be wrong in.
 */
export function offlineBootBase(local: BootBase | null): AppState | null {
  if (!local) return null
  if (local.dirty) return local.base
  return local.hasRevision ? local.mirror : null
}
