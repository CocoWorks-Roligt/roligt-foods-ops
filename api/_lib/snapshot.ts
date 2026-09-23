/**
 * Reads the base back into the app's own snapshot shape. Reads only ever use
 * App ID + Data JSON, so the fork's read path is byte-for-byte the contract the
 * Supabase client had (id, data) — `migrateState` fills any collection not yet
 * mapped from seed defaults, which is what lets the GRN slice ship before the rest.
 */
import type { ZohoClient, ZohoRecord } from './zoho.ts'
import { T, TABLE_FOR } from './baseSchema.ts'
import { rowToDoc } from './mappers.ts'
import { COLLECTIONS, ledgerFromRow, auditFromRow } from '../../src/lib/tables.ts'
import type { AppState } from '../../src/types.ts'

export interface Assembled {
  state: Partial<AppState> | null
  revision: number
  everWritten: boolean
}

export type SnapshotRows = Record<string, ZohoRecord[]>

/** AppState is keyed by collection KEY (vendorTypes), not table name (vendor_types). */
function stateKeyFor(supa: string): string | null {
  if (supa === 'ledger' || supa === 'audits') return supa
  return COLLECTIONS.find((c) => c.table === supa)?.key ?? null
}

export function assembleState(schema: typeof T, rows: SnapshotRows): Assembled {
  const state: Partial<AppState> = {}
  // collections — including ledger and audits, whose Data JSON already holds the
  // document in its final shape — all read the same way
  for (const [supa, base] of Object.entries(TABLE_FOR)) {
    const table = schema[base]
    const key = stateKeyFor(supa)
    if (!table?.dataJson || !rows[supa] || !key) continue
    // A table read back with ZERO rows was deliberately emptied — emit [] so
    // `migrateState` cannot refill it from seed. Rows that exist but parse to no
    // documents (staged in the base without Data JSON) are a different thing: the
    // collection has never been written, so the key stays absent and seeding runs.
    const wiped = rows[supa].length === 0
    // Ledger and audits are stored in their FLAT row shapes (ledgerToRow/auditToRow —
    // qty_in, item_type, actor, at), so they decode through the same fromRow mappers
    // the Supabase client used; the generic doc decoder would leave qtyIn/itemType
    // undefined and a posted receipt would never show as stock.
    const fromRow = supa === 'ledger' ? ledgerFromRow : supa === 'audits' ? auditFromRow : null
    const docs = wiped
      ? []
      : rows[supa]
          .map((r) => {
            const raw = rowToDoc(table, r)
            if (!raw) return null
            return fromRow ? fromRow(raw) : raw
          })
          .filter((d): d is Record<string, unknown> => d !== null)
    if (wiped || docs.length) (state as Record<string, unknown>)[key] = docs
  }
  // audit reads newest-first, the order the in-memory list has always been kept in
  if (state.audits) state.audits = [...state.audits].sort((a, b) => b.time.localeCompare(a.time))

  const counters: Record<string, number> = {}
  const counterPeriods: Record<string, string> = {}
  const cnt = schema['Counters']
  for (const r of rows.counters ?? []) {
    const key = String(r.data[cnt.fields['Series']] ?? '')
    const value = String(r.data[cnt.fields['Next']] ?? '')
    if (!key) continue
    // Periods live in Config (text Value); a period row here is remnant corruption
    // whose number field dropped the string — reading it would hand nextId an empty
    // period and reset the running number on every boot.
    if (key.startsWith('period:')) continue
    counters[key] = Number(value) || 0
  }
  if (Object.keys(counters).length) state.counters = counters as unknown as AppState['counters']

  let revision = 0
  const cfg = schema['Config']
  for (const r of rows.config ?? []) {
    const setting = String(r.data[cfg.fields['Setting']] ?? '')
    const value = String(r.data[cfg.fields['Value']] ?? '')
    if (setting === 'app_revision') revision = Number(value) || 0
    if (setting === 'app_config' && value) {
      try { state.config = JSON.parse(value) as AppState['config'] } catch { /* leave unset */ }
    }
    if (setting.startsWith('period:')) counterPeriods[setting.slice(7)] = value
  }
  // Assigned here, after the Config loop — periods are read from Config, which runs
  // after the Counters pass that builds the shared object.
  if (Object.keys(counterPeriods).length) state.counterPeriods = counterPeriods

  // Collections are checked by their STATE key — the same test the Supabase client ran.
  const everWritten =
    revision > 0 ||
    (state.ledger?.length ?? 0) > 0 ||
    COLLECTIONS.some((c) => ((state as Record<string, unknown>)[c.key] as unknown[] | undefined)?.length)

  return { state: everWritten ? state : null, revision, everWritten }
}

/** Reads every mapped table (App ID + Data JSON only) and assembles the snapshot. */
export async function readSnapshot(zoho: ZohoClient): Promise<Assembled> {
  const schema = T
  const rows: SnapshotRows = {}
  await Promise.all(
    Object.entries(TABLE_FOR).map(async ([supa, base]) => {
      const table = schema[base]
      // order_lines and anything else not in COLLECTIONS is fetched-then-discarded
      // otherwise — a read budget is spent for rows the state can never hold.
      if (!table || !stateKeyFor(supa)) return
      rows[supa] = await zoho.fetchAll(table.id)
    }),
  )
  rows.counters = await zoho.fetchAll(schema['Counters'].id)
  rows.config = await zoho.fetchAll(schema['Config'].id)
  return assembleState(schema, rows)
}

/**
 * The last snapshot assembled, keyed by the revision it was read at.
 *
 * A sweep is 26 read calls — one per table — against the client's budget of 26
 * reads a minute, so a reload that re-swept spent a full minute waiting for the
 * budget window to slide before it could even start. But nothing in the base
 * changes except through a commit, and every commit bumps the revision row last,
 * so a snapshot read at revision R is exactly what a fresh sweep at R would
 * return. One revision read answers whether the cache still stands.
 *
 * The sweep reads 26 tables one after another, so a commit landing mid-sweep can
 * be read torn and stamped with the new revision — the same exposure a single
 * uncached read has always had, healed by the next commit. Per process: the dev
 * harness is one process, a warm serverless instance is one, and each gates on
 * its own revision read, so nothing needs coordinating between them.
 */
let cached: { baseId: string; revision: number; snap: Assembled } | null = null
/** The sweep in flight, shared by every caller asking while it runs. */
let sweeping: Promise<Assembled> | null = null

/** The base changed by ways this process did not watch — drop what it cached. */
export function invalidateSnapshotCache(): void {
  cached = null
}

/** Reads the plant, sweeping Zoho only when the revision has moved since the last read. */
export async function readSnapshotCached(zoho: ZohoClient): Promise<Assembled> {
  if (cached && cached.baseId === zoho.baseId) {
    if ((await readRevision(zoho)) === cached.revision) return cached.snap
  }
  if (!sweeping) {
    sweeping = readSnapshot(zoho)
      .then((snap) => {
        cached = { baseId: zoho.baseId, revision: snap.revision, snap }
        return snap
      })
      .finally(() => {
        sweeping = null
      })
  }
  return sweeping
}

/** Reads just the revision number (one row) — the client's 20-second poll. */
export async function readRevision(zoho: ZohoClient): Promise<number> {
  const cfg = T['Config']
  const rows = await zoho.fetchAll(cfg.id)
  for (const r of rows) {
    if (String(r.data[cfg.fields['Setting']]) === 'app_revision') return Number(r.data[cfg.fields['Value']]) || 0
  }
  return 0
}
