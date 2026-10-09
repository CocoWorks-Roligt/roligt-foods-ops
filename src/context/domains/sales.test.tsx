// @vitest-environment happy-dom
/**
 * The order gates that keep what the user was told and what got stored the same
 * shape. An edit, cancel or delete that the rules refuse used to fall through the
 * silent `return prev` inside the setState updater and still toast success — the
 * dialog closed on "Order cancelled." while the order sat there untouched. Every
 * refusal now happens before the write, where it can be said; these pins hold the
 * three false-success shapes, the half-filled line refusal, and the stale-copy edit.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSales } from './sales'
import { type CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { AppState, Order } from '../../types'

const CUSTOMER = 'CUS-0001'

function plant(orders: Order[]): AppState {
  const s = migrateState({
    customers: [
      {
        id: CUSTOMER,
        name: 'Fresh Mart',
        shipTo: 'High Street',
        gst: '',
        status: 'Active',
      },
    ],
    orders,
  })
  return s
}

const order = (id: string, status: string): Order => ({
  id,
  customerId: CUSTOMER,
  customerName: 'Fresh Mart',
  date: '2026-10-09T00:00:00.000Z',
  dueDate: '2026-10-11',
  lines: [{ sku: 'FG-BOTTLE-500', qty: 10 }],
  status,
})

const input = {
  customerId: CUSTOMER,
  date: '2026-10-09',
  dueDate: '2026-10-11',
  lines: [{ sku: 'FG-BOTTLE-500', qty: 12 }],
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(orders: Order[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const d: CoreDeps = {
    state: plant(orders),
    setState,
    nextId: vi.fn(() => 'ORD-0002'),
    nextLot: vi.fn(() => 'LOT-0001'),
    log: vi.fn(),
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'sales@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast }
}

afterEach(cleanup)

describe('order edit, cancel and delete gates', () => {
  it('refuses to edit a dispatched order with a reason instead of toasting a write that did not land', () => {
    const { d, setState, showToast } = deps([order('ORD-0001', 'Dispatched')])
    const { result } = renderHook(() => useSales(d))
    const out = result.current.saveOrder(input, 'ORD-0001')
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled() // nothing was stored
    expect(showToast).toHaveBeenCalledWith(
      'That order has already been dealt with — only an open order can be edited.',
    )
  })

  it('refuses to cancel an already-dispatched order instead of toasting "Order cancelled."', () => {
    const { d, setState, showToast } = deps([order('ORD-0001', 'Dispatched')])
    const { result } = renderHook(() => useSales(d))
    result.current.cancelOrder('ORD-0001')
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('That order has already been dealt with.')
  })

  it('refuses to delete a dispatched order and keeps it', () => {
    const { d, setState, showToast } = deps([order('ORD-0001', 'Dispatched')])
    const { result } = renderHook(() => useSales(d))
    result.current.deleteOrder('ORD-0001')
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Cannot delete: this order has already been dispatched.')
  })

  it('still deletes a cancelled order — only a dispatched one is protected', () => {
    const { d, setState } = deps([order('ORD-0001', 'Cancelled')])
    const { result } = renderHook(() => useSales(d))
    result.current.deleteOrder('ORD-0001')
    expect(setState).toHaveBeenCalledTimes(1)
    const updater = setState.mock.calls[0][0] as (prev: AppState) => AppState
    const draft = updater(deepClone(d.state))
    expect(draft.orders).toHaveLength(0)
  })

  it('refuses a half-filled product line instead of quietly storing fewer lines', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useSales(d))
    const out = result.current.saveOrder({
      ...input,
      // the second row names a product but carries no quantity — the quiet-drop shape
      lines: [
        { sku: 'FG-BOTTLE-500', qty: 12 },
        { sku: 'FG-BIB-5L', qty: 0 },
      ],
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Every product line needs a product and a quantity — complete or remove the half-filled lines.',
    )
  })

  it('says so when the edit target left this device’s copy instead of closing silently', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useSales(d))
    const out = result.current.saveOrder(input, 'ORD-9999')
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'That order is no longer in this device’s copy — reload the page and edit it again.',
    )
  })
})
