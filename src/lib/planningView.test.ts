import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureState } from './reports/fixtures.ts'
import {
  bulkSentence,
  filterPlans,
  horizonWindow,
  orderedPlans,
  planDemand,
  productPicks,
  servesClosed,
  shortUom,
  type DrinkRow,
} from './planningView.ts'
import type { LedgerEntry, Order, Product, ProductionPlan } from '../types.ts'

/**
 * The demand table's arithmetic, pinned on one small plant. The fixture extends
 * the reports' golden plant — its ledger already says 3 released 5 L BiBs are on
 * hand — with the pack master the reports never had. The clock is pinned to noon
 * local on Monday 2026-09-14 so every due-date judgement is the same in any
 * timezone the suite runs in.
 */

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 14, 12, 0, 0))
})
afterEach(() => vi.useRealTimers())

const products: Product[] = [
  {
    id: 'FG-TCW-5L',
    name: 'OG Tender Coconut Water 5 L',
    type: 'BiB',
    size: 5,
    unit: 'L',
    packVolume: 5,
    shelfLifeDays: 45,
    bulkItem: 'SF-TCW-WATER',
    bom: [],
  },
  {
    id: 'FG-TCW-250ML',
    name: 'OG Tender Coconut Water 250 ml',
    type: 'Glass Bottle',
    size: 250,
    unit: 'ml',
    packVolume: 0.25,
    shelfLifeDays: 30,
    bulkItem: 'SF-TCW-WATER',
    bom: [],
  },
  {
    id: 'FG-ABC-1L',
    name: 'ABC Melange 1 L',
    type: 'BiB',
    size: 1,
    unit: 'L',
    packVolume: 1,
    shelfLifeDays: 40,
    bulkItem: 'SF-ABC',
    bom: [],
  },
]

const order = (id: string, over: Partial<Order>): Order => ({
  id,
  customerId: 'CUS-0001',
  customerName: 'Hyderabad Fresh',
  date: '2026-09-10',
  lines: [],
  status: 'Open',
  ...over,
})

const orders: Order[] = [
  // Overdue (due 2026-09-12, today is the 14th): always on the page.
  order('ORD-1', { dueDate: '2026-09-12', lines: [{ sku: 'FG-TCW-5L', qty: 40 }] }),
  order('ORD-2', { dueDate: '2026-09-20', lines: [{ sku: 'FG-TCW-250ML', qty: 16 }] }),
  // Dispatched: demand never reads it.
  order('ORD-3', { status: 'Dispatched', lines: [{ sku: 'FG-TCW-5L', qty: 100 }] }),
  // Undated: never hidden by a week either.
  order('ORD-4', { lines: [{ sku: 'GONE-SKU', qty: 5 }] }),
  order('ORD-5', { dueDate: '2026-09-20', lines: [{ sku: 'FG-ABC-1L', qty: 30 }] }),
]

/** 20 L of released coconut water — the ledger's bulk rows are all Available, so
 *  without this line there is nothing released to net against. */
const releasedBulk: LedgerEntry = {
  id: 'LED-REL-1',
  type: 'QC Release',
  doc: 'QC-2026-0001',
  item: 'SF-TCW-WATER',
  itemType: 'Semi Finished',
  lot: 'BAT-2026-0001',
  location: 'Bulk Store',
  status: 'Released',
  qtyIn: 20,
  qtyOut: 0,
  uom: 'Litre',
  unitCost: 96.55,
  time: '2026-09-08T10:00:00Z',
}

const plans: ProductionPlan[] = [
  // 10 packs on the board: demand must not ask for them twice.
  {
    id: 'PLN-PACK',
    date: '2026-09-15',
    stage: 'Packing',
    product: 'OG Tender Coconut Water 5 L',
    qty: 10,
    uom: 'Packs',
    status: 'Planned',
    createdOn: '2026-09-10',
  },
  // 50 L coming: nets the bulk, not the packs.
  {
    id: 'PLN-BULK',
    date: '2026-09-16',
    stage: 'Extraction',
    product: 'Coconut Water (bulk)',
    qty: 50,
    uom: 'Litre',
    status: 'In progress',
    createdOn: '2026-09-10',
  },
  // Done plans are posted stock already — counted on neither side.
  {
    id: 'PLN-DONE',
    date: '2026-09-13',
    stage: 'Extraction',
    product: 'Coconut Water (bulk)',
    qty: 99,
    uom: 'Litre',
    status: 'Done',
    createdOn: '2026-09-09',
  },
  {
    id: 'PLN-MEL',
    date: '2026-09-17',
    stage: 'Melange',
    product: 'ABC Melange (bulk)',
    qty: 10,
    uom: 'Litre',
    status: 'Planned',
    createdOn: '2026-09-10',
  },
]

function plantState(over: Partial<ReturnType<typeof fixtureState>> = {}) {
  const base = fixtureState()
  return {
    ...base,
    products,
    // The recipe gives the blend shares the components lines are pinned against.
    melanges: [
      {
        id: 'MEL-0001',
        name: 'ABC Melange',
        outputItem: 'SF-ABC',
        uom: 'Litre',
        components: [
          { item: 'SF-TCW-WATER', share: 50 },
          { item: 'SF-BEET', share: 50 },
        ],
        description: '',
        status: 'Active',
      },
    ],
    orders,
    productionPlans: plans,
    ledger: [...base.ledger, releasedBulk],
    ...over,
  }
}

/** A drink row with its formats, flattened enough to pin as a literal. */
const rowSummary = (d: DrinkRow) => ({
  key: d.key,
  name: d.name,
  isMelange: d.isMelange,
  needed: d.needed,
  onHand: d.onHand,
  plannedBulk: d.plannedBulk,
  toMakeBulk: d.toMakeBulk,
  uom: d.uom,
  orders: d.orders,
  overdue: d.overdue,
  components: d.components,
  formats: d.formats.map((f) => ({
    sku: f.sku,
    name: f.name,
    due: f.due,
    released: f.released,
    planned: f.planned,
    toMake: f.toMake,
    orders: f.orders,
    overdue: f.overdue,
  })),
})

describe('planDemand', () => {
  it('nets open orders both ways: released packs and board plans off the top, incoming bulk against the rest', () => {
    const res = planDemand(plantState(), null)
    expect(res.covered).toBe(0)
    expect(res.beyond).toBe(0)
    expect(res.drinks.map(rowSummary)).toEqual([
      {
        key: 'SF-TCW-WATER',
        name: 'Coconut Water',
        isMelange: false,
        // 40 owed − 3 released = 37 packs owed, but the board's 10 planned packs
        // commit their bulk too: max(37, 10) × 5 L, plus 16 × 0.25 L from the
        // bottles = 189 L needed; 20 released, 50 on the board → 119 to make.
        needed: 185 + 4,
        onHand: 20,
        plannedBulk: 50,
        toMakeBulk: 119,
        uom: 'Litre',
        orders: ['ORD-1', 'ORD-2'],
        overdue: 1,
        components: [],
        formats: [
          {
            sku: 'FG-TCW-5L',
            name: 'OG Tender Coconut Water 5 L',
            due: 40,
            released: 3,
            planned: 10,
            toMake: 27,
            orders: ['ORD-1'],
            overdue: ['ORD-1'],
          },
          {
            sku: 'FG-TCW-250ML',
            name: 'OG Tender Coconut Water 250 ml',
            due: 16,
            released: 0,
            planned: 0,
            toMake: 16,
            orders: ['ORD-2'],
            overdue: [],
          },
        ],
      },
      {
        key: 'SF-ABC',
        name: 'ABC Melange',
        isMelange: true,
        needed: 30,
        onHand: 0,
        plannedBulk: 10,
        toMakeBulk: 20,
        uom: 'Litre',
        orders: ['ORD-5'],
        overdue: 0,
        // The recipe's shares of the 20 L to blend.
        components: [
          { name: 'Coconut Water', qty: 10, uom: 'Litre' },
          { name: 'Beetroot Juice', qty: 10, uom: 'Litre' },
        ],
        formats: [
          {
            sku: 'FG-ABC-1L',
            name: 'ABC Melange 1 L',
            due: 30,
            released: 0,
            planned: 0,
            toMake: 30,
            orders: ['ORD-5'],
            overdue: [],
          },
        ],
      },
      // An order naming a sku the master lost still has to be seen.
      {
        key: 'orphan:GONE-SKU',
        name: 'GONE-SKU',
        isMelange: false,
        needed: 0,
        onHand: 0,
        plannedBulk: 0,
        toMakeBulk: 0,
        uom: '',
        orders: ['ORD-4'],
        overdue: 0,
        components: [],
        formats: [
          {
            sku: 'GONE-SKU',
            name: 'GONE-SKU',
            due: 5,
            released: 0,
            planned: 0,
            toMake: 5,
            orders: ['ORD-4'],
            overdue: [],
          },
        ],
      },
    ])
  })

  it('a drink the store and board already cover steps out of the way and is counted, not listed', () => {
    const res = planDemand(plantState({ orders: [] }), null)
    expect(res.drinks).toEqual([])
    expect(res.covered).toBe(1)
    expect(res.beyond).toBe(0)
  })

  it('a week window hides only future orders due beyond it — never overdue or undated ones', () => {
    const farOut = order('ORD-6', { dueDate: '2026-10-01', lines: [{ sku: 'FG-TCW-5L', qty: 1 }] })
    const res = planDemand(plantState({ orders: [...orders, farOut] }), {
      from: '2026-09-14',
      to: '2026-09-20',
    })
    expect(res.beyond).toBe(1)
    const fiveL = res.drinks
      .find((d) => d.key === 'SF-TCW-WATER')!
      .formats.find((f) => f.sku === 'FG-TCW-5L')!
    // ORD-6's pack is beyond the window; ORD-1's overdue 40 still count in full.
    expect(fiveL.due).toBe(40)
    expect(fiveL.toMake).toBe(27)
    // The undated orphan order stayed visible.
    expect(res.drinks.some((d) => d.key === 'orphan:GONE-SKU')).toBe(true)
  })
})

describe('horizonWindow', () => {
  it('all means every open order', () => {
    expect(horizonWindow('all')).toBeNull()
  })

  it('a horizon is a Monday-to-Sunday week; next is one week on', () => {
    // Pinned clock: Monday 2026-09-14.
    expect(horizonWindow('week')).toEqual({ from: '2026-09-14', to: '2026-09-20' })
    expect(horizonWindow('next')).toEqual({ from: '2026-09-21', to: '2026-09-27' })
  })
})

describe('orderedPlans', () => {
  const plans: ProductionPlan[] = [
    { id: 'P3', date: '2026-09-20', stage: 'Extraction', product: 'x', qty: 1, uom: 'Litre', status: 'Planned', createdOn: '2026-09-10' },
    { id: 'P1', date: '2026-09-10', stage: 'Extraction', product: 'x', qty: 1, uom: 'Litre', status: 'Planned', createdOn: '2026-09-10' },
    { id: 'P2', date: '2026-09-14', stage: 'Extraction', product: 'x', qty: 1, uom: 'Litre', status: 'Planned', createdOn: '2026-09-10' },
    { id: 'P5', date: '2026-09-12', stage: 'Extraction', product: 'x', qty: 1, uom: 'Litre', status: 'Planned', createdOn: '2026-09-10' },
    { id: 'P4', date: '2026-09-15', stage: 'Extraction', product: 'x', qty: 1, uom: 'Litre', status: 'Planned', createdOn: '2026-09-10' },
  ]

  it('today and onwards soonest-first, then the past newest-first', () => {
    expect(orderedPlans(plans).map((p) => p.id)).toEqual(['P2', 'P4', 'P3', 'P5', 'P1'])
  })
})

describe('filterPlans', () => {
  const plans: ProductionPlan[] = [
    { id: 'PLN-1', date: '2026-09-15', stage: 'Packing', product: 'OG 5 L', qty: 10, uom: 'Packs', status: 'Planned', note: 'for ORD-1', createdOn: '2026-09-10' },
    { id: 'PLN-2', date: '2026-09-16', stage: 'Extraction', product: 'Coconut Water (bulk)', qty: 50, uom: 'Litre', status: 'In progress', createdOn: '2026-09-10' },
    { id: 'PLN-3', date: '2026-09-13', stage: 'Packing', product: 'ABC 1 L', qty: 8, uom: 'Packs', status: 'Done', createdOn: '2026-09-09' },
  ]

  it('no search and no status shows everything', () => {
    expect(filterPlans(plans, '', '').map((p) => p.id)).toEqual(['PLN-1', 'PLN-2', 'PLN-3'])
  })

  it('searches id, product, stage and note, and narrows by status', () => {
    expect(filterPlans(plans, 'coconut water', '').map((p) => p.id)).toEqual(['PLN-2'])
    expect(filterPlans(plans, 'ord-1', '').map((p) => p.id)).toEqual(['PLN-1'])
    expect(filterPlans(plans, '', 'Done').map((p) => p.id)).toEqual(['PLN-3'])
    expect(filterPlans(plans, '  ', 'Planned').map((p) => p.id)).toEqual(['PLN-1'])
  })
})

describe('productPicks', () => {
  it('packing offers pack products; extraction offers only non-melange bulks; melange only blends', () => {
    const state = plantState()
    expect(productPicks(state, 'Packing')).toEqual([
      'OG Tender Coconut Water 5 L',
      'OG Tender Coconut Water 250 ml',
      'ABC Melange 1 L',
    ])
    expect(productPicks(state, 'Extraction')).toEqual([
      'Coconut Water (bulk)',
      'Malai (bulk)',
      'Beetroot Juice (bulk)',
    ])
    expect(productPicks(state, 'Melange')).toEqual(['ABC Melange (bulk)'])
  })
})

describe('servesClosed', () => {
  const orders: Order[] = [
    order('ORD-OPEN', { status: 'Open' }),
    order('ORD-GONE', { status: 'Dispatched' }),
  ]
  const plan = (over: Partial<ProductionPlan>): ProductionPlan => ({
    id: 'PLN-X',
    date: '2026-09-15',
    stage: 'Packing',
    product: 'x',
    qty: 1,
    uom: 'Packs',
    status: 'Planned',
    createdOn: '2026-09-10',
    ...over,
  })

  it('only when every served order has left Open and the plan itself still can act', () => {
    expect(servesClosed(orders, plan({ serves: ['ORD-GONE'] }))).toBe(true)
    // An order still open keeps the plan live…
    expect(servesClosed(orders, plan({ serves: ['ORD-OPEN', 'ORD-GONE'] }))).toBe(false)
    // …and so does a plan that is already finished or was never linked.
    expect(servesClosed(orders, plan({ serves: ['ORD-GONE'], status: 'Done' }))).toBe(false)
    expect(servesClosed(orders, plan({}))).toBe(false)
    // A served id no order answers for counts as closed.
    expect(servesClosed(orders, plan({ serves: ['ORD-VANISHED'] }))).toBe(true)
  })
})

describe('bulkSentence', () => {
  it('says what the packs commit and what stands against it', () => {
    expect(
      bulkSentence({ needed: 189, onHand: 20, plannedBulk: 50, toMakeBulk: 119, uom: 'Litre' } as DrinkRow),
    ).toBe('189 L of bulk to fill these packs · 20 L released + 50 L planned on the board')
  })

  it('a covered drink says so, with its surplus', () => {
    expect(
      bulkSentence({ needed: 10, onHand: 20, plannedBulk: 0, toMakeBulk: 0, uom: 'Litre' } as DrinkRow),
    ).toBe('Bulk covered — 20 L released · 10 L beyond these packs')
  })
})

describe('shortUom', () => {
  it('kg when weighed, L when poured', () => {
    expect(shortUom('Kg')).toBe('kg')
    expect(shortUom('Litre')).toBe('L')
  })
})
