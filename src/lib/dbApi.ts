import { supabase } from './supabaseClient'
import { diffState, type StateChanges } from './sync'
import {
  AUDIT_TABLE,
  COLLECTIONS,
  CONFIG_TABLE,
  COUNTER_TABLE,
  LEDGER_TABLE,
  REVISION_TABLE,
  auditFromRow,
  ledgerFromRow,
} from './tables'
import type { AppState } from '../types'

/**
 * Reading and writing the plant.
 *
 * Every document is a row in its own table now. A save works out what actually
 * changed and writes only that, which is what stops two operators overwriting each
 * other: posting two different receipts touches two different rows, and they no
 * longer meet at all.
 *
 * Rows come back in pages because Supabase caps a select at a thousand by default,
 * and a plant that has been running for a year has far more ledger lines than that —
 * silently receiving the first thousand would have shown an inventory that was simply
 * wrong.
 */

const PAGE = 1000

async function fetchAll(table: string, columns = '*'): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`)
    const rows = (data as unknown as Record<string, unknown>[]) || []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** The number the database bumps on every write. Cheap to poll; see `AppContext`. */
export async function fetchRevision(): Promise<number> {
  const { data, error } = await supabase
    .from(REVISION_TABLE)
    .select('rev')
    .eq('id', 'main')
    .maybeSingle()
  if (error) throw new Error(`Failed to read revision: ${error.message}`)
  return Number(data?.rev) || 0
}

export interface DbSnapshot {
  /** Null when the database has never been written to. */
  state: Partial<AppState> | null
  revision: number
}

/**
 * Everything, assembled back into the shape the rest of the app already speaks.
 *
 * The tables are read in parallel — they are independent, and doing them one after
 * another turned a cold start into a visible wait.
 */
export async function fetchDb(): Promise<DbSnapshot> {
  const revision = await fetchRevision()

  const [collections, ledgerRows, auditRows, counterRows, configRow] = await Promise.all([
    Promise.all(COLLECTIONS.map((c) => fetchAll(c.table, 'id, data'))),
    fetchAll(LEDGER_TABLE),
    fetchAll(AUDIT_TABLE),
    fetchAll(COUNTER_TABLE),
    supabase.from(CONFIG_TABLE).select('data').eq('id', 'main').maybeSingle(),
  ])

  const state: Partial<AppState> = {}
  COLLECTIONS.forEach((spec, i) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(state as any)[spec.key] = collections[i].map((r) => r.data)
  })

  state.ledger = ledgerRows.map(ledgerFromRow)
  // Newest first, which is the order the audit screen reads in and the order the
  // in-memory list has always been kept in.
  state.audits = auditRows.map(auditFromRow).sort((a, b) => b.time.localeCompare(a.time))

  const counters: Record<string, number> = {}
  const counterPeriods: Record<string, string> = {}
  for (const row of counterRows) {
    const key = String(row.key)
    if (key.startsWith('period:')) counterPeriods[key.slice(7)] = String(row.value)
    else counters[key] = Number(row.value) || 0
  }
  if (Object.keys(counters).length) {
    state.counters = counters as unknown as AppState['counters']
  }
  if (Object.keys(counterPeriods).length) state.counterPeriods = counterPeriods

  if (configRow.data?.data) state.config = configRow.data.data as AppState['config']

  const everWritten =
    revision > 0 ||
    state.ledger.length > 0 ||
    COLLECTIONS.some((spec) => ((state[spec.key] as unknown[]) || []).length > 0)

  return { state: everWritten ? state : null, revision }
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'forbidden'; message: string }
  | { ok: false; reason: 'error'; message: string }

/**
 * Writes what changed between `prev` and `next`.
 *
 * `prev` is the last state this client knows the database holds. A null means it has
 * no idea — a first run, or a reconnection after working offline — and everything is
 * written; that is safe because every write is an upsert keyed by the document's own
 * code, so re-sending a receipt that is already up there changes nothing.
 *
 * A refusal from row-level security comes back as `forbidden` rather than a generic
 * failure, because it means something quite specific: an operator has reached a screen
 * that edits a master. The database is the thing enforcing that, not the UI.
 */
export async function saveDb(next: AppState, prev: AppState | null): Promise<SaveResult> {
  const changes: StateChanges = diffState(prev, next)
  if (changes.empty) return { ok: true, revision: await fetchRevision() }

  for (const change of changes.tables) {
    if (change.upsert.length) {
      // Chunked: a batch reversal can re-post thousands of ledger lines at once, and
      // one statement that large is refused by the API rather than merely slow.
      for (let i = 0; i < change.upsert.length; i += 500) {
        const { error } = await supabase
          .from(change.table)
          .upsert(change.upsert.slice(i, i + 500))
        if (error) return failure(error, change.table)
      }
    }
    if (change.remove.length) {
      for (let i = 0; i < change.remove.length; i += 500) {
        const { error } = await supabase
          .from(change.table)
          .delete()
          .in('id', change.remove.slice(i, i + 500))
        if (error) return failure(error, change.table)
      }
    }
  }

  const counterKeys = Object.entries(changes.counters)
  if (counterKeys.length) {
    const { error } = await supabase
      .from(COUNTER_TABLE)
      .upsert(counterKeys.map(([key, value]) => ({ key, value: String(value) })))
    if (error) return failure(error, COUNTER_TABLE)
  }

  if (changes.config) {
    const { error } = await supabase
      .from(CONFIG_TABLE)
      .upsert({ id: 'main', data: changes.config })
    if (error) return failure(error, CONFIG_TABLE)
  }

  return { ok: true, revision: await fetchRevision() }
}

/** Postgres says 42501 for a row-level-security refusal. */
function failure(error: { code?: string; message: string }, table: string): SaveResult {
  if (error.code === '42501') {
    return {
      ok: false,
      reason: 'forbidden',
      message: `You do not have permission to change ${table.replace(/_/g, ' ')}.`,
    }
  }
  return { ok: false, reason: 'error', message: `${table}: ${error.message}` }
}
