// @vitest-environment happy-dom
/**
 * Two rules on the production domain, each pinned as it landed.
 *
 * deleteBatch used to block dispatches and melange blends only, so a Stock Issue
 * (or any other document) that drew the batch's bulk survived the batch it drew
 * from — its qtyOut then pointed at a lot that no longer existed. The draw guard
 * names the document and refuses, and it is evaluated against the same gone-set
 * the delete sweeps, so the batch's own QC and its dependent packing runs never
 * block the deletion they are part of.
 *
 * A mixed-unit issue — pieces of one lot, kilograms of another — has no yield
 * denominator. The old code divided the output by the raw cross-unit sum and
 * stored the ratio under an invented "Unit" uom; a mixed batch now posts no
 * per-unit yield at all, and the issue is labelled by unit everywhere it reads.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProduction } from './production'
import type { CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { batchWiseRows } from '../../lib/reports/production'
import { deepClone } from '../../lib/utils'
import type { BatchInput } from '../../lib/posting'
import type {
  AppState,
  Batch,
  LedgerEntry,
  PackingRun,
  QcRecord,
  StorageLocation,
} from '../../types'

const COLD: StorageLocation = {
  id: 'SL-1', name: 'cold-a', label: 'Cold Room A', holds: 'Bulk', type: 'Cold Room', status: 'Active',
}

/** One modern-shape extraction batch with its QC record and a dependent run. */
const BATCH: Batch = {
  id: 'B-0001', kind: 'Extraction', date: '2026-09-20',
  sourceLines: [{ lot: 'LOT-1', item: 'RM-TCW-COCO', uom: 'Piece', qty: 600, unitCost: 30 }],
  outputLines: [{ stockId: 'B-0001/1', item: 'SF-TCW-WATER', qty: 180, uom: 'Litre', costShare: 100 }],
  coconuts: 600, inputQty: 600, inputUom: 'Piece', spoiled: 20, outputs: [], outputLitres: 180,
  yieldPerCoconut: 180 / 580, yieldPerUnit: 180 / 580, wastage: 0,
  rmCost: 18000, pmCost: 0, directCost: 18000, costPerL: 100,
  status: 'Partly Released', qcId: 'QC-0001', qcIds: ['QC-0001'],
}
const QC: QcRecord = {
  id: 'QC-0001', batchId: 'B-0001', item: 'SF-TCW-WATER',
  micro: 'Pass', pesticides: 'Pass', heavyMetals: 'Pass', physico: 'Pass',
  disposition: 'Released', reviewedBy: 'lab@roligt.local', reviewedAt: '2026-09-21',
}
const RUN: PackingRun = {
  id: 'PR-0001', date: '2026-09-22', batchId: 'B-0001', bulkItem: 'SF-TCW-WATER', medium: 'Water',
  lines: [{ sku: 'FG-1', packs: 40, perPack: 0.25, drawn: 10, qty: 40, unitCost: 5, expiry: '2026-10-22' }],
  drawn: 10, pmCost: 80, bulkCost: 120, status: 'Posted',
}

/** The batch's own output line, its QC's transfer line and its run's consume line —
 *  the three documents the delete is allowed to sweep away with it. */
const OWN_LINE: LedgerEntry = {
  id: 'LED-1', type: 'Production Output', doc: 'B-0001', item: 'SF-TCW-WATER', itemType: 'Semi Finished',
  lot: 'B-0001', location: 'cold-a', status: 'Quarantine', qtyIn: 180, qtyOut: 0, uom: 'Litre',
  unitCost: 100, time: '2026-09-20T08:00:00Z',
}
const QC_LINE: LedgerEntry = {
  ...OWN_LINE,
  id: 'LED-2', type: 'QC Status Transfer', doc: 'QC-0001', status: 'Released', qtyIn: 0, qtyOut: 180,
  time: '2026-09-21T08:00:00Z',
}
const RUN_LINE: LedgerEntry = {
  ...OWN_LINE,
  id: 'LED-3', type: 'Packing Consume', doc: 'PR-0001', qtyIn: 0, qtyOut: 10,
  time: '2026-09-22T08:00:00Z',
}

/** A document the delete does not own: the lab's issue of two litres. */
const ISSUE_LINE: LedgerEntry = {
  ...OWN_LINE,
  id: 'LED-4', type: 'Stock Issue', doc: 'ISS-0001', qtyIn: 0, qtyOut: 2,
  time: '2026-09-23T08:00:00Z',
}

function plant(lines: LedgerEntry[]): AppState {
  return migrateState({
    storageLocations: [COLD],
    batches: [BATCH],
    qcs: [QC],
    packingRuns: [RUN],
    ledger: lines,
  })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(lines: LedgerEntry[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const d: CoreDeps = {
    state: plant(lines),
    setState,
    nextId: vi.fn((_draft: AppState, kind: string) => (kind === 'qc' ? 'QC-0002' : 'BAT-0002')),
    nextLot: vi.fn(() => 'LOT-0002'),
    log,
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'prod@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast, log }
}

/** Applies the updater the hook posted, against a copy of the state it read. */
function applied(d: CoreDeps, setState: ReturnType<typeof vi.fn>): AppState {
  const updater = setState.mock.calls[0][0] as (prev: AppState) => AppState
  return updater(deepClone(d.state))
}

afterEach(cleanup)

describe('deleteBatch', () => {
  it('refuses the delete when another document drew the batch — and names it', () => {
    const { d, setState, showToast } = deps([OWN_LINE, QC_LINE, RUN_LINE, ISSUE_LINE])
    const { result } = renderHook(() => useProduction(d))
    result.current.deleteBatch('B-0001')
    expect(setState).not.toHaveBeenCalled() // the batch and its lines are untouched
    expect(showToast).toHaveBeenCalledWith(
      'Cannot delete: ISS-0001 drew stock from this batch. Delete or edit that document first.',
    )
  })

  it('deletes through its own QC and dependent run lines — they go with the batch', () => {
    const { d, setState, showToast } = deps([OWN_LINE, QC_LINE, RUN_LINE])
    const { result } = renderHook(() => useProduction(d))
    result.current.deleteBatch('B-0001')
    expect(setState).toHaveBeenCalledTimes(1)
    const draft = applied(d, setState)
    expect(draft.batches).toEqual([])
    expect(draft.qcs).toEqual([])
    expect(draft.packingRuns).toEqual([])
    expect(draft.ledger).toEqual([]) // own, QC and run lines all swept
    expect(showToast).toHaveBeenCalledWith('Batch deleted; stock recalculated.')
  })
})

describe('createBatch with a mixed-unit issue', () => {
  /** The same raw item received as pieces on one lot and kilograms on another. */
  const PIECE_LOT: LedgerEntry = {
    id: 'LED-10', type: 'GRN', doc: 'GRN-0001', item: 'RM-TCW-COCO', itemType: 'Raw Material',
    lot: 'LOT-P', location: 'rm-store', status: 'Available', qtyIn: 600, qtyOut: 0, uom: 'Piece',
    unitCost: 30, time: '2026-09-24T08:00:00Z',
  }
  const KG_LOT: LedgerEntry = {
    ...PIECE_LOT,
    id: 'LED-11', doc: 'GRN-0002', lot: 'LOT-K', uom: 'Kg', qtyIn: 40,
    time: '2026-09-24T09:00:00Z',
  }

  function deps() {
    const showToast = vi.fn()
    const setState = vi.fn()
    const log = vi.fn()
    const d: CoreDeps = {
      state: migrateState({
        storageLocations: [COLD],
        items: [
          { id: 'RM-TCW-COCO', name: 'Tender Coconut', type: 'Raw Material', uom: 'Piece', lotControlled: true, reorder: 0, costMethod: 'Lot Actual' },
          { id: 'SF-TCW-WATER', name: 'Coconut Water (bulk)', type: 'Semi Finished', uom: 'Litre', lotControlled: true, reorder: 0, costMethod: 'Lot Actual' },
        ],
        ledger: [PIECE_LOT, KG_LOT],
      }),
      setState,
      nextId: vi.fn((_draft: AppState, kind: string) => (kind === 'qc' ? 'QC-0002' : 'BAT-0002')),
      nextLot: vi.fn(() => 'LOT-0003'),
      log,
      showToast,
      announcement: { current: null },
      forbidden: () => false,
      rows: [],
      actor: 'prod@roligt.local',
      vendorTypeName: () => 'Farmer',
    }
    return { d, setState, showToast, log }
  }

  const mixedInput: BatchInput = {
    date: '2026-09-25',
    kind: 'Extraction',
    spoiled: 10,
    sourceLines: [
      { item: 'RM-TCW-COCO', lot: 'LOT-P', qty: 600 },
      { item: 'RM-TCW-COCO', lot: 'LOT-K', qty: 40 },
    ],
    blendLines: [],
    outputs: [{ item: 'SF-TCW-WATER', qty: 180, main: true }],
    location: 'cold-a',
  }

  it('posts no per-unit yield and no invented unit — the issue is labelled by unit', () => {
    const { d, setState, log } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(mixedInput)
    expect(setState).toHaveBeenCalledTimes(1)
    const draft = applied(d, setState)
    const batch = draft.batches.find((b) => b.id === 'BAT-0002')!
    // The raw cross-unit sum stays for cost, but no unit is claimed for it and no
    // ratio is divided by it — 180/640 L per "unit" meant nothing.
    expect(batch.inputQty).toBe(640)
    expect(batch.inputUom).toBe('')
    expect(batch.yieldPerUnit).toBe(0)
    expect(batch.yieldPerCoconut).toBe(0)
    expect(batch.wastage).toBe(0)
    expect(batch.sourceLines.map((l) => l.uom)).toEqual(['Piece', 'Kg'])
    // The audit line names every unit instead of one invented one.
    const detail = log.mock.calls.find((c) => c[1] === 'Posted production')![3] as string
    expect(detail).toContain('Consumed 600 Piece · 40 Kg into 180 L Coconut Water (bulk)')
    // And the batch-wise report reads the same way: labelled input, no yield.
    const row = batchWiseRows(draft, { from: '2026-09-01', to: '2026-09-30' }).find(
      (r) => r.batchId === 'BAT-0002',
    )!
    expect(row.inputLabel).toBe('600 Piece · 40 Kg')
    expect(row.yieldPerUnit).toBeNull()
  })

  it('still yields per unit when the whole issue is counted in one unit', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch({
      ...mixedInput,
      spoiled: 20,
      sourceLines: [{ item: 'RM-TCW-COCO', lot: 'LOT-P', qty: 600 }],
    })
    const batch = applied(d, setState).batches.find((b) => b.id === 'BAT-0002')!
    expect(batch.inputUom).toBe('Piece')
    // Over the nuts actually pressed, not everything carried in.
    expect(batch.yieldPerUnit).toBeCloseTo(180 / 580, 6)
  })
})
