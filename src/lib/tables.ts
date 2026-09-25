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

// Extension is explicit: this file is also compiled by the nodenext api build (the
// BFF's snapshot reader imports it), where extensionless imports do not resolve.
import type { AppState, AuditEntry, LedgerEntry, ViewId } from '../types.ts'
import type { PermissionKey } from './permissions.ts'

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
   * The permission a caller must hold to write this table (src/lib/permissions.ts):
   * one slug, or a list where any one of them is enough (the test parameters are
   * masters business and the lab tester's own page). Undefined means any signed-in
   * caller may write it — the day's work. Mirrors the gate the BFF enforces per
   * table; this is documentation and lets the client fail early with a readable
   * message.
   */
  writePermission?: PermissionKey | readonly PermissionKey[]
  /**
   * The day's-work page(s) whose work this table carries — the BFF refuses a
   * page-scoped caller's writes here unless they hold one of these pages
   * (src/lib/pages.ts). Deliberately a separate field from writePermission:
   * that one is an allowlist for every caller, this one is a deny-unless-held
   * for scoped callers only — the default caller (the whole open day's work)
   * writes freely. Undefined (ledger, audits, counters) means no page owns it;
   * those ride every commit and carry their own gates.
   */
  page?: ViewId | readonly ViewId[]
}

const byId = (row: Record<string, unknown>) => String(row.id)

export const COLLECTIONS: CollectionSpec[] = [
  // ── masters: an operator may read these; changing them takes the page that
  // owns them — a ticked page carries its page's writes, so a suppliers-clerk
  // role is page.vendors alone. The staff register is the Roster page's own. ──
  { key: 'vendors', table: 'vendors', id: byId, writePermission: 'page.vendors' },
  { key: 'customers', table: 'customers', id: byId, writePermission: 'page.customers' },
  { key: 'purchaseProducts', table: 'purchase_products', id: byId, writePermission: 'page.purchase-products' },
  { key: 'storageLocations', table: 'storage_locations', id: byId, writePermission: 'page.storage' },
  { key: 'items', table: 'items', id: byId, writePermission: 'page.purchase-products' },
  { key: 'products', table: 'products', id: byId, writePermission: 'page.purchase-products' },
  { key: 'melanges', table: 'melanges', id: byId, writePermission: 'page.purchase-products' },
  { key: 'testParameters', table: 'test_parameters', id: byId, writePermission: 'page.test-parameters' },
  { key: 'staff', table: 'staff', id: byId, writePermission: 'page.roster' },

  // ── the day's work — open to every unscoped caller; a page-scoped caller
  // needs the page the table belongs to (the control samples are fields on the
  // run, and lab reports surface on both the QC and the reports page) ──
  { key: 'grns', table: 'grns', id: byId, page: 'procurement' },
  { key: 'batches', table: 'batches', id: byId, page: 'production' },
  { key: 'packingRuns', table: 'packing_runs', id: byId, page: ['packing', 'control-samples'] },
  { key: 'orders', table: 'orders', id: byId, page: 'orders' },
  { key: 'qcs', table: 'qcs', id: byId, page: 'quality' },
  { key: 'dispatches', table: 'dispatches', id: byId, page: 'dispatch' },
  { key: 'stockIssues', table: 'stock_issues', id: byId, page: 'stock-issues' },
  { key: 'labReports', table: 'lab_reports', id: byId, page: ['quality', 'reports'] },
  { key: 'shifts', table: 'shifts', id: byId, page: 'roster' },
  { key: 'attendance', table: 'attendance', id: byId, page: 'roster' },
  { key: 'productionPlans', table: 'production_plans', id: byId, page: 'production-planning' },
  { key: 'stickerTemplates', table: 'sticker_templates', id: (r) => String(r.stage), page: 'stickers' },
  { key: 'stickerPrints', table: 'sticker_prints', id: byId, immutable: true, page: 'stickers' },
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

export type StoredState = Pick<AppState, CollectionKey | 'ledger' | 'audits' | 'config' | 'counters'>
