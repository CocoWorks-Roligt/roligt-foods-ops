import { describe, expect, it } from 'vitest'
import { pipelineStages, pipelineStuckDays, roleLandingPath } from './pipeline.ts'
import { migrateState } from './migrate.ts'
import type { AppState, Batch, Grn, LedgerEntry, Order, QcRecord } from '../types.ts'

const TODAY = '2026-10-13'

const batch = (over: Partial<Batch>): Batch => ({
  id: 'B-0001',
  kind: 'Extraction',
  date: '2026-10-12',
  sourceLines: [],
  outputLines: [],
  coconuts: 0,
  inputQty: 0,
  inputUom: 'Piece',
  spoiled: 0,
  outputs: [],
  outputLitres: 0,
  yieldPerCoconut: 0,
  yieldPerUnit: 0,
  wastage: 0,
  rmCost: 0,
  pmCost: 0,
  directCost: 0,
  costPerL: 0,
  status: 'Awaiting QC',
  qcId: '',
  qcIds: [],
  ...over,
})

const qc = (id: string, batchId: string, disposition: string): QcRecord => ({
  id,
  batchId,
  item: 'SF',
  micro: 'Pass',
  pesticides: 'Pass',
  heavyMetals: 'Pass',
  physico: 'Pass',
  disposition,
  reviewedBy: 'lab@roligt.local',
  reviewedAt: '2026-10-12',
})

const ledger = (over: Partial<LedgerEntry>): LedgerEntry =>
  ({
    id: 'LED-1',
    type: 'RM Receipt',
    doc: 'GRN-1',
    item: 'RM-1',
    itemType: 'Raw Material',
    lot: 'LOT-1',
    location: 'store',
    status: 'Available',
    qtyIn: 10,
    qtyOut: 0,
    uom: 'Kg',
    unitCost: 10,
    time: '2026-10-10T08:00:00Z',
    ...over,
  }) as LedgerEntry

const state = (): AppState => migrateState({})

describe('pipelineStages', () => {
  it('lays the stages out in process order and reads a quiet plant as zero', () => {
    const stages = pipelineStages(state(), TODAY)
    expect(stages.map((s) => s.id)).toEqual([
      'receipts', 'grading', 'extraction', 'blending', 'packing', 'qc', 'samples', 'stock', 'orders', 'dispatch',
    ])
    expect(stages.every((s) => s.count === 0 && !s.flag)).toBe(true)
  })

  it('counts today’s receipts and staged-unggraded lots separately', () => {
    const s = state()
    const grn = (over: Partial<Grn>): Grn =>
      ({
        id: 'GRN-1', date: TODAY, farmerId: 'F-1', farmerName: 'Farmer One', lot: 'LOT-2026-10-13-001',
        total: 100, a: 50, b: 30, c: 10, reject: 10, rate: 20, transport: 0, accepted: 90,
        materialValue: 0, landed: 0, grossCost: 0, usableCost: 0, status: 'Posted', ...over,
      }) as Grn
    s.grns.push(grn({}), grn({ id: 'GRN-2', lot: 'LOT-2026-10-13-002', date: '2026-10-11' }))
    s.grns.push(grn({ id: 'GRN-3', lot: 'LOT-2026-10-12-003', date: '2026-10-12', gradingMode: 'staged' }))
    const byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.receipts.count).toBe(1)
    expect(byId.grading.count).toBe(1)
  })

  it('counts open runs per stage and flags a stage whose oldest run passed the stuck mark', () => {
    const s = state()
    s.batches.push(
      batch({ id: 'B-1', status: 'Awaiting QC', date: '2026-10-08' }), // 5 days open
      batch({ id: 'B-2', status: 'Released' }),
      batch({ id: 'B-3', kind: 'Melange', status: 'Awaiting QC', date: TODAY }),
    )
    const byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.extraction.count).toBe(1)
    expect(byId.blending.count).toBe(1)
    expect(byId.extraction.flag?.kind).toBe('stuck')
    expect(byId.blending.flag).toBeUndefined()
  })

  it('honours a configured stuck mark over the default', () => {
    const s = state()
    s.config.pipelineStuckDays = 10
    s.batches.push(batch({ id: 'B-1', date: '2026-10-08' }))
    const byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.extraction.flag).toBeUndefined()
  })

  it('flags QC verdicts that have waited past the stuck mark', () => {
    const s = state()
    s.batches.push(batch({ id: 'B-1', date: '2026-10-01' }))
    s.qcs.push(qc('QC-1', 'B-1', 'Pending'))
    const byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.qc.count).toBe(1)
    expect(byId.qc.flag?.kind).toBe('stuck')
  })

  it('flags held lots before near-expiry and reorder alerts', () => {
    const s = state()
    s.ledger.push(ledger({ status: 'Quarantine' }))
    let byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.stock.count).toBe(1)
    expect(byId.stock.flag?.kind).toBe('hold')

    const t = state()
    t.ledger.push(
      // The plant’s alert window is 2 days (migrate default) — inside it, and one far off.
      ledger({ id: 'LED-2', itemType: 'Semi Finished', expiry: '2026-10-14' }),
      ledger({ id: 'LED-3', itemType: 'Semi Finished', expiry: '2026-12-01' }),
    )
    byId = Object.fromEntries(pipelineStages(t, TODAY).map((x) => [x.id, x]))
    expect(byId.stock.count).toBe(1)
    expect(byId.stock.flag?.kind).toBe('expiry')
  })

  it('flags open orders past their ship-by day', () => {
    const s = state()
    s.orders.push(
      { id: 'O-1', customerId: 'C-1', customerName: 'Cafe A', date: '2026-10-01', dueDate: '2026-10-10', status: 'Open', lines: [] } as unknown as Order,
      { id: 'O-2', customerId: 'C-2', customerName: 'Cafe B', date: '2026-10-01', dueDate: '2026-10-20', status: 'Open', lines: [] } as unknown as Order,
    )
    const byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.orders.count).toBe(2)
    expect(byId.orders.flag?.kind).toBe('overdue')
  })

  it('counts dispatches out but not delivered', () => {
    const s = state()
    s.dispatches.push(
      { id: 'D-1', status: 'Dispatched' } as never,
      { id: 'D-2', status: 'In Transit' } as never,
      { id: 'D-3', status: 'Delivered' } as never,
    )
    const byId = Object.fromEntries(pipelineStages(s, TODAY).map((x) => [x.id, x]))
    expect(byId.dispatch.count).toBe(2)
  })
})

describe('pipelineStuckDays', () => {
  it('defaults to 2 and only accepts a whole day count of at least one', () => {
    expect(pipelineStuckDays({})).toBe(2)
    expect(pipelineStuckDays({ pipelineStuckDays: 5 })).toBe(5)
    expect(pipelineStuckDays({ pipelineStuckDays: 0 })).toBe(2)
    expect(pipelineStuckDays({ pipelineStuckDays: -3 })).toBe(2)
  })
})

describe('roleLandingPath', () => {
  it('lands a caller holding exactly one stage slug on that stage', () => {
    expect(roleLandingPath(['page.quality', 'page.control-samples'])).toBe('/quality')
    expect(roleLandingPath(['page.dispatch', 'page.orders'])).toBe('/dispatch')
    expect(roleLandingPath(['page.procurement'])).toBe('/procurement')
  })

  it('lands the open tier and multi-stage roles on the board', () => {
    expect(roleLandingPath([])).toBe('/pipeline')
    expect(roleLandingPath(['page.production', 'page.packing', 'page.quality', 'page.dispatch'])).toBe('/pipeline')
  })
})
