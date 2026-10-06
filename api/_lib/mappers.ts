/**
 * Doc ⇄ base rows.
 *
 * Reads are uniform: every table yields App ID + Data JSON, which is exactly the
 * (id, data) contract the Supabase client had — the app's own `fetchDb` shape. Writes
 * additionally fill the table's real columns (best-effort enrichment for Analytics and
 * link fields), but reads never depend on them, so a missing or wrong column can never
 * corrupt the app — only a report.
 *
 * Every collection fills its real columns now (the fork's Plan 2 mapping, never
 * executed before the working papers went to git history). Three kinds stay empty
 * on purpose: attachment columns (probed live 2026-10-06 — a string there makes
 * Zoho silently drop every field AFTER it in the same upsert, so Dispatches.POD
 * is never written; a real attachment write contract is still future work), the
 * Order Lines child table (orders keep their lines in Data JSON until a
 * split-on-write lands), and columns no doc field feeds (a Dispatch records no
 * location of its own; a Lab report carries no decision field). Choice columns
 * carry no option list here on purpose: the same probe showed Zoho auto-adds an
 * unmatched label as a new option and leaves the following fields alone, so the
 * mapper just writes the label and the base grows its own options.
 */
import type { ZohoRecord } from './zoho.js'
import type { TableRef } from './baseSchema.js'
import type {
  Grn, LedgerEntry, Vendor, PurchaseProduct, StorageLocation, Item,
  Customer, Product, Melange, TestParameter, StaffMember, Batch, PackingRun,
  Order, QcRecord, Dispatch, StockIssue, LabReport, ShiftAssignment,
  AttendanceRecord, ProductionPlan, StickerTemplate, StickerPrint,
} from '../../src/types.js'
import { ledgerFromRow } from '../../src/lib/tables.js'

/** One row → the app document it stores. */
export function rowToDoc(table: TableRef, r: ZohoRecord): Record<string, unknown> | null {
  const raw = r.data[table.dataJson!]
  if (raw === undefined || raw === null || raw === '') return null
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The tables whose rows feed link maps — every one buildLinkMaps reads. */
export type LinkTableKey =
  | 'vendors' | 'purchaseProducts' | 'storageLocations' | 'items'
  | 'customers' | 'products' | 'batches' | 'staff'

export interface LinkMaps {
  vendors: Map<string, string>              // vendor app id → zoho record id
  purchaseProducts: Map<string, string>
  storageLocations: Map<string, string>    // keyed by BOTH app id and ledger name
  items: Map<string, string>               // keyed by BOTH app id and item name
  customers: Map<string, string>           // keyed by BOTH app id and customer name
  products: Map<string, string>            // keyed by BOTH app id and product name
  batches: Map<string, string>             // batch app id (a lot/stock id IS one)
  staff: Map<string, string>               // staff app id
}

/** Build link maps from the master rows of a snapshot (App ID + Data JSON already read).
 *  Customers and products are name-keyed as well as id-keyed because documents
 *  reference them by name (a dispatch's sku, a lab report's customerName, a plan's
 *  free-text product); items and locations have always been dual-keyed for the
 *  same reason. Batches grow without limit like the ledger — the commit path's
 *  per-revision memo is what keeps that fetch affordable. */
export function buildLinkMaps(
  rows: Record<LinkTableKey, ZohoRecord[]>,
  t: Record<LinkTableKey, TableRef>,
): LinkMaps {
  const byAppId = (rs: ZohoRecord[], table: TableRef) =>
    new Map(rs.map((r) => [String(r.data[table.appId] ?? ''), r.recordID]))
  const maps: LinkMaps = {
    vendors: byAppId(rows.vendors, t.vendors),
    purchaseProducts: byAppId(rows.purchaseProducts, t.purchaseProducts),
    storageLocations: byAppId(rows.storageLocations, t.storageLocations),
    items: byAppId(rows.items, t.items),
    customers: byAppId(rows.customers, t.customers),
    products: byAppId(rows.products, t.products),
    batches: byAppId(rows.batches, t.batches),
    staff: byAppId(rows.staff, t.staff),
  }
  for (const r of rows.storageLocations) {
    const doc = rowToDoc(t.storageLocations, r) as { name?: string } | null
    if (doc?.name) maps.storageLocations.set(doc.name, r.recordID)
  }
  for (const r of rows.items) {
    const doc = rowToDoc(t.items, r) as { name?: string } | null
    if (doc?.name) maps.items.set(doc.name, r.recordID)
  }
  for (const r of rows.customers) {
    const doc = rowToDoc(t.customers, r) as { name?: string } | null
    if (doc?.name) maps.customers.set(doc.name, r.recordID)
  }
  for (const r of rows.products) {
    const doc = rowToDoc(t.products, r) as { name?: string } | null
    if (doc?.name) maps.products.set(doc.name, r.recordID)
  }
  return maps
}

const s = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))
const n = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))
const link = (m: Map<string, string>, id: unknown) => {
  const v = s(id)
  return v ? m.get(v) : undefined
}

/** Best-effort real columns. Unknown field names in the base are skipped silently. */
export function columnsFor(
  key: string,
  doc: Record<string, unknown>,
  links: LinkMaps,
): Record<string, string | undefined> {
  switch (key) {
    case 'vendors': {
      const v = doc as unknown as Vendor
      // Phone fields (type 17) silently DROP strings containing spaces — the probe
      // pinned it. Send digits only; the Data JSON keeps the original number.
      return { Name: s(v.name), Phone: v.phone ? v.phone.replace(/\D/g, '') : undefined, Area: s(v.area), 'Payment Terms': s(v.payment), Status: s(v.status), Email: s(v.email), Notes: s(v.notes) }
    }
    case 'purchaseProducts': {
      const p = doc as unknown as PurchaseProduct
      return { Name: s(p.name), 'Default UOM': s(p.uom), Item: link(links.items, p.itemId) }
    }
    case 'storageLocations': {
      const l = doc as unknown as StorageLocation
      return { Name: s(l.name), Label: s(l.label), Holds: s(l.holds), Type: s(l.type), Status: s(l.status) }
    }
    case 'items': {
      const i = doc as unknown as Item
      return { Name: s(i.name), Type: s(i.type), UOM: s(i.uom), 'Lot Controlled': i.lotControlled ? 'true' : 'false', 'Reorder Level': n(i.reorder), 'Cost Method': s(i.costMethod) }
    }
    case 'grns': {
      const g = doc as unknown as Grn
      return {
        'Doc No': s(g.id), Date: s(g.date), UOM: s(g.uom), Area: s(g.area), 'Harvested On': s(g.harvestedOn),
        Total: n(g.total), Accepted: n(g.accepted), Free: n(g.free), 'Grade A': n(g.a), 'Grade B': n(g.b), 'Grade C': n(g.c),
        Reject: n(g.reject), Rate: n(g.rate), 'Other Charges': n(g.transport), Status: s(g.status), Notes: s(g.notes),
        Vendor: link(links.vendors, g.farmerId), Product: link(links.purchaseProducts, g.purchaseProductId),
        Location: g.location ? links.storageLocations.get(g.location) : undefined,
      }
    }
    // ── masters the fork left to Plan 2 ──
    case 'customers': {
      const c = doc as unknown as Customer
      return { Name: s(c.name), 'Ship To': s(c.shipTo), GSTIN: s(c.gst), Status: s(c.status), Phone: c.phone ? c.phone.replace(/\D/g, '') : undefined, Email: s(c.email), 'Contact Person': s(c.contactPerson), Notes: s(c.notes) }
    }
    case 'products': {
      const p = doc as unknown as Product
      return { Name: s(p.name), Format: s(p.type), Size: n(p.size), Unit: s(p.unit), 'Pack Volume': n(p.packVolume), 'Shelf Life Days': n(p.shelfLifeDays), 'Chilled Shelf Life Days': n(p.chilledShelfLifeDays), MRP: n(p.mrp), Medium: s(p.medium), 'Bulk Item': link(links.items, p.bulkItem) }
    }
    case 'melanges': {
      const m = doc as unknown as Melange
      return { Name: s(m.name), Status: s(m.status), 'Output Item': link(links.items, m.outputItem) }
    }
    case 'testParameters': {
      const tp = doc as unknown as TestParameter
      // Category is the category KEY (a short string like 'micro'); the Data JSON
      // keeps it and the column takes it as plain text, best-effort.
      return { Name: s(tp.name), Method: s(tp.method), Unit: s(tp.unit), Category: s(tp.category) }
    }
    case 'staff': {
      const st = doc as unknown as StaffMember
      return { 'Staff No': s(st.id), Name: s(st.name), Role: s(st.role), Phone: st.phone ? st.phone.replace(/\D/g, '') : undefined, Status: s(st.status), 'Added On': s(st.addedOn) }
    }
    // ── the day's work ──
    case 'batches': {
      const b = doc as unknown as Batch
      return { 'Batch No': s(b.id), Date: s(b.date), Kind: s(b.kind), Spoiled: n(b.spoiled), 'Cost per Unit': n(b.costPerL), Status: s(b.status), Location: link(links.storageLocations, b.location) }
    }
    case 'packingRuns': {
      const p = doc as unknown as PackingRun
      return { 'Run No': s(p.id), Date: s(p.date), Drawn: n(p.drawn), Status: s(p.status), Batch: link(links.batches, p.batchId), 'Bulk Item': link(links.items, p.bulkItem), Location: link(links.storageLocations, p.location) }
    }
    case 'orders': {
      const o = doc as unknown as Order
      return { 'Order No': s(o.id), Date: s(o.date), Status: s(o.status), Notes: s(o.notes), Customer: link(links.customers, o.customerId) }
    }
    case 'qcs': {
      const q = doc as unknown as QcRecord
      // Statuses and notes only — report attachments are objects the column cannot
      // hold, and their write contract is the probe-first kind.
      const tests = { micro: q.micro, pesticides: q.pesticides, heavyMetals: q.heavyMetals, physico: q.physico, ...(q.tests ?? {}) }
      return { 'Doc No': s(q.id), Disposition: s(q.disposition), 'Tests JSON': JSON.stringify(tests), Batch: link(links.batches, q.batchId), Item: link(links.items, q.item) }
    }
    case 'dispatches': {
      const d = doc as unknown as Dispatch
      // Date is the dispatch moment (ISO, like the ledger's Time column); a
      // Dispatch records no location of its own, so that column stays empty. POD is
      // an ATTACHMENT column, and a string there is worse than a dropped field: the
      // live probe (scratch, 2026-10-06) showed Zoho silently dropping every field
      // AFTER it in the same upsert — Customer, SKU and Batch all vanished while the
      // columns before it landed. The pod signature's name rides the Data JSON; the
      // column waits for a real attachment write contract.
      return { 'Challan No': s(d.challan), Date: s(d.dispatchTime), Expiry: s(d.expiry), Qty: n(d.qty), Vehicle: s(d.vehicle), Status: s(d.status), Customer: link(links.customers, d.customerId), SKU: link(links.products, d.sku), Batch: link(links.batches, d.batchId) }
    }
    case 'stockIssues': {
      const si = doc as unknown as StockIssue
      return { 'Doc No': s(si.id), Date: s(si.date), Reason: s(si.reason), 'Issued To': s(si.recipient), 'Lines JSON': JSON.stringify(si.lines ?? []), Value: n(si.value) }
    }
    case 'labReports': {
      const lr = doc as unknown as LabReport
      // A report carries no decision field — the Scores JSON is what Analytics
      // judges from, same as the lab page itself.
      return { 'Report No': s(lr.id), 'Sample Date': s(lr.sampleDate), 'Issue Date': s(lr.issueDate), 'Scores JSON': JSON.stringify(lr.scores ?? lr.results ?? []), Category: s(lr.category), Batch: link(links.batches, lr.batchId), Customer: link(links.customers, lr.customerName) }
    }
    case 'shifts': {
      const sh = doc as unknown as ShiftAssignment
      return { Key: s(sh.id), Date: s(sh.date), Shift: s(sh.shift), Line: s(sh.line), Note: s(sh.note), Staff: link(links.staff, sh.staffId) }
    }
    case 'attendance': {
      const a = doc as unknown as AttendanceRecord
      return { Key: s(a.id), Date: s(a.date), Status: s(a.status), Staff: link(links.staff, a.staffId) }
    }
    case 'productionPlans': {
      const pp = doc as unknown as ProductionPlan
      // Product is free text — a bulk item, a melange or a pack product name. The
      // products map answers the last of those; the rest leave the column empty.
      return { 'Plan No': s(pp.id), Day: s(pp.date), Stage: s(pp.stage), Product: link(links.products, pp.product), Qty: n(pp.qty), UOM: s(pp.uom), Note: s(pp.note), Status: s(pp.status) }
    }
    case 'stickerTemplates': {
      const st = doc as unknown as StickerTemplate
      return { Name: s(st.title), Stage: s(st.stage), 'Template JSON': JSON.stringify(st.fields ?? []) }
    }
    case 'stickerPrints': {
      const sp = doc as unknown as StickerPrint
      return { 'Doc No': s(sp.id), Stage: s(sp.stage), Title: s(sp.title), 'Printed At': s(sp.printedAt), Qty: n(sp.copies) }
    }
    default:
      return {}
  }
}

/** Ledger rows arrive from the client in the flat snake_case shape `ledgerToRow` emits. */
export function ledgerColumns(row: Record<string, unknown>, links: LinkMaps): Record<string, string | undefined> {
  const l: LedgerEntry = ledgerFromRow(row)
  return {
    Doc: l.doc, Type: l.type, Lot: l.lot, Status: l.status,
    'Qty In': n(l.qtyIn), 'Qty Out': n(l.qtyOut), 'Unit Cost': n(l.unitCost),
    Expiry: s(l.expiry), Time: l.time,
    Item: link(links.items, l.item), Location: link(links.storageLocations, l.location),
  }
}

export function auditColumns(row: Record<string, unknown>): Record<string, string | undefined> {
  // The row arrives in the flat shape auditToRow emits — { id, at, actor, action, doc,
  // details } — not the AuditEntry shape (role/time). Reading the entry keys here
  // silently dropped Actor and Time on every audit write ever made.
  const a = row as unknown as { doc?: string; action?: string; details?: string; actor?: string; at?: string }
  return { Doc: a.doc, Action: a.action, Details: a.details, Actor: a.actor, Time: a.at }
}
