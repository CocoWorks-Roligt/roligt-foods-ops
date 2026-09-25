/**
 * The planning page's derivations — what must ship, netted against the store and
 * the board. Pure: everything here takes the snapshot's plain data and returns
 * plain data, so the netting rules (packing plans commit bulk, extraction and
 * melange plans supply it, Done plans are neither) can be read and tested
 * without the page.
 */

import { fmtQty, toDateKey } from './utils.ts'
import { bulkItemOf, bulkUomForUnit, drinkName } from './packs.ts'
import { stockRows } from './stock.ts'
import type { AppState, Order, PlanStage, Product, ProductionPlan } from '../types.ts'

/** The short unit a bulk is counted in on this page: kg when weighed, L when poured. */
export const shortUom = (uom: string) => (uom === 'Kg' ? 'kg' : 'L')

/** One pack format's slice of a drink's demand. */
export interface FormatRow {
  sku: string
  name: string
  /** Undefined when the order names a sku that is no longer in the product master. */
  product?: Product
  due: number
  released: number
  /** Packs already sitting on Planned/In-progress packing plans for this product. */
  planned: number
  toMake: number
  /** The open orders asking for this format — what a plan off this row serves. */
  orders: string[]
  /** Of those, the ones already past their ship-by day. */
  overdue: string[]
}

/** One drink: the formats the open orders ask for, and the bulk that implies. */
export interface DrinkRow {
  key: string
  bulkId: string | null
  name: string
  isMelange: boolean
  formats: FormatRow[]
  /** Base units the drink's packs commit — owed by open orders, or promised by the
   *  packing plans on the board, which draw their bulk when they run. */
  needed: number
  /** Released bulk waiting in the cold room. */
  onHand: number
  /** Bulk the extraction and melange plans on the board will make. */
  plannedBulk: number
  toMakeBulk: number
  uom: string
  /** Every open order behind any of the drink's formats. */
  orders: string[]
  /** How many of those orders are past their ship-by day. */
  overdue: number
  /** For a melange: what the blend draws, in the recipe's shares. */
  components: { name: string; qty: number; uom: string }[]
}

/** The Monday of the week `d` falls in — a ship-by day's week runs Monday to
 *  Sunday, the way the roster reads weeks. */
const mondayOf = (d: Date) => {
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return monday
}

const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00`)
  d.setDate(d.getDate() + n)
  return toDateKey(d)
}

/**
 * The window a horizon names — this week or next, Monday to Sunday. Null means
 * every open order, which is where the page starts: nothing owed is hidden until
 * someone asks for a week.
 */
export function horizonWindow(horizon: 'all' | 'week' | 'next'): { from: string; to: string } | null {
  if (horizon === 'all') return null
  const monday = toDateKey(mondayOf(new Date()))
  const from = horizon === 'next' ? addDays(monday, 7) : monday
  return { from, to: addDays(from, 6) }
}

/**
 * What must ship: open orders by drink, netted both ways against the plant. Each
 * drink row works out the bulk its packs commit — the ones still to fill and the
 * ones a packing plan on the board will draw when it runs — then nets that against
 * bulk released in the cold room and the bulk the extraction and melange plans on
 * the board will make, and says whether more must be extracted or blended. A Done
 * plan is not counted on either side: its run is posted, so its bulk is already a
 * stock row.
 */
export function planDemand(
  state: AppState,
  win: { from: string; to: string } | null,
): { drinks: DrinkRow[]; covered: number; beyond: number } {
  const today = toDateKey()
  const due: Record<string, number> = {}
  const orderIds: Record<string, string[]> = {}
  const overdueIds: Record<string, string[]> = {}
  let beyond = 0
  for (const o of state.orders) {
    if (o.status !== 'Open') continue
    // A week window narrows what is shown, never what is owed: an order past
    // its ship-by day, or one with none, always stays on the page.
    if (
      win &&
      o.dueDate &&
      o.dueDate >= today &&
      !(o.dueDate >= win.from && o.dueDate <= win.to)
    ) {
      beyond++
      continue
    }
    for (const l of o.lines) {
      due[l.sku] = (due[l.sku] || 0) + l.qty
      if (!orderIds[l.sku]) orderIds[l.sku] = []
      if (!orderIds[l.sku].includes(o.id)) orderIds[l.sku].push(o.id)
      if (o.dueDate && o.dueDate < today) {
        if (!overdueIds[l.sku]) overdueIds[l.sku] = []
        if (!overdueIds[l.sku].includes(o.id)) overdueIds[l.sku].push(o.id)
      }
    }
  }
  const rows = stockRows(state)
  const releasedPacks: Record<string, number> = {}
  for (const r of rows) {
    if (r.itemType !== 'Finished Goods' || r.status !== 'Released') continue
    releasedPacks[r.item] = (releasedPacks[r.item] || 0) + r.qty
  }
  const releasedBulk: Record<string, number> = {}
  for (const r of rows) {
    if (r.itemType !== 'Semi Finished' || r.status !== 'Released') continue
    releasedBulk[r.item] = (releasedBulk[r.item] || 0) + r.qty
  }
  /** Packs already on Planned/In-progress packing plans, keyed by product name —
   *  a plan on the board is work spoken for, so demand must not ask for it twice. */
  const onBoard: Record<string, number> = {}
  /** Bulk the extraction and melange plans on the board will make, by bulk item. */
  const bulkIncoming: Record<string, number> = {}
  for (const p of state.productionPlans) {
    if (p.status !== 'Planned' && p.status !== 'In progress') continue
    if (p.stage === 'Packing') {
      if (p.uom !== 'Packs') continue
      onBoard[p.product] = (onBoard[p.product] || 0) + p.qty
    } else {
      if (p.uom === 'Packs') continue
      const item = state.items.find((i) => i.type === 'Semi Finished' && i.name === p.product)
      if (item) bulkIncoming[item.id] = (bulkIncoming[item.id] || 0) + p.qty
    }
  }

  const itemById = new Map(state.items.map((i) => [i.id, i]))
  const melangeOutputs = new Set(state.melanges.map((m) => m.outputItem))
  const groups = new Map<string, DrinkRow>()
  const orphans: DrinkRow[] = []

  for (const sku of new Set([...Object.keys(due), ...Object.keys(releasedPacks)])) {
    const product = state.products.find((p) => p.id === sku)
    const d = due[sku] || 0
    const rel = releasedPacks[sku] || 0
    const planned = product ? onBoard[product.name] || 0 : 0
    const toMake = Math.max(0, d - rel - planned)
    const fmt: FormatRow = {
      sku,
      name: product?.name || sku,
      product,
      due: d,
      released: rel,
      planned,
      toMake,
      orders: orderIds[sku] || [],
      overdue: overdueIds[sku] || [],
    }
    if (d === 0 && rel === 0) continue
    if (!product) {
      // An order naming a sku that is gone from the master still has to be seen.
      orphans.push({
        key: `orphan:${sku}`,
        bulkId: null,
        name: fmt.name,
        isMelange: false,
        formats: [fmt],
        needed: 0,
        onHand: 0,
        plannedBulk: 0,
        toMakeBulk: 0,
        uom: '',
        orders: fmt.orders,
        overdue: fmt.overdue.length,
        components: [],
      })
      continue
    }
    const bulkId = bulkItemOf(product)
    let g = groups.get(bulkId)
    if (!g) {
      const item = itemById.get(bulkId)
      g = {
        key: bulkId,
        bulkId,
        name: drinkName(item?.name || bulkId),
        isMelange: melangeOutputs.has(bulkId),
        formats: [],
        needed: 0,
        onHand: 0,
        plannedBulk: 0,
        toMakeBulk: 0,
        uom: item?.uom || bulkUomForUnit(product.unit),
        orders: [],
        overdue: 0,
        components: [],
      }
      groups.set(bulkId, g)
    }
    g.formats.push(fmt)
    // The bulk a format commits is the larger of what is owed and what is planned:
    // `toMake` excludes the packs a packing plan will fill, but those packs draw
    // their bulk from the drink just the same when the plan runs.
    const owed = Math.max(0, d - rel)
    g.needed += Math.max(owed, planned) * (product.packVolume || 0)
  }

  const packsToMake = (g: DrinkRow) => g.formats.reduce((s, f) => s + f.toMake, 0)
  const withWork: DrinkRow[] = []
  let covered = 0
  for (const g of groups.values()) {
    g.orders = [...new Set(g.formats.flatMap((f) => f.orders))]
    g.overdue = new Set(g.formats.flatMap((f) => f.overdue)).size
    g.onHand = g.bulkId ? releasedBulk[g.bulkId] || 0 : 0
    g.plannedBulk = g.bulkId ? bulkIncoming[g.bulkId] || 0 : 0
    g.toMakeBulk = Math.max(0, g.needed - g.onHand - g.plannedBulk)
    // A drink with bulk to make or packs to fill stays on the page; one the
    // store and the board already cover between them steps out of the way.
    if (g.toMakeBulk > 0 || packsToMake(g) > 0) withWork.push(g)
    else covered++
    if (g.isMelange && g.toMakeBulk > 0) {
      const recipe = state.melanges.find((m) => m.outputItem === g.bulkId)
      g.components = (recipe?.components || []).map((c) => {
        const item = itemById.get(c.item)
        return {
          name: drinkName(item?.name || c.item),
          qty: (g.toMakeBulk * c.share) / 100,
          uom: item?.uom || 'Litre',
        }
      })
    }
  }
  withWork.sort((a, b) => b.toMakeBulk - a.toMakeBulk || packsToMake(b) - packsToMake(a))

  const orphanWork = orphans.filter((o) => packsToMake(o) > 0)
  return { drinks: [...withWork, ...orphanWork], covered, beyond }
}

/** Today and onwards soonest-first, then the past newest-first. */
export function orderedPlans(plans: ProductionPlan[]): ProductionPlan[] {
  const today = toDateKey()
  const upcoming = plans.filter((p) => p.date >= today)
  const past = plans.filter((p) => p.date < today)
  upcoming.sort((a, b) => a.date.localeCompare(b.date))
  past.sort((a, b) => b.date.localeCompare(a.date))
  return [...upcoming, ...past]
}

/** The plan list narrowed by the toolbar's search and status. */
export function filterPlans(ordered: ProductionPlan[], search: string, status: string): ProductionPlan[] {
  const q = search.trim().toLowerCase()
  return ordered.filter(
    (p) =>
      (!status || p.status === status) &&
      (!q || [p.id, p.product, p.stage, p.note || ''].join(' ').toLowerCase().includes(q)),
  )
}

/**
 * What the form's product field offers, by stage: pack products to fill, and of
 * the bulk items, only the ones that stage can actually make — a melange's output
 * is blended, every other bulk is extracted.
 */
export function productPicks(state: AppState, stage: PlanStage): string[] {
  if (stage === 'Packing') return state.products.map((p) => p.name)
  const melangeOutputs = new Set(state.melanges.map((m) => m.outputItem))
  return state.items
    .filter((i) => i.type === 'Semi Finished' && (stage === 'Melange') === melangeOutputs.has(i.id))
    .map((i) => i.name)
}

/** A plan raised for orders that have all since left Open is moot work. It still
 *  counts on the board (the packs would exist), so the flag is a nudge: cancel it
 *  and demand asks for the work again. */
export function servesClosed(orders: Order[], p: ProductionPlan): boolean {
  return (
    !!p.serves?.length &&
    (p.status === 'Planned' || p.status === 'In progress') &&
    p.serves.every((id) => orders.find((o) => o.id === id)?.status !== 'Open')
  )
}

/** The drink header's bulk line — the whole upstream story in one sentence:
 *  what the packs commit, and what is released or planned against it. */
export function bulkSentence(d: DrinkRow): string {
  const u = shortUom(d.uom)
  const supply = [
    d.onHand ? `${fmtQty(d.onHand)} ${u} released` : '',
    d.plannedBulk ? `${fmtQty(d.plannedBulk)} ${u} planned on the board` : '',
  ].filter(Boolean)
  if (d.toMakeBulk > 0)
    return `${fmtQty(d.needed)} ${u} of bulk to fill these packs · ${
      supply.join(' + ') || 'nothing released or planned yet'
    }`
  const surplus = d.onHand + d.plannedBulk - d.needed
  return `Bulk covered — ${supply.join(' + ') || 'no bulk needed'}${
    surplus > 0 ? ` · ${fmtQty(surplus)} ${u} beyond these packs` : ''
  }`
}
