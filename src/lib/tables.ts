/**
 * How the in-memory state maps onto the database.
 *
 * The plant used to live in a single JSONB row that every client read at boot and
 * wrote back whole on every change. That one decision caused most of the serious
 * problems: two operators overwrote each other silently, the row grew without bound,
 * the ledger had no index, and — because an operator needs to write that row to do
 * their job — the database could not tell a receipt from a change to the item master,
 * so role separation could only ever be enforced in the UI.
 *
 * Now each document is a row in its own table. That fixes all four: two people posting
 * different receipts no longer touch the same row, the ledger is indexed and
 * append-only, and RLS can finally say that an operator may write a batch but not the
 * item master.
 *
 * What is deliberately *not* done here is spreading every field of every document into
 * its own column. The documents keep a `data` payload, because that is what lets the
 * in-memory `AppState` shape stay exactly as it was — no page, no rule in `lib/` and
 * no test had to change for this migration, which is the only reason it could be made
 * safely in one step. The ledger, which is the thing you actually query and index, does
 * get real columns. Typing the rest is the next step, and a smaller one from here.
 */

import type { AppState, AuditEntry, LedgerEntry } from '../types'

/** The `AppState` keys that are stored as one row per entry. */
export type CollectionKey =
  | 'vendors'
  | 'customers'
  | 'purchaseProducts'
  | 'storageLocations'
  | 'items'
  | 'products'
  | 'melanges'
  | 'grns'
  | 'batches'
  | 'packingRuns'
  | 'orders'
  | 'qcs'
  | 'dispatches'
  | 'testParameters'
  | 'labReports'
  | 'stickerTemplates'
  | 'stickerPrints'
  | 'stockIssues'
  | 'staff'
  | 'shifts'
  | 'attendance'
  | 'productionPlans'

export interface CollectionSpec {
  key: CollectionKey
  table: string
  /** What identifies a row. Not always `id` — a sticker layout is keyed by its stage. */
  id: (row: Record<string, unknown>) => string
  /**
   * True when a row never changes after it is written, so a diff can compare the set
   * of ids and skip comparing content. Print history is a record of what was printed;
   * re-deriving it later would be a different thing.
   */
  immutable?: boolean
  /**
   * True when only an administrator may write this table. Mirrors the RLS policy in
   * `supabase/schema.sql` — the database is what enforces it; this is documentation
   * and lets the client fail early with a readable message.
   */
  adminOnly?: boolean
}

const byId = (row: Record<string, unknown>) => String(row.id)

export const COLLECTIONS: CollectionSpec[] = [
  // ── masters: an operator may read these, only an admin may change them ──
  { key: 'vendors', table: 'vendors', id: byId, adminOnly: true },
  { key: 'customers', table: 'customers', id: byId, adminOnly: true },
  { key: 'purchaseProducts', table: 'purchase_products', id: byId, adminOnly: true },
  { key: 'storageLocations', table: 'storage_locations', id: byId, adminOnly: true },
  { key: 'items', table: 'items', id: byId, adminOnly: true },
  { key: 'products', table: 'products', id: byId, adminOnly: true },
  { key: 'melanges', table: 'melanges', id: byId, adminOnly: true },
  { key: 'testParameters', table: 'test_parameters', id: byId, adminOnly: true },
  { key: 'staff', table: 'staff', id: byId, adminOnly: true },

  // ── the day's work ──
  { key: 'grns', table: 'grns', id: byId },
  { key: 'batches', table: 'batches', id: byId },
  { key: 'packingRuns', table: 'packing_runs', id: byId },
  { key: 'orders', table: 'orders', id: byId },
  { key: 'qcs', table: 'qcs', id: byId },
  { key: 'dispatches', table: 'dispatches', id: byId },
  { key: 'stockIssues', table: 'stock_issues', id: byId },
  { key: 'labReports', table: 'lab_reports', id: byId },
  { key: 'shifts', table: 'shifts', id: byId },
  { key: 'attendance', table: 'attendance', id: byId },
  { key: 'productionPlans', table: 'production_plans', id: byId },
  { key: 'stickerTemplates', table: 'sticker_templates', id: (r) => String(r.stage) },
  { key: 'stickerPrints', table: 'sticker_prints', id: byId, immutable: true },
]

/**
 * The ledger gets real columns. It is the one table anything would ever query — every
 * balance, valuation and traceability answer in the app is folded out of it — and the
 * only one that grows without limit, so it is the one that needs indexes.
 */
export const LEDGER_TABLE = 'ledger'

export const ledgerToRow = (l: LedgerEntry) => ({
  id: l.id,
  type: l.type,
  doc: l.doc,
  item: l.item,
  item_type: l.itemType,
  lot: l.lot,
  location: l.location,
  status: l.status,
  qty_in: l.qtyIn,
  qty_out: l.qtyOut,
  uom: l.uom,
  unit_cost: l.unitCost,
  at: l.time,
  expiry: l.expiry ?? null,
  vendor_id: l.vendorId ?? null,
})

export const ledgerFromRow = (r: Record<string, unknown>): LedgerEntry => ({
  id: String(r.id),
  type: String(r.type),
  doc: String(r.doc),
  item: String(r.item),
  itemType: String(r.item_type),
  lot: String(r.lot),
  location: String(r.location),
  status: String(r.status),
  qtyIn: Number(r.qty_in) || 0,
  qtyOut: Number(r.qty_out) || 0,
  uom: String(r.uom),
  unitCost: Number(r.unit_cost) || 0,
  time: String(r.at),
  ...(r.expiry ? { expiry: String(r.expiry) } : {}),
  ...(r.vendor_id ? { vendorId: String(r.vendor_id) } : {}),
})

/**
 * The audit trail, insert-only in the database so that not even an administrator can
 * quietly edit history through the API. It used to live inside the same blob every
 * client could rewrite, which meant it could prove nothing at all.
 */
export const AUDIT_TABLE = 'audits'

export const auditToRow = (a: AuditEntry) => ({
  id: a.id,
  at: a.time,
  actor: a.role,
  action: a.action,
  doc: a.doc,
  details: a.details,
})

export const auditFromRow = (r: Record<string, unknown>): AuditEntry => ({
  id: String(r.id),
  time: String(r.at),
  role: String(r.actor),
  action: String(r.action),
  doc: String(r.doc ?? ''),
  details: String(r.details ?? ''),
})

/** Counters advance on every posting, so an operator must be able to write them. */
export const COUNTER_TABLE = 'app_counters'
/** Tolerances, numbering shapes and label copy. Administrator's business. */
export const CONFIG_TABLE = 'app_config'
/**
 * A single number bumped by a trigger whenever anything is written. Polling it is how
 * a client notices that somebody else has posted something, without pulling the whole
 * plant down the wire every few seconds.
 */
export const REVISION_TABLE = 'app_revision'

export const collectionOf = (key: CollectionKey) =>
  COLLECTIONS.find((c) => c.key === key) as CollectionSpec

/** Collections an operator is allowed to write. Mirrors the RLS policies. */
export const writableByOperator = (spec: CollectionSpec) => !spec.adminOnly

export type StoredState = Pick<AppState, CollectionKey | 'ledger' | 'audits' | 'config' | 'counters'>
