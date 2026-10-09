/**
 * The wire-table registry — the engine-neutral facts every engine shares.
 *
 * baseSchema.ts answers "which Zoho table holds this wire table" (a Zoho
 * engine's question); this module answers the questions that have nothing to
 * do with any store: which wire tables exist, which AppState key each feeds,
 * and the collection name compliance rides once the 26-read constraint is
 * gone (a D1 snapshot is one batch, so the register joins `documents` instead
 * of standing alone the way the Zoho base forced it to).
 */
import { COLLECTIONS } from '../../src/lib/tables.js'

/**
 * Every wire table that holds documents — the collections plus the two flat
 * tables. `vendor_types` and `order_lines` are deliberately absent: they were
 * Zoho link machinery the app never read back, and no engine after Zoho has
 * any use for them. This is the commit gate's writable set (commitGates.ts)
 * and the snapshot's scanned set (snapshot.ts) from one source.
 */
export const WIRE_TABLES: readonly string[] = [...COLLECTIONS.map((c) => c.table), 'ledger', 'audits']

/** D1-only masters. They deliberately have no Zoho table: adding one would turn
 * the Zoho cold sweep into the 27th read that the old backend cannot afford. */
export const D1_ONLY_TABLES = new Set(['packs'])

/** The legacy Zoho engine's exact sweep/write surface. */
export const ZOHO_WIRE_TABLES: readonly string[] = WIRE_TABLES.filter((t) => !D1_ONLY_TABLES.has(t))

/**
 * The documents-table collection the compliance register rides on D1 — the
 * Zoho engine keeps its standalone table (the sweep's exactly-26 arithmetic
 * depends on it); the D1 engine has no such budget and stores the register as
 * plain documents rows under this name.
 */
export const COMPLIANCE = 'compliance'

/** AppState is keyed by collection KEY (vendorTypes), not table name (vendor_types). */
export function stateKeyFor(supa: string): string | null {
  if (supa === 'ledger' || supa === 'audits') return supa
  return COLLECTIONS.find((c) => c.table === supa)?.key ?? null
}
