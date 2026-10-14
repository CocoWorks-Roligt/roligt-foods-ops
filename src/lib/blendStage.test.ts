/**
 * blendStage folds under test (WORKFLOW W9) — the queue's predicate is pinned
 * to pipelineStages' own count (the Blending tile), the reason codes to the
 * frozen seeds, and the component pool to the write path's own DRAWABLE rule,
 * which is what keeps a coconut (press-only stock) out of a milk run.
 */
import { describe, expect, it } from 'vitest'
import { activeRecipes, blendReasonCodes, blendableLots, openBlendRuns } from './blendStage'
import { pipelineStages } from './pipeline'
import { migrateState } from './migrate'
import type { AppState, Batch, Item, StockRow } from '../types'

const coconut: Item = {
  id: 'RM-TCW-COCO',
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
    item: 'SF-TCW-MALAI',
    itemType: 'Semi Finished',
    lot: 'BAT-2026-0001',
    location: 'Cold Room',
    status: 'Available',
    uom: 'Kg',
    qty: 40,
    value: 1600,
    unitCost: 40,
    ...over,
  }) as StockRow

const stateOf = (items: Item[]): AppState =>
  ({ items, ledger: [], grns: [], batches: [], melanges: [], config: {} }) as unknown as AppState

describe('blendableLots', () => {
  it('offers drawable bulk and bought-ready raw, pooled by lot — never press-only raw', () => {
    const state = stateOf([
      coconut,
      item({ id: 'RM-STAB', name: 'Stabilizer', directUse: true, uom: 'Kg' }),
      item({ id: 'SF-TCW-MALAI', name: 'Coconut Malai', type: 'Semi Finished', uom: 'Kg' }),
    ])
    const lots = blendableLots(state, [
      row({}),
      row({ lot: 'BAT-2026-0002', location: 'Cold Room 2', qty: 10 }), // same item, second lot
      row({ lot: 'BAT-2026-0003', status: 'Quarantine', qty: 5 }), // quarantine bulk IS drawable (DRAWABLE says so)
      row({ lot: 'BAT-2026-0004', status: 'Rejected', qty: 5 }), // rejected is not
      row({ item: 'RM-TCW-COCO', itemType: 'Raw Material', lot: 'LOT-C', uom: 'Piece', qty: 100 }), // a coconut is never a blend component
      row({ item: 'RM-STAB', itemType: 'Raw Material', lot: 'LOT-S', uom: 'Kg', qty: 2 }), // bought ready to use — blended
      row({ lot: 'BAT-2026-0005', qty: 0 }), // nothing left
    ])
    // poolByLot owns the order; membership is the law
    expect(lots.map((l) => `${l.item}|${l.lot}`).sort()).toEqual(
      [
        'SF-TCW-MALAI|BAT-2026-0001',
        'SF-TCW-MALAI|BAT-2026-0002',
        'SF-TCW-MALAI|BAT-2026-0003',
        'RM-STAB|LOT-S',
      ].sort(),
    )
  })
})

describe('blendReasonCodes', () => {
  it("offers the blend stage codes plus the any-stage one — never another stage's", () => {
    expect(blendReasonCodes().map((r) => r.code)).toEqual(['spillage', 'burst_pouch', 'line_loss', 'qc_reject'])
  })
})

describe('activeRecipes', () => {
  it('offers the plant\'s active recipes — retired ones are not offered', () => {
    const melanges = [
      { id: 'M-1', name: 'Coconut Milk', status: 'Active' },
      { id: 'M-2', name: 'Old Smoothie', status: 'Retired' },
      { id: 'M-3', name: 'Iced Tea', status: 'active' }, // case matters: only the stamped word counts
    ] as AppState['melanges']
    expect(activeRecipes(melanges).map((m) => m.id)).toEqual(['M-1'])
  })
})

const run = (over: Partial<Batch>): Batch =>
  ({
    id: 'BAT-2026-0100',
    kind: 'Melange',
    date: '2026-10-14T00:00:00Z',
    status: 'Pending',
    blendLines: [],
    spoiled: 0,
    ...over,
  }) as unknown as Batch

describe('openBlendRuns', () => {
  it('counts what the pipeline Blending tile counts — including Closed as finished', () => {
    const batches = [
      run({ id: 'B-new', date: '2026-10-14T00:00:00Z', status: 'Awaiting QC' }),
      run({ id: 'B-old', date: '2026-10-10T00:00:00Z', status: 'On Hold' }),
      run({ id: 'B-rel', status: 'Released' }),
      run({ id: 'B-closed', status: 'Closed' }), // the close endpoint's own stamp
      run({ id: 'B-ext', kind: 'Extraction', status: 'Pending' }), // not blending's queue
    ]
    const queue = openBlendRuns(batches)
    expect(queue.map((b) => b.id)).toEqual(['B-old', 'B-new']) // oldest first
    const state = migrateState({}) as AppState
    state.batches.push(...batches)
    const tile = pipelineStages(state, '2026-10-14').find((s) => s.id === 'blending')
    expect(tile?.count).toBe(queue.length)
  })
})
