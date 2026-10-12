// @vitest-environment happy-dom
/**
 * Produce receipts carry their supplier on the ledger line — the discipline
 * packing receipts always had — so a ledger line's vendor_id names who it came
 * from, which produce 'Receipt' lines never stamped before. Pinned here: the
 * stamp at creation, the keep-in-step when the edit path rewrites the line,
 * and the direct-farmer shape. Also: a receipt weighed in kilograms is stored
 * whole as grade A, whatever the form still held.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProcurement } from './procurement'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { GrnInput } from '../../lib/grn'
import type { AppState } from '../../types'

const INPUT: GrnInput = {
  date: '2026-10-08',
  purchaseProductId: 'PP-0001',
  location: 'Raw Store',
  farmerId: 'VEN-0001',
  total: 100,
  free: 0,
  a: 60,
  b: 30,
  c: 10,
  reject: 0,
  rate: 10,
  transport: 0,
}

function plant(): AppState {
  return migrateState({
    purchaseProducts: [
      { id: 'PP-0001', name: 'Tender Coconut', category: 'Farm Produce', uom: 'Piece', description: '', status: 'Active', vendorIds: ['VEN-0001', 'VEN-0002'], itemId: 'RM-1' },
      { id: 'PP-0002', name: 'Beetroot', category: 'Farm Produce', uom: 'Kg', description: '', status: 'Active', vendorIds: ['VEN-0001'], itemId: 'RM-2' },
    ],
    vendors: [
      { id: 'VEN-0001', name: 'Green Farms', vendorTypeId: 'VT-FARMER', phone: '', area: 'Mandya', payment: 'Cash', status: 'Active' },
      { id: 'VEN-0002', name: 'Hill Farms', vendorTypeId: 'VT-FARMER', phone: '', area: 'Mysuru', payment: 'Cash', status: 'Active' },
    ],
    storageLocations: [
      { id: 'SL-1', name: 'Raw Store', label: 'Raw Store', holds: 'Produce', type: 'Dry Store', status: 'Active' },
    ],
  })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(state = plant()) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const d: CoreDeps = {
    state,
    setState,
    nextId: vi.fn(() => 'GRN-2026-0001'),
    nextLot: vi.fn(() => 'BTH-2026-0001'),
    log,
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'buy@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast }
}

/** Applies the updater the hook posted, against a copy of the state it read. */
function applied(d: CoreDeps, setState: ReturnType<typeof vi.fn>): AppState {
  const updater = setState.mock.calls[0][0] as (prev: AppState) => AppState
  return updater(deepClone(d.state))
}

afterEach(cleanup)

describe('createGrn — the supplier rides the receipt line', () => {
  it('stamps the vendor on the Receipt ledger line, as PM receipts always did', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProcurement(d))
    expect(result.current.createGrn(INPUT)).toBe(POSTED) // setState is stubbed; the draft is asserted below
    const draft = applied(d, setState)
    const line = draft.ledger.find((l) => l.doc === 'GRN-2026-0001' && l.type === 'Receipt')
    expect(line?.vendorId).toBe('VEN-0001')
  })

  it('a direct farmer — no vendor master — stamps an empty vendor, not a broken one', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProcurement(d))
    result.current.createGrn({ ...INPUT, farmerId: '', farmer: 'Ravi (direct)' })
    const draft = applied(d, setState)
    const line = draft.ledger.find((l) => l.doc === 'GRN-2026-0001' && l.type === 'Receipt')
    expect(line?.vendorId).toBe('')
  })
})

describe('updateGrn — the line keeps in step', () => {
  it('moves the line\'s vendor when the receipt is re-pointed at another vendor', () => {
    const first = deps()
    const { result: created } = renderHook(() => useProcurement(first.d))
    created.current.createGrn(INPUT)
    const posted = applied(first.d, first.setState)

    const { d, setState, showToast } = deps(posted)
    const { result } = renderHook(() => useProcurement(d))
    expect(result.current.updateGrn('GRN-2026-0001', { ...INPUT, farmerId: 'VEN-0002' })).toBe('GRN-2026-0001')
    expect(showToast).toHaveBeenCalledWith('GRN-2026-0001 updated.') // the success path — not a refusal
    const draft = applied(d, setState)
    const line = draft.ledger.find((l) => l.doc === 'GRN-2026-0001' && l.type === 'Receipt')
    expect(line?.vendorId).toBe('VEN-0002')
  })
})

describe('createGrn — weighed produce is not graded', () => {
  it('stores a kilogram receipt whole as grade A, with nothing free or rejected', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProcurement(d))
    const kg = { ...INPUT, purchaseProductId: 'PP-0002', uom: 'Kg', total: 12.5, free: 2, a: 3, b: 4, c: 1, reject: 1.5 }
    expect(result.current.createGrn(kg)).toBe(POSTED)
    const draft = applied(d, setState)
    const grn = draft.grns.find((g) => g.id === 'GRN-2026-0001')
    expect(grn).toMatchObject({ total: 12.5, free: 0, a: 12.5, b: 0, c: 0, reject: 0, accepted: 12.5 })
    const line = draft.ledger.find((l) => l.doc === 'GRN-2026-0001' && l.type === 'Receipt')
    expect(line?.qtyIn).toBe(12.5)
  })
})
