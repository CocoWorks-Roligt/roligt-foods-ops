// @vitest-environment happy-dom
/**
 * The Storage page's gate on moving stock. A move is the one posting in the app
 * that owns no document — it posts two ledger lines and an audit row and nothing
 * else — so the server's ride-along gate lets exactly a page.storage holder commit
 * it (see api/_lib/commit.test.ts), and this client gate refuses anyone else before
 * a line exists: the work is never created just to be unsavable.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useInventory } from './inventory'
import type { CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { PermissionKey } from '../../lib/permissions'
import type { AppState, LedgerEntry, StockRow, StorageLocation } from '../../types'

const COLD_A: StorageLocation = {
  id: 'SL-1', name: 'cold-a', label: 'Cold Room A', holds: 'Bulk', type: 'Cold Room', status: 'Active',
}
const COLD_B: StorageLocation = {
  id: 'SL-2', name: 'cold-b', label: 'Cold Room B', holds: 'Bulk', type: 'Cold Room', status: 'Active',
}

/** The bulk the move draws: 50 Kg of one batch's water sitting in Cold Room A. */
const LINE: LedgerEntry = {
  id: 'LED-1', type: 'Packing Output', doc: 'PR-0001', item: 'SF-TCW-WATER', itemType: 'Semi Finished',
  lot: 'B-0001', location: 'cold-a', status: 'In Stock', qtyIn: 50, qtyOut: 0, uom: 'Kg', unitCost: 12,
  time: '2026-09-28T08:00:00Z',
}
const ROW: StockRow = {
  item: 'SF-TCW-WATER', itemType: 'Semi Finished', lot: 'B-0001', location: 'cold-a', status: 'In Stock',
  uom: 'Kg', qty: 50, value: 600, unitCost: 12,
}

function plant(): AppState {
  return migrateState({ storageLocations: [COLD_A, COLD_B], ledger: [LINE] })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(permissions: readonly string[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const d: CoreDeps = {
    state: plant(),
    setState,
    nextId: vi.fn(() => 'ISS-0001'),
    nextLot: vi.fn(() => 'LOT-0001'),
    log,
    showToast,
    announcement: { current: null },
    // the AppContext rule, verbatim: hold any one of the named permissions or refuse
    forbidden: (what: string, perm: PermissionKey | readonly PermissionKey[]) => {
      const list = Array.isArray(perm) ? perm : [perm]
      if (list.some((p) => permissions.includes(p))) return false
      showToast(`${what} is an admin task — ask an administrator.`)
      return true
    },
    rows: [ROW],
    actor: 'store@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast, log }
}

const MOVE = { item: ROW.item, lot: ROW.lot, status: ROW.status, from: 'cold-a', to: 'cold-b', qty: 10 }

afterEach(cleanup)

describe('moveStock', () => {
  it('refuses a caller without the Storage page before any line is created', () => {
    const { d, setState, showToast } = deps([]) // the operator: no page permissions at all
    const { result } = renderHook(() => useInventory(d))
    expect(result.current.moveStock(MOVE)).toBeNull()
    expect(setState).not.toHaveBeenCalled() // no draft was ever built
    expect(showToast).toHaveBeenCalledWith('Moving stock is an admin task — ask an administrator.')
  })

  it('moves stock for the Storage page\'s holder — out of the old room and into the new one, same unit cost', () => {
    const { d, setState, showToast, log } = deps(['page.storage'])
    const { result } = renderHook(() => useInventory(d))
    expect(result.current.moveStock(MOVE)).toBe('ok')
    expect(setState).toHaveBeenCalledTimes(1)
    // apply the updater the hook posted, against a copy of the state it read
    const updater = setState.mock.calls[0][0] as (prev: AppState) => AppState
    const draft = updater(deepClone(d.state))
    expect(draft.ledger).toHaveLength(3)
    const [out, into] = draft.ledger.slice(1)
    expect(out).toMatchObject({ type: 'Stock Transfer', location: 'cold-a', qtyIn: 0, qtyOut: 10, unitCost: 12 })
    expect(into).toMatchObject({ type: 'Stock Transfer', location: 'cold-b', qtyIn: 10, qtyOut: 0, unitCost: 12 })
    expect(log).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Moved 10 Kg to Cold Room B.')
  })
})
