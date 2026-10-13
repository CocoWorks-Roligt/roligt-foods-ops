import { describe, expect, it } from 'vitest'
import { navBadges } from './navBadges.ts'
import { migrateState } from './migrate.ts'
import type { AppState, Batch, Order, PackingRun, QcRecord } from '../types.ts'

const TODAY = '2026-10-13'

/** The full batch shape the roll-up writes — only what a badge reads varies. */
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

const qc = (id: string, disposition: string): QcRecord => ({
  id,
  batchId: 'B-1',
  item: 'SF',
  micro: 'Pass',
  pesticides: 'Pass',
  heavyMetals: 'Pass',
  physico: 'Pass',
  disposition,
  reviewedBy: 'lab@roligt.local',
  reviewedAt: '2026-10-12',
})

const state = (): AppState => migrateState({})

describe('navBadges', () => {
  it('counts QC records still pending, and only those', () => {
    const s = state()
    s.qcs.push(
      qc('QC-1', 'Pending'),
      qc('QC-2', 'Pending'),
      qc('QC-3', 'Released'),
      qc('QC-4', 'Retest'),
    )
    expect(navBadges(s, TODAY).quality).toBe(2)
  })

  it('counts open orders, not dispatched ones', () => {
    const s = state()
    const order = (id: string, status: string): Order =>
      ({ id, customerId: 'C-1', date: '2026-10-12', dueDate: '2026-10-20', status, lines: [] }) as unknown as Order
    s.orders.push(order('O-1', 'Open'), order('O-2', 'Open'), order('O-3', 'Dispatched'))
    expect(navBadges(s, TODAY).orders).toBe(2)
  })

  it('counts extraction runs not yet Released/Rejected and blends awaiting QC', () => {
    const s = state()
    s.batches.push(
      batch({ id: 'B-1', status: 'Awaiting QC' }),
      batch({ id: 'B-2', status: 'On Hold' }),
      batch({ id: 'B-3', status: 'Partly Released' }),
      batch({ id: 'B-4', status: 'Released' }),
      batch({ id: 'B-5', status: 'Rejected' }),
      batch({ id: 'B-6', kind: 'Melange', status: 'Awaiting QC' }),
      batch({ id: 'B-7', kind: 'Melange', status: 'Released' }),
    )
    // 3 open extraction runs (Awaiting QC, On Hold, Partly Released) + 1 blend.
    expect(navBadges(s, TODAY).production).toBe(4)
  })

  it('counts kept control samples expiring within the week, past expiry included', () => {
    const s = state()
    const run = {
      id: 'PR-1',
      date: '2026-10-01',
      batchId: 'B-1',
      medium: 'Water',
      lines: [],
      drawn: 0,
      pmCost: 0,
      bulkCost: 0,
      status: 'Posted',
    } as PackingRun
    run.controlSamples = [
      { count: 2, expiresOn: '2026-10-15' }, // inside the week
      { count: 2, expiresOn: '2026-10-10' }, // past expiry, still kept
      { count: 2, expiresOn: '2026-12-01' }, // months left
      { count: 2, expiresOn: '2026-10-10', destroyedOn: '2026-10-11' }, // gone
      { count: 2 }, // no expiry recorded
    ]
    s.packingRuns.push(run)
    expect(navBadges(s, TODAY)['control-samples']).toBe(2)
  })

  it('counts packing materials below their reorder level on both pages that show them', () => {
    const s = state()
    s.items.push({
      id: 'PM-BIB',
      name: '5 L BIB',
      type: 'Packing Material',
      uom: 'Piece',
      reorder: 10,
    } as AppState['items'][number])
    // Ever stocked (a receipt line) but standing below the reorder level.
    s.ledger.push({
      id: 'LED-1',
      type: 'PM Receipt',
      doc: 'GRN-1',
      item: 'PM-BIB',
      itemType: 'Packing Material',
      lot: 'LOT-PM-1',
      location: 'store',
      status: 'Available',
      qtyIn: 4,
      qtyOut: 0,
      uom: 'Piece',
      unitCost: 100,
      time: '2026-10-10T08:00:00Z',
    })
    const badges = navBadges(s, TODAY)
    expect(badges.procurement).toBe(1)
    expect(badges['packing-materials']).toBe(1)
  })

  it('carries no badge for a quiet plant', () => {
    expect(navBadges(state(), TODAY)).toEqual({})
  })
})
