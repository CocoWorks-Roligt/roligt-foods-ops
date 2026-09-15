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

import {
  AUDIT_TABLE,
  COLLECTIONS,
  LEDGER_TABLE,
  auditToRow,
  ledgerToRow,
  type CollectionSpec,
} from './tables'
import type { AppState } from '../types'

export interface TableChange {
  table: string
  /** Rows to insert or replace, already in database shape. */
  upsert: Record<string, unknown>[]
  /** Primary keys to delete. */
  remove: string[]
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
): { upsert: Record<string, unknown>[]; remove: string[] } {
  const before = new Map<string, T>()
  for (const row of prev || []) before.set(idOf(row), row)

  const upsert: Record<string, unknown>[] = []
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
    if (JSON.stringify(was) !== JSON.stringify(row)) upsert.push(toRow(row))
  }

  const remove: string[] = []
  for (const id of before.keys()) if (!seen.has(id)) remove.push(id)

  return { upsert, remove }
}

const asRow = (spec: CollectionSpec) => (row: Record<string, unknown>) => ({
  id: spec.id(row),
  data: row,
})

/**
 * Everything that has to reach the database for `next` to be what it holds.
 *
 * A `prev` of null means this client has no idea what is up there — after working
 * offline, say — and everything is written. That is safe because every write is an
 * upsert keyed by the document's own code.
 */
export function diffState(prev: AppState | null, next: AppState): StateChanges {
  const tables: TableChange[] = []

  for (const spec of COLLECTIONS) {
    const { upsert, remove } = diffRows(
      prev?.[spec.key] as unknown as Record<string, unknown>[] | undefined,
      next[spec.key] as unknown as Record<string, unknown>[],
      spec.id,
      asRow(spec),
      spec.immutable,
    )
    if (upsert.length || remove.length) tables.push({ table: spec.table, upsert, remove })
  }

  const ledger = diffRows(prev?.ledger, next.ledger, (l) => l.id, ledgerToRow, true)
  if (ledger.upsert.length || ledger.remove.length) {
    tables.push({ table: LEDGER_TABLE, ...ledger })
  }

  // The trail is insert-only in the database. Removals only ever arrive from an
  // administrator clearing records from a date, which has its own policy.
  const audits = diffRows(prev?.audits, next.audits, (a) => String(a.id), auditToRow, true)
  if (audits.upsert.length || audits.remove.length) {
    tables.push({ table: AUDIT_TABLE, ...audits })
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

/** How many rows a set of changes touches. For the "still saving" indicator. */
export const changeSize = (changes: StateChanges) =>
  changes.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0) +
  Object.keys(changes.counters).length +
  (changes.config ? 1 : 0)
