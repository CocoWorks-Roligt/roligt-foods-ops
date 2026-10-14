/**
 * The Packing stage form's pure folds (WORKFLOW W10) — bulk into packs: glass
 * bottles the standard flow, BIB pouches (1L / 2.5L / 5L) stored LOOSE in the
 * cold room with the POUCH itself as the finished-goods unit tracked by lot,
 * size and location (§3.3 step 6). Cartons are a dispatch-time decision
 * (§3.3 step 9, SHIPMENT-era) — packing never touches them, so nothing here
 * counts a carton.
 *
 * Nothing is re-derived: the bulk pool IS the Classic packing form's own fold
 * (fillable bulk — something is packed from it; batches with drawable stock —
 * checkPacking draws against DRAWABLE, and its refusal names rejected bulk in
 * its own words), the pack list IS the product master's (bulkItemOf, retired
 * hidden), and the materials preview IS packingNeeds — the same walk the save
 * gate runs. The stage form posts through the same createPackingRun the Classic
 * page uses; there is no new backend.
 */
import { bulkItems } from './batches.ts'
import { bulkItemOf, packLabel } from './packs.ts'
import { DRAWABLE } from './posting.ts'
import type { AppState, Batch, Item, Product, StockRow } from '../types.ts'
import { QTY_EPSILON } from './utils.ts'

/**
 * Bulk something is actually packed from — the Classic form's own `fillable`
 * fold. A retired-only pack still counts (the Classic form's own rule): the
 * bulk stays offered so its empty state can say "the packs are retired" rather
 * than the bulk silently vanishing.
 */
export function fillableBulk(state: AppState): Item[] {
  return bulkItems(state).filter((b) => state.products.some((p) => bulkItemOf(p) === b.id))
}

/**
 * Drawable bulk on hand per batch lot — exactly the rows checkPacking itself
 * draws against (DRAWABLE: Available, Quarantine, Released), pooled across
 * areas. QC-rejected bulk is invisible here as it is there, so a batch the gate
 * would refuse for its own reason is never offered as packable.
 */
export function bulkByBatch(rows: readonly StockRow[], bulkItem: string): Map<string, number> {
  const held = new Map<string, number>()
  for (const r of rows) {
    if (r.item !== bulkItem || r.qty <= 0 || !DRAWABLE.includes(r.status)) continue
    held.set(r.lot, (held.get(r.lot) || 0) + r.qty)
  }
  return held
}

/**
 * Batches that still have bulk of this kind waiting to be packed, newest first
 * — the Classic form's own fold verbatim.
 */
export function packableBatches(batches: readonly Batch[], held: Map<string, number>): Batch[] {
  return batches.filter((b) => (held.get(b.id) || 0) > QTY_EPSILON).slice().reverse()
}

/** One pack SKU as the form offers it. */
export interface PackOption {
  id: string
  /** "5 L BiB" — the pack's own name, with the recipe's SKU name only when two
   *  packs would otherwise read the same (the Classic dropdown's own rule). */
  label: string
  /** The pack's format — Glass Bottle, BiB, Pouch … — free text the admin names. */
  type: string
  /** What one pack holds, in the bulk's base unit. */
  packVolume: number
}

/**
 * The pack SKUs this bulk is a recipe of, retired ones hidden — the Classic
 * form's own fold. Retired packs stay everywhere history reads them (stock,
 * stickers, dispatch) but never a new run's list.
 */
export function packsForBulk(products: readonly Product[], bulkItem: string): PackOption[] {
  const list = products.filter((p) => bulkItemOf(p) === bulkItem && !p.retired)
  return list.map((p) => {
    const label = packLabel(p)
    const clashes = list.filter((x) => packLabel(x) === label).length > 1
    return {
      id: p.id,
      label: clashes ? `${label} · ${p.name}` : label,
      type: p.type,
      packVolume: p.packVolume,
    }
  })
}

/**
 * The pack formats stored loose in the cold room as their own finished-goods
 * unit (§3.3 step 6). The type is free text the admin names, so the named pouch
 * formats count and a bottle format does not.
 */
const LOOSE_POUCH = new Set(['BiB', 'Pouch'])

/** Whether a pack format is a loose pouch — drives the form's where-it-goes note. */
export const isLoosePouch = (type: string) => LOOSE_POUCH.has(type)
