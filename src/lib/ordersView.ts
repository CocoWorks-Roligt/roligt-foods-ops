/**
 * The orders page's derivations — the drinks catalogue, the lots a dispatch can
 * fill from, and the order form's shape held up against the product master.
 * Pure: plain data in, plain data out. The page keeps only its React state and
 * the glue that reads the app context.
 */

import type { AppState, Item, Order, OrderLine, Product, StockRow } from '../types.ts'
import { bulkItemOf, drinkName } from './packs.ts'
import type { OrderAllocation } from './posting.ts'
import { displayExpiry, inHoldArea, parseRowKey, rowKey } from './stock.ts'
import { QTY_EPSILON, toLocalInputValue } from './utils.ts'

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

/** The picks state as the dispatch write takes it: each line's chosen rows,
 *  the rowKey (lot + location + expiry — the whole row identity) unpacked back
 *  into the allocation. ONE fold: the Classic modal and the dispatch stage form
 *  both build their allocations here, so what either posts is the same shape. */
export function allocationsFromPicks(
  lines: OrderLine[],
  picks: Record<string, Record<string, number>>,
): OrderAllocation[] {
  return lines.map((l) => ({
    sku: l.sku,
    picks: Object.entries(picks[l.sku] || {}).map(([k, qty]) => {
      const { lot, location, expiry } = parseRowKey(k)
      return { lot, location, expiry, qty }
    }),
  }))
}

/** Units allotted to a sku so far — the dispatch form's live meter. */
export function allottedFor(picks: Record<string, Record<string, number>>, sku: string): number {
  return Object.values(picks[sku] || {}).reduce((a, q) => a + (Number(q) || 0), 0)
}

/** The first line not exactly allotted — over is as refused as under, because
 *  an order goes out complete. `undefined` means the order can go. */
export function shortLineOf(
  lines: OrderLine[],
  picks: Record<string, Record<string, number>>,
): OrderLine | undefined {
  return lines.find((l) => Math.abs(allottedFor(picks, l.sku) - l.qty) > QTY_EPSILON)
}

/**
 * An order's flat lines rebuilt into the form's draft — the inverse of
 * `linesFromDraft`, so editing starts from what was saved. Each drink holds only
 * the packs the order actually asks for; a sku the master no longer knows keeps
 * its own orphan block, because the order for it may be perfectly dispatchable.
 */
export function draftFromOrder(order: Order, productById: Map<string, Product>): OrderDraft {
  const picked: string[] = []
  const formats: Record<string, string[]> = {}
  const qtys: Record<string, number | ''> = {}
  for (const l of order.lines) {
    qtys[l.sku] = l.qty
    const p = productById.get(l.sku)
    const key = p ? bulkItemOf(p) : `orphan:${l.sku}`
    if (!picked.includes(key)) picked.push(key)
    if (p) (formats[key] ||= []).push(l.sku)
  }
  return {
    customerId: order.customerId,
    // The date the form's datetime-local input shows, not the stored ISO stamp.
    date: toLocalInputValue(new Date(order.date)),
    dueDate: order.dueDate || '',
    notes: order.notes || '',
    picked,
    formats,
    qtys,
  }
}

/**
 * The form's blocks flattened back into plain order lines — only what the visible
 * blocks hold is written: drinks in the order they were picked, formats
 * largest-first, and an unquantified format never a line.
 */
export function linesFromDraft(blocks: DraftBlock[], qtys: Record<string, number | ''>): OrderLine[] {
  const lines: OrderLine[] = []
  for (const b of blocks) {
    const skus = b.sku ? [b.sku] : b.formats.map((p) => p.id)
    for (const sku of skus) {
      const qty = qtys[sku]
      if (Number(qty) > 0) lines.push({ sku, qty: Number(qty) })
    }
  }
  return lines
}
