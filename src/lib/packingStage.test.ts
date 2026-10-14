/**
 * packingStage folds under test (WORKFLOW W10) — every pool is pinned to the
 * write path's own rule: the bulk pool to what checkPacking draws (DRAWABLE —
 * rejected bulk is invisible, as its refusal says), the pack list to the
 * product master's own (retired hidden), and the loose-pouch note to the
 * formats §3.3-6 names.
 */
import { describe, expect, it } from 'vitest'
import { bulkByBatch, fillableBulk, isLoosePouch, packableBatches, packsForBulk } from './packingStage'
import type { AppState, Batch, Item, Product, StockRow } from '../types'

const water: Item = {
  id: 'SF-TCW-WATER',
  name: 'Coconut Water (bulk)',
  type: 'Semi Finished',
  uom: 'Litre',
  lotControlled: true,
  reorder: 0,
  costMethod: 'FIFO',
} as unknown as Item

const item = (over: Partial<Item>): Item => ({ ...water, ...over }) as Item

const row = (over: Partial<StockRow>): StockRow =>
  ({
    item: 'SF-TCW-WATER',
    itemType: 'Semi Finished',
    lot: 'BAT-2026-0001',
    location: 'Cold Room',
    status: 'Available',
    uom: 'Litre',
    qty: 40,
    value: 800,
    unitCost: 20,
    ...over,
  }) as StockRow

const product = (over: Partial<Product>): Product =>
  ({
    id: 'FG-0001',
    name: 'Coconut Water 1 L',
    type: 'BiB',
    size: 1,
    unit: 'L',
    packVolume: 1,
    shelfLifeDays: 180,
    bom: [],
    bulkItem: 'SF-TCW-WATER',
    packName: '1 L BiB',
    ...over,
  }) as Product

const stateOf = (items: Item[], products: Product[]): AppState =>
  ({ items, products, ledger: [], batches: [] }) as unknown as AppState

describe('fillableBulk', () => {
  it('offers only bulk something is packed from — a retired-only pack still counts', () => {
    const state = stateOf(
      [
        water,
        item({ id: 'SF-TCW-MALAI', name: 'Coconut Malai (bulk)', uom: 'Kg' }),
        item({ id: 'RM-TEA', name: 'Tea Powder', type: 'Raw Material', uom: 'Kg' }),
      ],
      [
        product({}),
        product({ id: 'FG-0002', bulkItem: 'SF-TCW-MALAI', packName: '1 Kg pouch', type: 'Pouch' }),
        product({ id: 'FG-0003', retired: true, bulkItem: 'SF-TCW-WATER', packName: '250 ml Glass Bottle', type: 'Glass Bottle' }),
      ],
    )
    // malai's only pack is retired, yet the bulk stays offered (the Classic
    // form's own rule — its empty state explains, the bulk does not vanish)
    expect(fillableBulk(state).map((b) => b.id)).toEqual(['SF-TCW-WATER', 'SF-TCW-MALAI'])
  })
})

describe('bulkByBatch', () => {
  it('pools the rows checkPacking itself draws — rejected bulk is invisible', () => {
    const held = bulkByBatch(
      [
        row({}),
        row({ lot: 'BAT-2026-0001', location: 'Cold Room 2', qty: 10 }), // same lot, second area — pooled
        row({ lot: 'BAT-2026-0002', status: 'Quarantine', qty: 5 }), // quarantine IS drawable
        row({ lot: 'BAT-2026-0003', status: 'Rejected', qty: 99 }), // the gate's own blind spot, kept
        row({ lot: 'BAT-2026-0004', qty: 0 }), // nothing left
        row({ item: 'SF-TCW-MALAI', lot: 'BAT-2026-0005', uom: 'Kg', qty: 12 }), // another bulk's lot
      ],
      'SF-TCW-WATER',
    )
    expect(held.get('BAT-2026-0001')).toBe(50)
    expect(held.get('BAT-2026-0002')).toBe(5)
    expect(held.has('BAT-2026-0003')).toBe(false)
    expect(held.has('BAT-2026-0004')).toBe(false)
    expect(held.has('BAT-2026-0005')).toBe(false)
  })
})

describe('packableBatches', () => {
  it('offers batches with bulk to pack, newest first', () => {
    const batch = (id: string, date: string): Batch => ({ id, date, kind: 'Extraction', status: 'Released' }) as Batch
    const batches = [
      batch('BAT-2026-0001', '2026-10-10T00:00:00Z'),
      batch('BAT-2026-0002', '2026-10-14T00:00:00Z'),
      batch('BAT-2026-0003', '2026-10-12T00:00:00Z'),
    ]
    const held = new Map([
      ['BAT-2026-0001', 40],
      ['BAT-2026-0002', 0.000001], // under QTY_EPSILON — nothing to actually pack
      ['BAT-2026-0003', 5],
    ])
    expect(packableBatches(batches, held).map((b) => b.id)).toEqual(['BAT-2026-0003', 'BAT-2026-0001'])
  })
})

describe('packsForBulk', () => {
  it('offers the bulk’s own packs, retired hidden, clashing labels disambiguated', () => {
    const packs = packsForBulk(
      [
        product({}),
        product({ id: 'FG-0004', name: 'Coconut Water 1 L (Export)', packName: '1 L BiB' }), // same label — both named apart
        product({ id: 'FG-0007', packName: '250 ml Glass Bottle', type: 'Glass Bottle' }), // unique label stays plain
        product({ id: 'FG-0005', retired: true }), // retired packs never fill a new run
        product({ id: 'FG-0006', bulkItem: 'SF-TCW-MALAI', packName: '1 Kg pouch' }), // another bulk's recipe
      ],
      'SF-TCW-WATER',
    )
    expect(packs.map((p) => p.id)).toEqual(['FG-0001', 'FG-0004', 'FG-0007'])
    // a clash names BOTH packs (the Classic dropdown's own rule); a unique label stays plain
    expect(packs[0].label).toBe('1 L BiB · Coconut Water 1 L')
    expect(packs[1].label).toBe('1 L BiB · Coconut Water 1 L (Export)')
    expect(packs[2].label).toBe('250 ml Glass Bottle')
  })
})

describe('isLoosePouch', () => {
  it('names the pouch formats §3.3-6 stores loose — bottles are the standard flow', () => {
    expect(isLoosePouch('BiB')).toBe(true)
    expect(isLoosePouch('Pouch')).toBe(true)
    expect(isLoosePouch('Glass Bottle')).toBe(false)
    expect(isLoosePouch('PET Bottle')).toBe(false)
  })
})
