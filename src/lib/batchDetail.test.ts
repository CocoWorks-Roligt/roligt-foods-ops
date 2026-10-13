import { describe, expect, it } from 'vitest'
import { batchDetail } from './batchDetail.ts'
import { migrateState } from './migrate.ts'
import type { AppState, Batch, LedgerEntry, PackingRun } from '../types.ts'

const batch = (over: Partial<Batch>): Batch => ({
  id: 'BAT-2026-0001',
  kind: 'Extraction',
  date: '2026-10-10',
  sourceLines: [{ lot: 'LOT-2026-10-09-001', qty: 500, unitCost: 20 }],
  outputLines: [],
  coconuts: 500,
  inputQty: 500,
  inputUom: 'Piece',
  spoiled: 0,
  outputs: [],
  outputLitres: 0,
  yieldPerCoconut: 0.4,
  yieldPerUnit: 0.4,
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

const ledger = (over: Partial<LedgerEntry>): LedgerEntry =>
  ({
    id: 'LED-1',
    type: 'Batch Output',
    doc: 'BAT-2026-0001',
    item: 'SF-TCW-WATER',
    itemType: 'Semi Finished',
    lot: 'BAT-2026-0001/1',
    location: 'Cold Room',
    status: 'Released',
    qtyIn: 200,
    qtyOut: 0,
    uom: 'Litre',
    unitCost: 30,
    time: '2026-10-10T09:00:00Z',
    ...over,
  }) as LedgerEntry

const state = (): AppState => migrateState({})

describe('batchDetail', () => {
  it('answers null for an id no batch records', () => {
    expect(batchDetail(state(), 'NOPE', [], false)).toBeNull()
  })

  it('orders the timeline the way the work happened', () => {
    const s = state()
    s.grns.push({
      id: 'GRN-1', date: '2026-10-09', farmerId: 'F-1', farmerName: 'Farmer One', lot: 'LOT-2026-10-09-001',
      total: 500, a: 250, b: 150, c: 60, reject: 40, rate: 20, transport: 0, accepted: 460,
      materialValue: 0, landed: 0, grossCost: 0, usableCost: 0, status: 'Posted',
    })
    s.batches.push(batch({ qcIds: ['QC-1'] }))
    s.qcs.push({
      id: 'QC-1', batchId: 'BAT-2026-0001', item: 'SF-TCW-WATER', micro: 'Pass', pesticides: 'Pass',
      heavyMetals: 'Pass', physico: 'Pass', disposition: 'Pending', reviewedBy: 'lab', reviewedAt: '2026-10-11',
    })
    const model = batchDetail(s, 'BAT-2026-0001', [], false)!
    expect(model.timeline.map((e) => e.label)).toEqual([
      'Received LOT-2026-10-09-001',
      'Extraction run recorded',
      'QC tests recorded',
    ])
  })

  it('offers the QC verdict to Quality and refuses everyone else with a reason', () => {
    const s = state()
    s.batches.push(batch({ qcIds: ['QC-1'] }))
    s.qcs.push({
      id: 'QC-1', batchId: 'BAT-2026-0001', micro: 'Pass', pesticides: 'Pass', heavyMetals: 'Pass',
      physico: 'Pass', disposition: 'Pending', reviewedBy: 'lab', reviewedAt: '2026-10-11',
    })
    const forQc = batchDetail(s, 'BAT-2026-0001', ['page.quality'], false)!
    expect(forQc.actions[0]).toMatchObject({ key: 'qc', legal: true, href: '/quality' })
    const forOps = batchDetail(s, 'BAT-2026-0001', ['page.production'], false)!
    expect(forOps.actions[0]).toMatchObject({ key: 'qc', legal: false })
    expect(forOps.actions[0]!.why).toBeTruthy()
    expect(forOps.actions.find((a) => a.key === 'pack')).toBeUndefined() // nothing on hand
  })

  it('offers packing only for released bulk under the QC gate, with the refusal in words', () => {
    const s = state()
    s.batches.push(batch({ qcIds: ['QC-1'], status: 'Released' }))
    s.ledger.push(ledger({}))
    const held = batchDetail(s, 'BAT-2026-0001', ['page.packing'], true)!
    expect(held.actions.find((a) => a.key === 'pack')).toMatchObject({ legal: true, href: '/packing' })

    const refused = batchDetail(s, 'BAT-2026-0001', ['page.production'], true)!
    const pack = refused.actions.find((a) => a.key === 'pack')!
    expect(pack.legal).toBe(false)
    expect(pack.why).toBeTruthy()

    const quarantined = batchDetail(s, 'BAT-2026-0001', ['page.packing'], true)
    s.ledger[0]!.status = 'Quarantine' // the lot, not the batch roll-up, is what the gate reads
    const gated = batchDetail(s, 'BAT-2026-0001', ['page.packing'], true)!
    const gatedPack = gated.actions.find((a) => a.key === 'pack')!
    expect(gatedPack.legal).toBe(false)
    expect(gatedPack.why).toMatch(/released/i)
    expect(quarantined).not.toBeNull()
  })

  it('keeps legacy rules with the gate off: quarantine bulk stays packable', () => {
    const s = state()
    s.batches.push(batch({ status: 'Awaiting QC' }))
    s.ledger.push(ledger({ status: 'Quarantine' }))
    const model = batchDetail(s, 'BAT-2026-0001', ['page.packing'], false)!
    expect(model.actions.find((a) => a.key === 'pack')).toMatchObject({ legal: true })
  })

  it('walks genealogy both ways over the documents', () => {
    const s = state()
    s.batches.push(batch({ status: 'Released' }))
    s.packingRuns.push({
      id: 'PKG-2026-0001', date: '2026-10-11', batchId: 'BAT-2026-0001', medium: 'Water',
      lines: [], drawn: 200, pmCost: 0, bulkCost: 0, status: 'Posted',
    } as PackingRun)
    s.dispatches.push({
      id: 'D-1', customerId: 'C-1', customerName: 'Cafe A', batchId: 'BAT-2026-0001', sku: 'SKU-1',
      qty: 10, challan: 'DC0001/2026', vehicle: 'van', dispatchTime: '2026-10-12T08:00:00Z', status: 'Delivered', pod: '',
    })
    const model = batchDetail(s, 'BAT-2026-0001', [], false)!
    expect(model.downstream.map((n) => n.kind)).toContain('packing')
    expect(model.downstream.map((n) => n.kind)).toContain('dispatch')
    expect(model.upstream).toEqual([])
  })
})
