import { describe, expect, it } from 'vitest'
import { shipmentTrackingKpis } from './shipmentTracking.ts'
import type { Shipment } from '../contracts.ts'
import type { AppState } from '../../types.ts'

const trip = (over: Partial<Shipment> & Pick<Partial<Shipment>, 'status'>): Shipment =>
  ({
    id: 'SHP-1',
    orderId: 'O-1',
    dispatchIds: ['D-1'],
    agentUserId: 'driver@roligt.local',
    vehicle: 'AP-07',
    stops: [],
    times: { created: '2026-10-15T04:00:00.000Z' },
    packaging: 'LOOSE',
    ...over,
  }) as Shipment

const state = (shipments: Shipment[]) =>
  ({ shipments }) as unknown as Partial<AppState>

const window = { from: '2026-10-01', to: '2026-10-31' }

describe('shipmentTrackingKpis', () => {
  it('counts the live board: out now, delivered today, on-time off the ETA', () => {
    const folded = shipmentTrackingKpis(
      state([
        trip({ id: 'A', status: 'Out for Delivery' }),
        trip({ id: 'B', status: 'Delivered', eta: '2026-10-15T10:00:00.000Z', times: { created: '2026-10-15T04:00:00.000Z', delivered: '2026-10-15T09:30:00.000Z' } }),
        trip({ id: 'C', status: 'Delivered', eta: '2026-10-15T10:00:00.000Z', times: { created: '2026-10-15T04:00:00.000Z', delivered: '2026-10-15T11:30:00.000Z' } }),
      ]),
      window,
      '2026-10-15',
    )
    const byKey = new Map(folded.cards.map((c) => [c.key, c]))
    expect(byKey.get('st-out')?.value).toBe(1)
    expect(byKey.get('st-delivered-today')?.value).toBe(2)
    expect(byKey.get('st-on-time')?.value).toBe(50)
    const board = folded.charts[0]
    expect(board?.rows).toEqual([
      { label: 'Out for Delivery', value: 1 },
      { label: 'Delivered', value: 2 },
    ])
  })

  it('no ETA verdicts, no on-time denominator — 0%, never NaN', () => {
    const folded = shipmentTrackingKpis(state([trip({ status: 'Created' })]), window, '2026-10-15')
    expect(folded.cards.find((c) => c.key === 'st-on-time')?.value).toBe(0)
    expect(folded.charts[0]?.rows).toEqual([{ label: 'Created', value: 1 }])
  })
})
