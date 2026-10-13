/**
 * The pipeline Receipt stage form's pure folds (WORKFLOW W6). The form is one
 * form whose questions change with what is being received: the item's own
 * procurement form says whether the load grades at the gate, skips grading
 * into inventory, or goes straight to blending stock. These are the folds that
 * decide that — kept out of the page so they answer under test the same way
 * they answer on the floor.
 *
 * Everything here reads the same masters the rest of the app reads. The
 * backfill (B1) stamps every item with its procurement form; an item the
 * backfill has not reached yet answers through the same derivation the
 * backfill itself uses, so the form and the eventual stamp can never disagree.
 */
import { gradedUnit } from './grn.ts'
import type { ProcurementForm, PurchaseOrderLine } from './contracts.ts'
import type { Grn, Item, PurchaseProduct } from '../types.ts'

/** An item as the masters hold it after B1 — the flags ride the same doc. */
export type StageItem = Item & { procurementForm?: ProcurementForm; requiresGrading?: boolean }

/**
 * Which receipt a material gets. Absent means the item could not be read at
 * all (no product picked yet) — the form asks for the product first.
 */
export function receiptFormOf(item: StageItem | undefined): ProcurementForm | undefined {
  if (!item) return undefined
  if (item.procurementForm) return item.procurementForm
  // backfillItem's own derivation, verbatim in spirit: bought ready to use is
  // DIRECT_USE, anything else the plant presses is RAW, the rest arrives as
  // extract.
  if (item.directUse) return 'DIRECT_USE'
  return item.type === 'Raw Material' ? 'RAW' : 'READY_EXTRACT'
}

/** Where this load is headed, in one sentence the form shows under the item. */
export const ROUTE_NOTES: Record<ProcurementForm, string> = {
  RAW: 'Pressed in-house — extraction turns this lot into water, malai and by-products.',
  READY_EXTRACT: 'Goes into inventory as-is — no grading, no extraction.',
  DIRECT_USE: 'Straight to blending stock — blends consume it as it arrives.',
}

/**
 * Whether this load can be graded later (staged): only the graded intake —
 * a piece-counted raw material. Everything else is either weighed (it never
 * grades) or arrives ready (nothing to sort).
 */
export const canStage = (item: StageItem | undefined) =>
  receiptFormOf(item) === 'RAW' && gradedUnit(item?.uom)

/**
 * The purchase product a PO line means, when it clearly means one. A line
 * names an item by name (that is what the PO form's datalist offered), so the
 * match is by the product's own name, then by the item it books — a line that
 * names nothing the plant buys stays unmatched and is picked by hand.
 */
export function matchProduct(
  line: Pick<PurchaseOrderLine, 'item'>,
  products: PurchaseProduct[],
  itemName: (id: string) => string,
): PurchaseProduct | undefined {
  const want = line.item.trim().toLowerCase()
  if (!want) return undefined
  return (
    products.find((p) => p.name.trim().toLowerCase() === want) ||
    products.find((p) => itemName(p.itemId || '').trim().toLowerCase() === want)
  )
}

/**
 * What each of a PO's lines has already had booked against it: the order's
 * linked GRNs folded by material name (a line names an item; a GRN names the
 * product it booked, or its item). A receipt this device cannot see is simply
 * not counted — the linkage itself stays the server's word, this only shapes
 * the form's "still to receive" hint.
 */
export function receivedAgainst(
  lines: PurchaseOrderLine[],
  poId: string,
  receivedGrnIds: readonly string[],
  grns: readonly Grn[],
  itemName: (id: string) => string,
): number[] {
  const linked = grns.filter((g) => g.poId === poId || receivedGrnIds.includes(g.id))
  return lines.map((line) => {
    const want = line.item.trim().toLowerCase()
    return linked
      .filter((g) => (g.productName || itemName(g.itemId || '')).trim().toLowerCase() === want)
      .reduce((sum, g) => sum + g.accepted, 0)
  })
}
