/**
 * The orders page's derivations — the drinks catalogue, the lots a dispatch can
 * fill from, and the order form's shape held up against the product master.
 * Pure: plain data in, plain data out. The page keeps only its React state and
 * the glue that reads the app context.
 */

import type { AppState, Item, Order, OrderLine, Product, StockRow } from '../types.ts'
import { bulkItemOf, drinkName } from './packs.ts'
import { displayExpiry, inHoldArea, rowKey } from './stock.ts'
import { QTY_EPSILON } from './utils.ts'

/**
 * A customer orders by drink, not by pack SKU — "TCW" comes as 5 L BiBs, 2.5 L
 * BiBs, 250 ml bottles. The form holds that shape: the drinks picked, and a
 * quantity per pack format beneath each. It flattens to plain order lines on
 * save, so nothing downstream ever sees the difference.
 */
export interface OrderDraft {
  customerId: string
  date: string
  dueDate: string
  notes: string
  /** Bulk-item ids in the order they were picked; `orphan:${sku}` for a line whose
   *  product has left the master. */
  picked: string[]
  /** The pack formats actually chosen, per drink — a drink shows only the packs
   *  picked for it, never its whole catalogue with blank boxes. */
  formats: Record<string, string[]>
  /** Quantity per chosen pack sku — '' means the box was left blank, and only a
   *  quantified format becomes a line. */
  qtys: Record<string, number | ''>
}

/** One drink's slice of the product master: every pack format filled from its bulk. */
export interface DrinkGroup {
  bulkId: string
  name: string
  isMelange: boolean
  formats: Product[]
}

/**
 * One block of the form — a picked drink with the formats chosen for it, or a
 * single sku the master no longer knows, which still has to be seen and editable
 * because the order for it may be perfectly dispatchable.
 */
export interface DraftBlock {
  key: string
  name: string
  isMelange: boolean
  formats: Product[]
  /** Set only on an orphan block: the one sku it carries. */
  sku?: string
}

/** One released lot a dispatch can fill from. `expiry` is what the ledger recorded
 *  and is part of which row this is; `shownExpiry` is only for printing, and falls
 *  back to the lot-wide lookup for rows written before lines carried their own date. */
export interface ReleasedLot {
  item: string
  lot: string
  location: string
  qty: number
  expiry?: string
  shownExpiry?: string
}

/** Pack formats grouped under the drink they are filled from — the picker's offer,
 *  largest format first so a drink reads 5 L, 2.5 L, 250 ml. */
export function drinkCatalog(
  products: Product[],
  itemById: Map<string, Item>,
  melangeOutputs: Set<string>,
): DrinkGroup[] {
  const byBulk = new Map<string, DrinkGroup>()
  for (const p of products) {
    const bulkId = bulkItemOf(p)
    let g = byBulk.get(bulkId)
    if (!g) {
      g = {
        bulkId,
        name: drinkName(itemById.get(bulkId)?.name || bulkId),
        isMelange: melangeOutputs.has(bulkId),
        formats: [],
      }
      byBulk.set(bulkId, g)
    }
    g.formats.push(p)
  }
  const list = [...byBulk.values()]
  for (const d of list)
    d.formats.sort((a, b) => b.packVolume - a.packVolume || a.name.localeCompare(b.name))
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

/** Released packs on hand, by SKU, so a line can be filled from real lots. Oldest
 *  stock first, so the operator is offered it first; hold areas are not offerable. */
export function releasedPacksBySku(state: AppState, rows: StockRow[]): Map<string, ReleasedLot[]> {
  const by = new Map<string, ReleasedLot[]>()
  for (const r of rows) {
    if (r.itemType !== 'Finished Goods' || r.status !== 'Released' || r.qty <= QTY_EPSILON) continue
    if (inHoldArea(state, r.location)) continue
    const list = by.get(r.item) || []
    list.push({
      item: r.item,
      lot: r.lot,
      location: r.location,
      qty: r.qty,
      expiry: r.expiry,
      shownExpiry: displayExpiry(state, r),
    })
    by.set(r.item, list)
  }
  for (const list of by.values())
    list.sort((a, b) => (a.shownExpiry || '').localeCompare(b.shownExpiry || ''))
  return by
}

/** The order list: newest first, then the search over order, customer, status, challan. */
export function filterOrders(orders: Order[], search: string): Order[] {
  const q = search.trim().toLowerCase()
  const list = [...orders].sort((a, b) => b.date.localeCompare(a.date))
  if (!q) return list
  return list.filter((o) =>
    [o.id, o.customerName, o.status, o.challan || ''].join(' ').toLowerCase().includes(q),
  )
}

/**
 * What the form is holding, as the blocks the operator sees — and the only thing
 * the save flattens, so what is on screen is exactly what is written.
 *
 * A drink whose products have all left the master still renders (empty, with a
 * note) rather than silently unpicking itself; and a sku deleted while the form
 * was open is promoted to an orphan block, because a quantity already entered
 * for it is real intent. A product moved to a different drink mid-edit is the
 * one case that quietly drops — master surgery during an open form, which the
 * audit trail shows as the order's line count changing.
 */
export function resolveBlocks(
  draft: OrderDraft,
  drinkById: Map<string, DrinkGroup>,
  productById: Map<string, Product>,
  itemById: Map<string, Item>,
  melangeOutputs: Set<string>,
  itemName: (id: string) => string,
): DraftBlock[] {
  const blocks: DraftBlock[] = []
  for (const key of draft.picked) {
    if (key.startsWith('orphan:')) {
      const sku = key.slice('orphan:'.length)
      // Back in the master: its drink's block owns it again, so this key goes quiet.
      if (productById.has(sku)) continue
      blocks.push({ key, name: itemName(sku), isMelange: false, formats: [], sku })
      continue
    }
    const d = drinkById.get(key)
    // Only the formats chosen for this drink, and only those still in the master
    // — a chosen sku that has left it is carried by the orphan pass below.
    const chosen = (draft.formats[key] || [])
      .map((sku) => d?.formats.find((p) => p.id === sku))
      .filter((p): p is Product => !!p)
    blocks.push({
      key,
      name: d?.name || drinkName(itemById.get(key)?.name || key),
      isMelange: d?.isMelange || melangeOutputs.has(key),
      formats: chosen,
    })
  }
  for (const [sku, q] of Object.entries(draft.qtys)) {
    if (!(Number(q) > 0) || productById.has(sku)) continue
    const key = `orphan:${sku}`
    if (blocks.some((b) => b.key === key)) continue
    blocks.push({ key, name: itemName(sku), isMelange: false, formats: [], sku })
  }
  return blocks
}

/** An order's lines as the plant reads them — by drink, with anything the master
 *  no longer knows under its own heading. */
export function linesByDrink(
  lines: OrderLine[],
  productById: Map<string, Product>,
  itemById: Map<string, Item>,
  melangeOutputs: Set<string>,
): { drinks: { key: string; name: string; isMelange: boolean; lines: OrderLine[] }[]; off: OrderLine[] } {
  const order: string[] = []
  const byDrink = new Map<string, OrderLine[]>()
  const off: OrderLine[] = []
  for (const l of lines) {
    const p = productById.get(l.sku)
    if (!p) {
      off.push(l)
      continue
    }
    const key = bulkItemOf(p)
    if (!byDrink.has(key)) {
      byDrink.set(key, [])
      order.push(key)
    }
    byDrink.get(key)!.push(l)
  }
  return {
    drinks: order.map((key) => {
      const item = itemById.get(key)
      return {
        key,
        name: drinkName(item?.name || key),
        isMelange: melangeOutputs.has(key),
        lines: byDrink.get(key)!,
      }
    }),
    off,
  }
}

/** Pre-fill a dispatch from the oldest stock, which is what should go first anyway.
 *  Keyed the way the picks state is: sku, then the stock row's rowKey. */
export function seedAllocations(
  lines: OrderLine[],
  availableFor: Map<string, ReleasedLot[]>,
): Record<string, Record<string, number>> {
  const seeded: Record<string, Record<string, number>> = {}
  for (const line of lines) {
    let left = line.qty
    seeded[line.sku] = {}
    for (const r of availableFor.get(line.sku) || []) {
      if (left <= 0) break
      const take = Math.min(left, r.qty)
      seeded[line.sku][rowKey(r)] = take
      left -= take
    }
  }
  return seeded
}
