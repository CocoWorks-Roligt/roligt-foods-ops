/**
 * orderStage folds under test (WORKFLOW W14) — the desk's queue is pinned to
 * pipelineStages' own Orders count (open orders), soonest ship-by first with
 * the overdue ones at the head and the undated last; fill state reads the
 * dispatch path's own pool. draftFromOrder/linesFromDraft round-trip an
 * order's lines through the form's draft — orphans included.
 */
import { describe, expect, it } from 'vitest'
import { openOrderRows } from './orderStage'
import { pipelineStages } from './pipeline'
import { draftFromOrder, linesFromDraft, resolveBlocks, drinkCatalog } from './ordersView'
import { migrateState } from './migrate'
import type { AppState, Item, Order, Product } from '../types'

const TODAY = '2026-10-14'

const order = (id: string, over: Partial<Order> = {}): Order =>
  ({
    id,
    customerId: 'CUS-1',
    customerName: 'Cafe Coco',
    date: '2026-10-12T04:00:00.000Z',
    dueDate: '2026-10-16',
    lines: [{ sku: 'SKU-5L', qty: 10 }],
    status: 'Open',
    notes: '',
    ...over,
  }) as unknown as Order

describe('openOrderRows', () => {
  it('queues open orders soonest ship-by first, overdue at the head, undated last — pinned to the tile', () => {
    const s: AppState = migrateState({})
    s.orders.push(
      order('ORD-1', { dueDate: '2026-10-20' }), // next out
      order('ORD-2', { dueDate: '2026-10-10' }), // OVERDUE — first
      order('ORD-3', { dueDate: undefined }), // no ship-by — last
      order('ORD-4', { dueDate: '2026-10-15', status: 'Dispatched' }), // done — not the desk's
    )
    const queue = openOrderRows(s, TODAY)
    expect(queue.map((q) => q.order.id)).toEqual(['ORD-2', 'ORD-1', 'ORD-3'])
    expect(queue[0].overdue).toBe(true)
    expect(queue[1].overdue).toBe(false)
    // pinned to the tile: whatever the desk queues is what the board counts
    const tile = pipelineStages(s, TODAY).find((x) => x.id === 'orders')
    expect(tile?.count).toBe(queue.length)
    expect(tile?.flag?.kind).toBe('overdue') // the overdue order is why the tile flags
  })

  it('holds each line against the released packs a dispatch would draw from', () => {
    const s: AppState = migrateState({})
    s.orders.push(
      order('ORD-1', {
        lines: [
          { sku: 'SKU-5L', qty: 10 },
          { sku: 'SKU-250', qty: 4 },
        ],
      }),
    )
    s.ledger.push(
      {
        id: 'L1',
        type: 'Receipt',
        doc: 'RUN-1',
        item: 'SKU-5L',
        itemType: 'Finished Goods',
        lot: 'LOT-1',
        location: 'Cold Room A',
        status: 'Released',
        uom: 'Piece',
        qtyIn: 6,
        qtyOut: 0,
        unitCost: 10,
        time: '2026-10-01T00:00:00.000Z',
      },
      // quarantine packs are not offerable — the dispatch path's own pool
      {
        id: 'L2',
        type: 'Receipt',
        doc: 'RUN-1',
        item: 'SKU-250',
        itemType: 'Finished Goods',
        lot: 'LOT-1',
        location: 'Cold Room A',
        status: 'Quarantine',
        uom: 'Piece',
        qtyIn: 50,
        qtyOut: 0,
        unitCost: 10,
        time: '2026-10-01T00:00:00.000Z',
      },
    )
    const [q] = openOrderRows(s, TODAY)
    expect(q.lines.map((l) => ({ sku: l.sku, onHand: l.onHand, short: l.short }))).toEqual([
      { sku: 'SKU-5L', onHand: 6, short: true },
      { sku: 'SKU-250', onHand: 0, short: true },
    ])
    expect(q.fillable).toBe(false)
  })
})

describe('draftFromOrder / linesFromDraft', () => {
  it('round-trips an order’s lines through the draft — orphans keep their own block', () => {
    const s: AppState = migrateState({})
    const item: Item = { id: 'BULK-TCW', name: 'Tender Coconut Water' } as unknown as Item
    const p5l: Product = {
      id: 'SKU-5L',
      name: 'TCW 5 L',
      bom: [],
      packId: '',
      bulkItem: 'BULK-TCW',
      shelfLifeDays: 30,
      packVolume: 5,
    } as unknown as Product
    s.items.push(item)
    s.products.push(p5l)
    const productById = new Map(s.products.map((p) => [p.id, p]))
    const source = order('ORD-1', {
      lines: [
        { sku: 'SKU-5L', qty: 10 },
        { sku: 'SKU-GONE', qty: 2 }, // left the master — still a real order line
      ],
    })
    const draft = draftFromOrder(source, productById)
    const itemById = new Map(s.items.map((i) => [i.id, i]))
    const blocks = resolveBlocks(
      draft,
      new Map(drinkCatalog(s.products, itemById, new Set()).map((d) => [d.bulkId, d])),
      productById,
      itemById,
      new Set(),
      (id) => id,
    )
    expect(blocks.map((b) => b.key)).toEqual(['BULK-TCW', 'orphan:SKU-GONE'])
    expect(linesFromDraft(blocks, draft.qtys)).toEqual(source.lines)
  })

  it('never writes a line for an unquantified format', () => {
    expect(
      linesFromDraft(
        [
          { key: 'BULK-1', name: 'A', isMelange: false, formats: [{ id: 'SKU-1' } as Product, { id: 'SKU-2' } as Product] },
          { key: 'orphan:SKU-3', name: 'B', isMelange: false, formats: [], sku: 'SKU-3' },
        ],
        { 'SKU-1': 4, 'SKU-2': '' },
      ),
    ).toEqual([{ sku: 'SKU-1', qty: 4 }])
  })
})
