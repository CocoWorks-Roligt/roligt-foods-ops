/**
 * extractionStage folds under test (WORKFLOW W8) — the queue's predicate is
 * pinned to pipelineStages' own count, the reason codes to the frozen seeds,
 * the lot pool to the write path's own Available rule, and runMassLines to
 * rulesGate.batchLines' shape (fallbacks included).
 */
import { describe, expect, it } from 'vitest'
import {
  extractionReasonCodes,
  massBalanceItemsOf,
  openExtractionRuns,
  pressableLots,
  runMassLines,
} from './extractionStage'
import { pipelineStages } from './pipeline'
import { migrateState } from './migrate'
import type { AppState, Batch, Item, StockRow } from '../types'

const coconut: Item = {
  id: 'RM-TCW',
  name: 'Tender Coconut',
  type: 'Raw Material',
  uom: 'Piece',
  lotControlled: true,
  reorder: 0,
  costMethod: 'FIFO',
} as unknown as Item

const item = (over: Partial<Item>): Item => ({ ...coconut, ...over }) as Item

const row = (over: Partial<StockRow>): StockRow =>
  ({
    item: 'RM-TCW',
    itemType: 'Raw Material',
    lot: 'LOT-1',
    location: 'Raw Store',
    status: 'Available',
    uom: 'Piece',
    qty: 100,
    value: 3500,
    unitCost: 35,
    ...over,
  }) as StockRow

const stateOf = (items: Item[]): AppState =>
  ({ items, ledger: [], grns: [], batches: [], melanges: [], config: {} }) as unknown as AppState

describe('pressableLots', () => {
  it('offers Available raw material pooled by lot, and nothing the post would refuse', () => {
    const state = stateOf([coconut, item({ id: 'RM-TEA', name: 'Tea', directUse: true })])
    const lots = pressableLots(state, [
      row({}),
      row({ lot: 'LOT-1', location: 'Cold Room', qty: 50 }), // same lot, second row — pooled
      row({ lot: 'LOT-2', status: 'Quarantine', qty: 40 }), // quarantine raw is not pressable (checkBatch: Available only)
      row({ lot: 'LOT-3', item: 'RM-TEA' }), // bought ready to use — blended, never pressed
      row({ lot: 'LOT-4', itemType: 'Semi Finished' }), // bulk, not raw
      row({ lot: 'LOT-5', qty: 0 }), // nothing left
    ])
    expect(lots).toHaveLength(1)
    expect(lots[0]).toMatchObject({ item: 'RM-TCW', lot: 'LOT-1', qty: 150, uom: 'Piece' })
  })
})

describe('extractionReasonCodes', () => {
  it('offers the extraction stage codes plus the any-stage one — never another stage\'s', () => {
    const codes = extractionReasonCodes().map((r) => r.code)
    expect(codes).toEqual(['rotten', 'cracked', 'overripe', 'pulp_loss', 'qc_reject'])
  })
})

describe('massBalanceItemsOf', () => {
  it('folds the conversion fields the close endpoint folds, dropping unset ones', () => {
    // the spread mirrors the B1 stamps the snapshot carries on the item doc
    const water = item({ id: 'SF-W', type: 'Semi Finished', uom: 'Litre' })
    const items = massBalanceItemsOf([coconut, water])
    const stamped = massBalanceItemsOf([
      { ...coconut, avgUnitWeight: 0.48 } as Item,
      { ...water, densityKgPerL: 1.02 } as Item,
    ])
    expect(items['RM-TCW']).toEqual({ uom: 'Piece' })
    expect(stamped['RM-TCW']).toEqual({ uom: 'Piece', avgUnitWeight: 0.48 })
    expect(stamped['SF-W']).toEqual({ uom: 'Litre', densityKgPerL: 1.02 })
  })
})

const run = (over: Partial<Batch>): Batch =>
  ({
    id: 'BAT-2026-0001',
    kind: 'Extraction',
    date: '2026-10-14T00:00:00Z',
    status: 'Pending',
    sourceLines: [],
    spoiled: 0,
    ...over,
  }) as unknown as Batch

describe('openExtractionRuns', () => {
  it('counts what the pipeline tile counts — including Closed as finished', () => {
    const batches = [
      run({ id: 'B-new', date: '2026-10-14T00:00:00Z', status: 'Pending' }),
      run({ id: 'B-old', date: '2026-10-10T00:00:00Z', status: 'On Hold' }),
      run({ id: 'B-rel', status: 'Released' }),
      run({ id: 'B-closed', status: 'Closed' }), // the close endpoint's own stamp
      run({ id: 'B-mel', kind: 'Melange', status: 'Pending' }), // not extraction's queue
      run({ id: 'B-legacy', date: '2026-10-12T00:00:00Z' }), // kind absent = extraction
    ]
    const queue = openExtractionRuns(batches)
    expect(queue.map((b) => b.id)).toEqual(['B-old', 'B-legacy', 'B-new']) // oldest first
    const state = migrateState({}) as AppState
    state.batches.push(...batches)
    const tile = pipelineStages(state, '2026-10-14').find((s) => s.id === 'extraction')
    expect(tile?.count).toBe(queue.length)
  })
})

describe('runMassLines', () => {
  it('reads a posted run\'s lines, an absent unit falling back to the item\'s own', () => {
    const items = massBalanceItemsOf([coconut, item({ id: 'SF-W', type: 'Semi Finished', uom: 'Litre' })])
    const { inputs, outputs } = runMassLines(
      run({
        sourceLines: [{ lot: 'LOT-1', item: 'RM-TCW', qty: 900, unitCost: 35 }],
        outputLines: [
          { item: 'SF-W', qty: 300, uom: 'Litre', costShare: 100 },
          { item: 'SF-M', qty: 80, uom: 'Kg', costShare: 0 },
        ],
      }),
      items,
    )
    expect(inputs).toEqual([{ item: 'RM-TCW', qty: 900, uom: 'Piece' }])
    expect(outputs).toEqual([
      { item: 'SF-W', qty: 300, uom: 'Litre' },
      { item: 'SF-M', qty: 80, uom: 'Kg' },
    ])
  })

  it('answers a legacy batch through its waterLitres/malaiKg pair', () => {
    const { inputs, outputs } = runMassLines(
      run({ sourceLines: [{ lot: 'LOT-1', qty: 500, uom: 'Piece', unitCost: 35 }], waterLitres: 180, malaiKg: 45 }),
    )
    expect(inputs).toEqual([{ item: '', qty: 500, uom: 'Piece' }])
    expect(outputs).toEqual([
      { item: '', qty: 180, uom: 'Litre' },
      { item: '', qty: 45, uom: 'Kg' },
    ])
  })
})
