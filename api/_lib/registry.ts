/**
 * The wire-table registry — the store-neutral facts every arm shares.
 *
 * This module answers the questions that have nothing to do with any store:
 * which wire tables exist, which AppState key each feeds, and the collection
 * name the compliance register rides as plain documents rows.
 */
import { COLLECTIONS } from '../../src/lib/tables.js'

/**
 * Every wire table that holds documents — the collections plus the two flat
 * tables. `vendor_types` and `order_lines` are deliberately absent: they were
 * Zoho link machinery the app never read back, and no engine after Zoho had
 * any use for them. This is the commit gate's writable set (commitGates.ts)
 * and the snapshot's scanned set (d1Snapshot.ts) from one source.
 */
export const WIRE_TABLES: readonly string[] = [...COLLECTIONS.map((c) => c.table), 'ledger', 'audits']

/**
 * The documents-table collection the compliance register rides — stored as
 * plain documents rows under this name; still NOT a wire table: the client's
 * state never sees it, /api/compliance/* stays its only reader.
 */
export const COMPLIANCE = 'compliance'

/** AppState is keyed by collection KEY (vendorTypes), not table name (vendor_types). */
export function stateKeyFor(supa: string): string | null {
  if (supa === 'ledger' || supa === 'audits') return supa
  return COLLECTIONS.find((c) => c.table === supa)?.key ?? null
}
