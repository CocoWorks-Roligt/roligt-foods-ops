import { describe, expect, it } from 'vitest'
import { fixtureState } from './reports/fixtures.ts'
import {
  allottedFor,
  allocationsFromPicks,
  drinkCatalog,
  filterOrders,
  linesByDrink,
  releasedPacksBySku,
  resolveBlocks,
  seedAllocations,
  shortLineOf,
  type OrderDraft,
  type ReleasedLot,
} from './ordersView.ts'
import { checkOrderDispatch } from './posting.ts'
import { rowKey, stockRows } from './stock.ts'
import { migrateState } from './migrate.ts'
import type { Item, Order, Product, StockRow } from '../types.ts'

/**
 * The orders page's derivations, pinned on a small extension of the reports'
 * golden plant. Released lots come in as plain StockRows the way the app
 * context's memo hands them over, so what is pinned is what the dispatch
 * modal would offer.
 */

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

const state = { ...fixtureState(), products }
const itemById = new Map<string, Item>(state.items.map((i) => [i.id, i]))
const productById = new Map<string, Product>(products.map((p) => [p.id, p]))
const melangeOutputs = new Set(['SF-ABC'])

describe('drinkCatalog', () => {
  it('formats grouped under their drink, largest first, drinks by name', () => {
    expect(drinkCatalog(products, itemById, melangeOutputs)).toEqual([
      {
        bulkId: 'SF-ABC',
        name: 'ABC Melange',
        isMelange: true,
        formats: [products[2]],
      },
      {
        bulkId: 'SF-TCW-WATER',
        name: 'Coconut Water',
        isMelange: false,
        formats: [products[0], products[1]],
      },
    ])
  })
})

describe('releasedPacksBySku', () => {
  const row = (over: Partial<StockRow>): StockRow => ({
    item: 'FG-TCW-5L',
    itemType: 'Finished Goods',
    lot: 'BAT-2026-0001',
    location: 'Cold Room',
    status: 'Released',
    uom: 'Pack',
    qty: 1,
    value: 0,
    unitCost: 0,
    ...over,
  })

  it('released packs only, hold areas never, oldest expiry first', () => {
    const by = releasedPacksBySku(state, [
      row({ lot: 'BAT-NEW', expiry: '2026-12-30', qty: 6 }),
      row({ lot: 'BAT-OLD', expiry: '2026-10-30', qty: 3 }),
      // Hold-area stock is not offerable to a dispatch.
      row({ lot: 'BAT-HELD', location: 'Reject Hold', expiry: '2026-09-01', qty: 9 }),
      // Not released, not finished, not really there.
      row({ lot: 'BAT-Q', status: 'Quarantine', qty: 4 }),
      row({ lot: 'BAT-BULK', itemType: 'Semi Finished', item: 'SF-TCW-WATER', qty: 20 }),
      row({ lot: 'BAT-ZERO', qty: 0 }),
    ])
    expect(by.size).toBe(1)
    expect(by.get('FG-TCW-5L')).toEqual([
      { item: 'FG-TCW-5L', lot: 'BAT-OLD', location: 'Cold Room', qty: 3, expiry: '2026-10-30', shownExpiry: '2026-10-30' },
      { item: 'FG-TCW-5L', lot: 'BAT-NEW', location: 'Cold Room', qty: 6, expiry: '2026-12-30', shownExpiry: '2026-12-30' },
    ])
  })
})

describe('filterOrders', () => {
  const order = (id: string, over: Partial<Order>): Order => ({
    id,
    customerId: 'CUS-0001',
    customerName: 'Hyderabad Fresh',
    date: '2026-09-10',
    lines: [],
    status: 'Open',
    ...over,
  })
  const orders = [
    order('ORD-2026-0001', { date: '2026-09-07', status: 'Dispatched', challan: 'DC0001/2026' }),
    order('ORD-2026-0002', { date: '2026-09-13', customerName: 'Fresh Mart' }),
  ]

  it('newest first, then the search over order, customer, status and challan', () => {
    expect(filterOrders(orders, '').map((o) => o.id)).toEqual(['ORD-2026-0002', 'ORD-2026-0001'])
    expect(filterOrders(orders, 'dc0001').map((o) => o.id)).toEqual(['ORD-2026-0001'])
    expect(filterOrders(orders, '  mart  ').map((o) => o.id)).toEqual(['ORD-2026-0002'])
    expect(filterOrders(orders, 'dispatched').map((o) => o.id)).toEqual(['ORD-2026-0001'])
  })
})

describe('resolveBlocks', () => {
  const drinkById = new Map(drinkCatalog(products, itemById, melangeOutputs).map((d) => [d.bulkId, d]))
  const itemName = (id: string) => `Name(${id})`
  const resolve = (draft: OrderDraft) => resolveBlocks(draft, drinkById, productById, itemById, melangeOutputs, itemName)

  it('the form as blocks: chosen formats, orphans that stayed, and quantities promoted to orphans', () => {
    const draft: OrderDraft = {
      customerId: '',
      date: '',
      dueDate: '',
      notes: '',
      picked: ['SF-TCW-WATER', 'orphan:FG-BACK', 'orphan:FG-STAYS'],
      formats: { 'SF-TCW-WATER': ['FG-TCW-5L', 'FG-DELETED'] },
      qtys: { 'FG-TCW-5L': 10, 'FG-DELETED': 4, 'FG-NEW': 2 },
    }
    const masterById = new Map([...productById, ['FG-BACK', products[0]] as const])
    const blocks = resolveBlocks(draft, drinkById, masterById, itemById, melangeOutputs, itemName)
    expect(blocks).toEqual([
      {
        key: 'SF-TCW-WATER',
        name: 'Coconut Water',
        isMelange: false,
        // FG-DELETED left the master: dropped from the drink, carried by the
        // orphan pass below because its quantity is real intent.
        formats: [products[0]],
      },
      // Back in the master — its drink owns it again, so the key goes quiet.
      // orphan:FG-BACK produced no block.
      { key: 'orphan:FG-STAYS', name: 'Name(FG-STAYS)', isMelange: false, formats: [], sku: 'FG-STAYS' },
      { key: 'orphan:FG-DELETED', name: 'Name(FG-DELETED)', isMelange: false, formats: [], sku: 'FG-DELETED' },
      { key: 'orphan:FG-NEW', name: 'Name(FG-NEW)', isMelange: false, formats: [], sku: 'FG-NEW' },
    ])
  })

  it('an orphan with no quantity is not promoted', () => {
    const blocks = resolve({
      customerId: '', date: '', dueDate: '', notes: '',
      picked: [], formats: {}, qtys: { 'FG-NEW': '' },
    })
    expect(blocks).toEqual([])
  })
})

describe('linesByDrink', () => {
  it('lines by drink in first-seen order, off-master lines under their own heading', () => {
    const res = linesByDrink(
      [
        { sku: 'FG-TCW-5L', qty: 40 },
        { sku: 'FG-TCW-250ML', qty: 16 },
        { sku: 'FG-GONE', qty: 5 },
        { sku: 'FG-ABC-1L', qty: 30 },
      ],
      productById,
      itemById,
      melangeOutputs,
    )
    expect(res.drinks).toEqual([
      {
        key: 'SF-TCW-WATER',
        name: 'Coconut Water',
        isMelange: false,
        lines: [
          { sku: 'FG-TCW-5L', qty: 40 },
          { sku: 'FG-TCW-250ML', qty: 16 },
        ],
      },
      {
        key: 'SF-ABC',
        name: 'ABC Melange',
        isMelange: true,
        lines: [{ sku: 'FG-ABC-1L', qty: 30 }],
      },
    ])
    expect(res.off).toEqual([{ sku: 'FG-GONE', qty: 5 }])
  })
})

describe('seedAllocations', () => {
  const lots: ReleasedLot[] = [
    { item: 'FG-TCW-5L', lot: 'BAT-OLD', location: 'Cold Room', qty: 10, expiry: '2026-10-30' },
    { item: 'FG-TCW-5L', lot: 'BAT-NEW', location: 'Cold Room', qty: 6, expiry: '2026-12-30' },
  ]
  const availableFor = new Map([['FG-TCW-5L', lots]])

  it('fills from the oldest stock first, never over the line', () => {
    // 12 wanted: all 10 of the old lot, then 2 of the new.
    expect(seedAllocations([{ sku: 'FG-TCW-5L', qty: 12 }], availableFor)).toEqual({
      'FG-TCW-5L': { [rowKey(lots[0])]: 10, [rowKey(lots[1])]: 2 },
    })
    // 5 wanted: the old lot alone.
    expect(seedAllocations([{ sku: 'FG-TCW-5L', qty: 5 }], availableFor)).toEqual({
      'FG-TCW-5L': { [rowKey(lots[0])]: 5 },
    })
  })

  it('a sku with nothing released seeds an empty pick set, not a gap', () => {
    expect(seedAllocations([{ sku: 'FG-NONE', qty: 5 }], availableFor)).toEqual({ 'FG-NONE': {} })
  })
})

describe('allocationsFromPicks / allottedFor / shortLineOf', () => {
  const lots: ReleasedLot[] = [
    { item: 'FG-TCW-5L', lot: 'BAT-OLD', location: 'Cold Room', qty: 10, expiry: '2026-10-30' },
    { item: 'FG-TCW-5L', lot: 'BAT-NEW', location: 'Cold Room', qty: 6, expiry: '2026-12-30' },
  ]
  const lines = [
    { sku: 'FG-TCW-5L', qty: 12 },
    { sku: 'FG-TCW-250ML', qty: 4 },
  ]
  const picks = seedAllocations(lines, new Map([['FG-TCW-5L', lots]]))

  it('unpacks the picks state into the dispatch write\'s allocations — row identity intact', () => {
    expect(allocationsFromPicks(lines, picks)).toEqual([
      {
        sku: 'FG-TCW-5L',
        picks: [
          // The rowKey carries lot + location + expiry — the whole row — and the
          // allocation puts each part back.
          { lot: 'BAT-OLD', location: 'Cold Room', qty: 10, expiry: '2026-10-30' },
          { lot: 'BAT-NEW', location: 'Cold Room', qty: 2, expiry: '2026-12-30' },
        ],
      },
      { sku: 'FG-TCW-250ML', picks: [] },
    ])
  })

  it('the seeded picks are exactly what the write\'s own check accepts', () => {
    // Reconciliation pin: seed → unpack → checkOrderDispatch, the same chain the
    // dispatch form posts through. A covered order must pass with the rows in
    // oldest-expiry-first order — the pool's own sort.
    const s = migrateState({})
    s.ledger.push(
      {
        id: 'L1',
        type: 'Receipt',
        doc: 'RUN-1',
        item: 'FG-TCW-5L',
        itemType: 'Finished Goods',
        lot: 'BAT-OLD',
        location: 'Cold Room',
        status: 'Released',
        uom: 'Pack',
        qtyIn: 10,
        qtyOut: 0,
        unitCost: 20,
        time: '2026-10-05T04:00:00.000Z',
        expiry: '2026-10-30',
      },
      {
        id: 'L2',
        type: 'Receipt',
        doc: 'RUN-1',
        item: 'FG-TCW-5L',
        itemType: 'Finished Goods',
        lot: 'BAT-NEW',
        location: 'Cold Room',
        status: 'Released',
        uom: 'Pack',
        qtyIn: 6,
        qtyOut: 0,
        unitCost: 20,
        time: '2026-10-05T04:00:00.000Z',
        expiry: '2026-12-30',
      },
    )
    const lines = [{ sku: 'FG-TCW-5L', qty: 12 }]
    const picks = seedAllocations(lines, releasedPacksBySku(s, stockRows(s)))
    const check = checkOrderDispatch(s, { lines }, allocationsFromPicks(lines, picks))
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.rows).toEqual([
        { sku: 'FG-TCW-5L', lot: 'BAT-OLD', location: 'Cold Room', qty: 10, expiry: '2026-10-30' },
        { sku: 'FG-TCW-5L', lot: 'BAT-NEW', location: 'Cold Room', qty: 2, expiry: '2026-12-30' },
      ])
    }
  })

  it('allottedFor sums the picks; shortLineOf names the first line not exactly filled', () => {
    expect(allottedFor(picks, 'FG-TCW-5L')).toBe(12)
    expect(allottedFor(picks, 'FG-TCW-250ML')).toBe(0)
    // The 250 ml line is short — the order cannot go out.
    expect(shortLineOf(lines, picks)?.sku).toBe('FG-TCW-250ML')
    // Fully allotted: no short line, the order can go.
    const full = { ...picks, 'FG-TCW-250ML': { 'x': 4 } }
    expect(shortLineOf(lines, full)).toBeUndefined()
    // Over is as refused as under — an order goes out complete.
    const over = { ...picks, 'FG-TCW-5L': { [rowKey(lots[0])]: 11 } }
    expect(shortLineOf(lines, over)?.sku).toBe('FG-TCW-5L')
  })
})
