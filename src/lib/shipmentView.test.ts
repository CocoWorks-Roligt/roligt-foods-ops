import { describe, expect, it } from 'vitest'
import { boardRow, canReassign, canReschedule, filterRows, freeDispatches, isTripActive } from './shipmentView.ts'
import type { ShipmentDetail } from './contracts.ts'
import type { Dispatch } from '../types.ts'

const line = (over: Partial<ShipmentDetail['lines'][number]> = {}) => ({
  dispatchId: 'D-1',
  sku: 'FG-TCW-250',
  lot: 'B-9',
  qty: 40,
  customerId: 'C-1',
  customerName: 'Green Grocer',
  challan: 'DC0201/2026',
  ...over,
})

const detail = (over: Partial<ShipmentDetail['shipment']> = {}, lines = [line()]): ShipmentDetail => ({
  shipment: {
    id: 'S-1',
    orderId: 'O-1',
    dispatchIds: ['D-1'],
    vehicle: 'AP-07-1234',
    status: 'Out for Delivery',
    stops: [{ customerId: 'C-1', customerName: 'Green Grocer', address: '12 Market Road', dispatchIds: ['D-1'] }],
    times: { created: '2026-10-15T04:00:00Z', dispatched: '2026-10-15T06:00:00Z' },
    packaging: 'LOOSE',
    agentUserId: 'driver@roligt.local',
    version: 3,
    ...over,
  },
  lines,
  challans: [{ id: 'CH-1', number: 'DC0201/2026', status: 'Issued', version: 1 }],
})

const dispatch = (id: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  customerId: 'C-1',
  customerName: 'Green Grocer',
  batchId: 'B-9',
  sku: 'FG-TCW-250',
  qty: 40,
  challan: 'DC0201/2026',
  orderId: 'O-1',
  vehicle: 'AP-07-1234',
  dispatchTime: '2026-10-15T04:00:00Z',
  status: 'Dispatched',
  pod: '',
  ...over,
})

describe('shipmentView', () => {
  it('folds a detail into a board row', () => {
    const row = boardRow(detail())
    expect(row).toMatchObject({
      id: 'S-1',
      orderId: 'O-1',
      customers: 'Green Grocer',
      dispatchDate: '2026-10-15T06:00:00Z', // dispatched, not created
      agent: 'driver@roligt.local',
      items: 40,
      status: 'Out for Delivery',
      version: 3,
    })
    expect(row.challans[0].number).toBe('DC0201/2026')
  })

  it('a trip not yet dispatched falls back to created, and multi-stop names count', () => {
    const row = boardRow(
      detail(
        { status: 'Created', times: { created: '2026-10-15T04:00:00Z' } },
        [line(), line({ dispatchId: 'D-2', customerName: 'Blue Cafe', customerId: 'C-2' })],
      ),
    )
    expect(row.dispatchDate).toBe('2026-10-15T04:00:00Z')
    expect(row.customers).toBe('Green Grocer +1 more')
    expect(row.items).toBe(80)
  })

  it('filters by status and by text across order, agent, vehicle and challan number', () => {
    const rows = [
      boardRow(detail()),
      boardRow(detail({ id: 'S-2', status: 'Failed', agentUserId: 'other@roligt.local', vehicle: 'TS-09-0001' })),
    ]
    expect(filterRows(rows, { status: 'Failed', q: '' })).toHaveLength(1)
    expect(filterRows(rows, { status: 'All', q: 'dc0201' })).toHaveLength(2) // both carry the DC
    expect(filterRows(rows, { status: 'All', q: 'ts-09' })).toHaveLength(1)
    expect(filterRows(rows, { status: 'All', q: 'driver@' })).toHaveLength(1)
    expect(filterRows(rows, { status: 'All', q: 'nothing-matches' })).toHaveLength(0)
  })

  it('free dispatches exclude delivered rows and rows on an active trip, grouped per order', () => {
    const details = [detail({ dispatchIds: ['D-1', 'D-2'] })]
    const dispatches = [
      dispatch('D-1'), // busy — on the active trip
      dispatch('D-2'), // busy too
      dispatch('D-3', { orderId: 'O-2', customerName: 'Blue Cafe' }),
      dispatch('D-4', { status: 'Delivered' }), // Classic already closed it
      dispatch('D-5', { orderId: undefined }), // free-floating, no order to group under
    ]
    const free = freeDispatches(dispatches, details)
    expect(free).toHaveLength(1)
    expect(free[0].orderId).toBe('O-2')
    expect(free[0].customerName).toBe('Blue Cafe')
    expect(free[0].rows.map((r) => r.id)).toEqual(['D-3'])
  })

  it('the machine verdicts: active statuses, reassignment window, the one reschedule arrow', () => {
    expect(isTripActive('Out for Delivery')).toBe(true)
    expect(isTripActive('Delivered')).toBe(false)
    expect(isTripActive('Returned')).toBe(false)
    expect(canReassign('Created')).toBe(true)
    expect(canReassign('Delivered')).toBe(false)
    expect(canReschedule('Failed')).toBe(true)
    expect(canReschedule('Out for Delivery')).toBe(false)
  })
})
