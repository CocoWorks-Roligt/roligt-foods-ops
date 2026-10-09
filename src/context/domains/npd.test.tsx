// @vitest-environment happy-dom
/**
 * Stock handed to NPD, and what NPD records it used it for.
 *
 * Sending is a move into an NPD area that flips the status to NPD; using is a stock
 * issue with reason 'NPD use', a purpose and a reason in words. These pins hold the
 * engine to that: what a send posts and what it refuses, that NPD stock is out of
 * production's reach (no draw, no ordinary issue, no move back out), that a use record
 * must say what for and why and can only draw NPD's own stock, the month's report, and
 * the NPD role's reach.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useInventory } from './inventory'
import type { CoreDeps } from './deps'
import { checkStockIssue, type StockIssueInput } from '../../lib/issues'
import { migrateState } from '../../lib/migrate'
import { monthOf, npdMonthReport, npdRows, sendable, type SendToNpdInput } from '../../lib/npd'
import { PAGE_CATALOG } from '../../lib/pages'
import { devPermissions } from '../../lib/permissions'
import { DRAWABLE } from '../../lib/posting'
import { areaRefusal, NPD_STATUS, stockRows } from '../../lib/stock'
import { deepClone, nowISO, toLocalInputValue } from '../../lib/utils'
import { NPD_USE, type AppState, type Item, type LedgerEntry, type StorageLocation } from '../../types'

const COLD: StorageLocation = {
  id: 'SL-1', name: 'cold-a', label: 'Cold Room A', holds: 'Bulk', type: 'Cold Room', status: 'Active',
}
const LAB_SHELF: StorageLocation = {
  id: 'SL-2', name: 'npd-1', label: 'NPD Shelf', holds: 'Trials', type: 'NPD Area', status: 'Active',
}

const WATER: Item = {
  id: 'SF-TCW-WATER', name: 'Coconut Water (bulk)', type: 'Semi Finished', uom: 'Litre',
  lotControlled: true, reorder: 0, costMethod: 'Lot Actual',
}

const lot = (id: string, lotId: string, status: string, qty: number): LedgerEntry => ({
  id, type: 'Production Output', doc: lotId, item: WATER.id, itemType: 'Semi Finished', lot: lotId,
  location: 'cold-a', status, qtyIn: qty, qtyOut: 0, uom: 'Litre', unitCost: 20,
  time: '2026-09-20T08:00:00Z',
})

function plant(areas: StorageLocation[] = [COLD, LAB_SHELF]): AppState {
  return migrateState({
    storageLocations: areas,
    items: [WATER],
    ledger: [lot('LED-1', 'B-0001', 'Quarantine', 200), lot('LED-2', 'B-0002', 'Rejected', 50)],
  })
}

function deps(state: AppState = plant()) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const seq: Record<string, number> = {}
  const d: CoreDeps = {
    state,
    setState,
    nextId: vi.fn((_draft: AppState, kind: string) => {
      seq[kind] = (seq[kind] || 0) + 1
      return `ISS-000${seq[kind]}`
    }),
    nextLot: vi.fn(() => 'LOT-0001'),
    log: vi.fn(),
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: stockRows(state),
    actor: 'npd@roligt.local',
    vendorTypeName: () => 'Vendor',
  }
  return { d, setState, showToast }
}

const applied = (d: CoreDeps, setState: ReturnType<typeof vi.fn>, call = 0): AppState =>
  (setState.mock.calls[call][0] as (prev: AppState) => AppState)(deepClone(d.state))

const send = (qty: number, extra: Partial<SendToNpdInput> = {}): SendToNpdInput => ({
  item: WATER.id, lot: 'B-0001', location: 'cold-a', status: 'Quarantine', qty, to: 'npd-1', ...extra,
})

/** A plant where 30 L of B-0001 has already gone to NPD. */
function sent(): AppState {
  const { d, setState } = deps()
  const { result } = renderHook(() => useInventory(d))
  expect(result.current.sendToNpd(send(30))).toBeTruthy()
  return applied(d, setState)
}

const use = (qty: number, extra: Partial<StockIssueInput> = {}): StockIssueInput => ({
  date: toLocalInputValue(),
  reason: NPD_USE,
  npdPurpose: 'New product trial',
  recipient: 'Mango smoothie',
  notes: 'Three trial batches at different sugar levels',
  lines: [{ item: WATER.id, lot: 'B-0001', location: 'npd-1', status: NPD_STATUS, qty, expiry: '' }],
  ...extra,
})

afterEach(cleanup)

describe('sending stock to NPD', () => {
  it('moves it into the NPD area under the NPD status, keeping its cost', () => {
    const draft = sent()
    const legs = draft.ledger.filter((l) => l.type === 'Stock Transfer')
    expect(legs).toHaveLength(2)
    expect(legs[0]).toMatchObject({ location: 'cold-a', status: 'Quarantine', qtyOut: 30, unitCost: 20 })
    expect(legs[1]).toMatchObject({ location: 'npd-1', status: NPD_STATUS, qtyIn: 30, unitCost: 20 })
    expect(legs[0].doc).toBe(legs[1].doc)
    expect(npdRows(draft)).toMatchObject([{ lot: 'B-0001', location: 'npd-1', qty: 30 }])
    const left = stockRows(draft).find((r) => r.lot === 'B-0001' && r.status === 'Quarantine')
    expect(left?.qty).toBe(170)
  })

  it('refuses rejected stock, stock NPD already holds, too much, and a plant with no NPD area', () => {
    const { d, setState, showToast } = deps()
    const { result } = renderHook(() => useInventory(d))
    expect(result.current.sendToNpd(send(10, { lot: 'B-0002', status: 'Rejected' }))).toBeNull()
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining('rejected'))
    expect(result.current.sendToNpd(send(500))).toBeNull()
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining('no more than 200'))

    const held = sent()
    const again = deps(held)
    const { result: r2 } = renderHook(() => useInventory(again.d))
    expect(r2.current.sendToNpd(send(5, { location: 'npd-1', status: NPD_STATUS }))).toBeNull()
    expect(again.showToast).toHaveBeenLastCalledWith('NPD already holds this stock.')

    const bare = deps(plant([COLD]))
    const { result: r3 } = renderHook(() => useInventory(bare.d))
    expect(r3.current.sendToNpd(send(5))).toBeNull()
    expect(bare.showToast).toHaveBeenLastCalledWith(expect.stringContaining('no NPD area'))
    expect(setState).not.toHaveBeenCalled()
  })

  it('offers Send on any status but Rejected and NPD', () => {
    expect(sendable({ status: 'Quarantine', qty: 1 })).toBe(true)
    expect(sendable({ status: 'Released', qty: 1 })).toBe(true)
    expect(sendable({ status: 'Rejected', qty: 1 })).toBe(false)
    expect(sendable({ status: NPD_STATUS, qty: 1 })).toBe(false)
  })
})

describe('NPD stock is out of production', () => {
  it('is in no drawable status', () => {
    expect(DRAWABLE).not.toContain(NPD_STATUS)
  })

  it('pairs the NPD status with NPD areas only, both ways', () => {
    expect(areaRefusal(LAB_SHELF, 'Semi Finished', 'Quarantine')).toMatch(/NPD area/)
    expect(areaRefusal(COLD, 'Semi Finished', NPD_STATUS)).toMatch(/stays in an NPD area/)
    expect(areaRefusal(LAB_SHELF, 'Semi Finished', NPD_STATUS)).toBeNull()
  })

  it('cannot be written off by an ordinary stock issue', () => {
    const draft = sent()
    const input = use(5, { reason: 'Lab / testing', npdPurpose: undefined })
    expect(checkStockIssue(draft, input)).toMatch(/held by NPD/)
  })
})

describe('recording NPD use', () => {
  it('needs a purpose, a reason, and NPD’s own stock', () => {
    const draft = sent()
    expect(checkStockIssue(draft, use(5, { npdPurpose: undefined }))).toMatch(/used for/)
    expect(checkStockIssue(draft, use(5, { notes: '  ' }))).toMatch(/reason/)
    const fromFloor = use(5, {
      lines: [{ item: WATER.id, lot: 'B-0001', location: 'cold-a', status: 'Quarantine', qty: 5, expiry: '' }],
    })
    expect(checkStockIssue(draft, fromFloor)).toMatch(/send it to NPD first/)
    expect(checkStockIssue(draft, use(5))).toBeNull()
  })

  it('draws NPD’s stock down and keeps the purpose on the record', () => {
    const held = sent()
    const { d, setState } = deps(held)
    const { result } = renderHook(() => useInventory(d))
    expect(result.current.createStockIssue(use(12))).toBeTruthy()
    const draft = applied(d, setState)
    expect(draft.stockIssues[0]).toMatchObject({
      id: 'ISS-0001', reason: NPD_USE, npdPurpose: 'New product trial', recipient: 'Mango smoothie',
    })
    expect(npdRows(draft)[0].qty).toBe(18)
  })
})

describe('the monthly report', () => {
  it('reads what came in, what went on what, and what was left', () => {
    const held = sent()
    const { d, setState } = deps(held)
    const { result } = renderHook(() => useInventory(d))
    result.current.createStockIssue(use(12))
    const draft = applied(d, setState)
    const month = monthOf(nowISO())
    const report = npdMonthReport(draft, month)
    expect(report.received).toMatchObject([{ lot: 'B-0001', qty: 30, fromStatus: 'Quarantine', value: 600 }])
    expect(report.uses.map((u) => u.id)).toEqual(['ISS-0001'])
    expect(report.usedValue).toBe(240)
    expect(report.byPurpose).toMatchObject([{ purpose: 'New product trial', records: 1, value: 240 }])
    expect(report.byItem).toMatchObject([{ item: WATER.id, qty: 12 }])
    expect(report.heldAtClose).toMatchObject([{ item: WATER.id, qty: 18, value: 360 }])

    // The month before saw none of it.
    const [y, m] = month.split('-').map(Number)
    const before = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
    const empty = npdMonthReport(draft, before)
    expect(empty.received).toHaveLength(0)
    expect(empty.uses).toHaveLength(0)
    expect(empty.heldAtClose).toHaveLength(0)
  })
})

describe('the NPD role', () => {
  it('holds the NPD page and nothing else', () => {
    expect(devPermissions('Npd')).toEqual(['page.npd'])
    expect(PAGE_CATALOG.find((p) => p.id === 'npd')).toMatchObject({ path: '/npd', slug: 'page.npd' })
  })
})
