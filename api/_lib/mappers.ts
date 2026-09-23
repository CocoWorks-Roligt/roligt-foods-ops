/**
 * Doc ⇄ base rows.
 *
 * Reads are uniform: every table yields App ID + Data JSON, which is exactly the
 * (id, data) contract the Supabase client had — the app's own `fetchDb` shape. Writes
 * additionally fill the table's real columns (best-effort enrichment for Analytics and
 * link fields), but reads never depend on them, so a missing or wrong column can never
 * corrupt the app — only a report.
 */
import type { ZohoRecord } from './zoho.ts'
import type { TableRef } from './baseSchema.ts'
import type { Grn, LedgerEntry, Vendor, PurchaseProduct, StorageLocation, Item } from '../../src/types.ts'
import { ledgerFromRow } from '../../src/lib/tables.ts'

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

export interface LinkMaps {
  vendors: Map<string, string>              // vendor app id → zoho record id
  purchaseProducts: Map<string, string>
  storageLocations: Map<string, string>    // keyed by BOTH app id and ledger name
  items: Map<string, string>               // keyed by BOTH app id and item name
}

/** Build link maps from the master rows of a snapshot (App ID + Data JSON already read). */
export function buildLinkMaps(
  vendors: ZohoRecord[],
  purchaseProducts: ZohoRecord[],
  storageLocations: ZohoRecord[],
  items: ZohoRecord[],
  t: { vendors: TableRef; purchaseProducts: TableRef; storageLocations: TableRef; items: TableRef },
): LinkMaps {
  const byAppId = (rows: ZohoRecord[], table: TableRef) =>
    new Map(rows.map((r) => [String(r.data[table.appId] ?? ''), r.recordID]))
  const vendors_ = byAppId(vendors, t.vendors)
  const pp = byAppId(purchaseProducts, t.purchaseProducts)
  const loc = byAppId(storageLocations, t.storageLocations)
  const itm = byAppId(items, t.items)
  for (const r of storageLocations) {
    const doc = rowToDoc(t.storageLocations, r) as { name?: string } | null
    if (doc?.name) loc.set(doc.name, r.recordID)
  }
  for (const r of items) {
    const doc = rowToDoc(t.items, r) as { name?: string } | null
    if (doc?.name) itm.set(doc.name, r.recordID)
  }
  return { vendors: vendors_, purchaseProducts: pp, storageLocations: loc, items: itm }
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
      return { Name: s(p.name), 'Default UOM': s(p.uom) }
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
