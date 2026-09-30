// @vitest-environment happy-dom
/**
 * Delete and edit enforce one rule on a packing run: anything else that has drawn
 * on its packs — a QC release, a dispatch, a stock issue, a second run off the same
 * batch — shares their blended unit cost, so the run can no longer move. The delete
 * path used to block dispatches only, so deleting a QC-released run stranded the
 * transfers: released packs stayed dispatchable forever with no run behind them.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePacking } from './packing'
import type { CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { PackingInput } from '../../lib/posting'
import type { AppState, LedgerEntry, PackingRun } from '../../types'

const SKU = 'FG-TCW-WATER-250'

/** One run of 40 packs off batch B-0001, with its own Packing Output line posted. */
const RUN: PackingRun = {
  id: 'PR-0001', date: '2026-09-28', batchId: 'B-0001', bulkItem: 'SF-TCW-WATER', medium: 'Water',
  lines: [{ sku: SKU, packs: 40, perPack: 0.25, drawn: 10, qty: 40, unitCost: 5, expiry: '2026-10-26' }],
  drawn: 10, pmCost: 80, bulkCost: 120, status: 'Posted',
}
const OWN_LINE: LedgerEntry = {
  id: 'LED-1', type: 'Packing Output', doc: 'PR-0001', item: SKU, itemType: 'Finished Goods',
  lot: 'B-0001', location: 'freezer', status: 'Available', qtyIn: 40, qtyOut: 0, uom: 'Pack',
  unitCost: 5, time: '2026-09-28T08:00:00Z',
}

/** Another document's line touching the same packs — lot = the batch, item = a SKU. */
const foreignLine = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: 'LED-2', type: 'QC Status Transfer', doc: 'QC-0001', item: SKU, itemType: 'Finished Goods',
  lot: 'B-0001', location: 'freezer', status: 'Released', qtyIn: 40, qtyOut: 0, uom: 'Pack',
  unitCost: 5, time: '2026-09-29T08:00:00Z',
  ...over,
})

function plant(lines: LedgerEntry[]): AppState {
  return migrateState({ packingRuns: [RUN], ledger: lines })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(lines: LedgerEntry[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const d: CoreDeps = {
    state: plant(lines),
    setState,
    nextId: vi.fn(() => 'PR-0002'),
    nextLot: vi.fn(() => 'B-0002'),
    log,
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'qa@roligt.local',
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

describe('deletePackingRun', () => {
  it('refuses the delete when a QC release has touched the packs — and names it', () => {
    const { d, setState, showToast } = deps([OWN_LINE, foreignLine({})])
    const { result } = renderHook(() => usePacking(d))
    result.current.deletePackingRun('PR-0001')
    expect(setState).not.toHaveBeenCalled() // the run and its lines are untouched
    expect(showToast).toHaveBeenCalledWith('Cannot delete: QC Status Transfer QC-0001 has already drawn on these packs.')
  })

  it('refuses the delete when a stock issue has drawn the packs', () => {
    const { d, setState, showToast } = deps([
      OWN_LINE,
      foreignLine({ type: 'Stock Issue', doc: 'ISS-0001', qtyIn: 0, qtyOut: 2, status: 'Available' }),
    ])
    const { result } = renderHook(() => usePacking(d))
    result.current.deletePackingRun('PR-0001')
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Cannot delete: Stock Issue ISS-0001 has already drawn on these packs.')
  })

  it('deletes and fully reverses when only the run\'s own lines exist', () => {
    const { d, setState, showToast, log } = deps([OWN_LINE])
    const { result } = renderHook(() => usePacking(d))
    result.current.deletePackingRun('PR-0001')
    expect(setState).toHaveBeenCalledTimes(1)
    const draft = applied(d, setState)
    expect(draft.packingRuns).toEqual([])
    expect(draft.ledger).toEqual([]) // the run's own line went back with it
    expect(log).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Packing run deleted; stock recalculated.')
  })
})

describe('updatePackingRun', () => {
  it('enforces the same rule — a QC-released run cannot be edited either, and the toast names the blocker', () => {
    const { d, setState, showToast } = deps([OWN_LINE, foreignLine({})])
    const { result } = renderHook(() => usePacking(d))
    // the input is never read: the refusal happens before any validation
    expect(result.current.updatePackingRun('PR-0001', {} as PackingInput)).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'These packs have already been drawn on by QC Status Transfer QC-0001 — reverse that first if this run has to change.',
    )
  })
})
