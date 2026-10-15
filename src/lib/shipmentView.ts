/**
 * The shipment board's view model (SHIPMENT S1) — pure folds over the wire
 * shapes, no fetches. Same contract as every page's view lib: the page and
 * its CSV export read the same rows, and the folds are testable without a
 * renderer.
 */
import type { ShipmentDetail, ShipmentStatus } from './contracts.ts'
import type { Dispatch } from '../types.ts'

/** The statuses a trip can still move from — the badge and the busy guard's
 *  own set (api/_lib/shipments.ts ACTIVE_STATUSES), mirrored client-side. */
const ACTIVE = new Set<ShipmentStatus>(['Created', 'Dispatched', 'Out for Delivery', 'Failed', 'Rescheduled'])

export const isTripActive = (s: ShipmentStatus): boolean => ACTIVE.has(s)

/** The board's filter chips, in workflow order — not the wire's declaration order. */
export const BOARD_FILTERS: readonly (ShipmentStatus | 'All')[] = [
  'All',
  'Created',
  'Dispatched',
  'Out for Delivery',
  'Delivered',
  'Partially Delivered',
  'Returned',
  'Failed',
  'Rescheduled',
]

export interface ShipmentBoardRow {
  id: string
  orderId: string
  /** One customer, or "A +2 more" when the trip is multi-stop. */
  customers: string
  /** When it left: times.dispatched, falling back to created. */
  dispatchDate: string
  agent: string
  vehicle: string
  packaging: ShipmentDetail['shipment']['packaging']
  items: number
  status: ShipmentStatus
  eta?: string
  deliveredAt?: string
  challans: ShipmentDetail['challans']
  version: number
}

/** One detail doc → one board row. */
export function boardRow(d: ShipmentDetail): ShipmentBoardRow {
  const s = d.shipment
  const names = [...new Set(d.lines.map((l) => l.customerName))]
  return {
    id: s.id,
    orderId: s.orderId,
    customers: names.length <= 1 ? (names[0] ?? '—') : `${names[0]} +${names.length - 1} more`,
    dispatchDate: s.times.dispatched ?? s.times.created,
    agent: s.agentUserId ?? '—',
    vehicle: s.vehicle,
    packaging: s.packaging,
    items: d.lines.reduce((n, l) => n + l.qty, 0),
    status: s.status,
    eta: s.eta,
    deliveredAt: s.times.delivered,
    challans: d.challans,
    version: s.version,
  }
}

export interface ShipmentFilter {
  status: ShipmentStatus | 'All'
  q: string
}

/** Text search across the columns an operator actually names: order, customer,
 *  agent, vehicle, challan number. */
export function filterRows(rows: readonly ShipmentBoardRow[], f: ShipmentFilter): ShipmentBoardRow[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.status !== 'All' && r.status !== f.status) return false
    if (!q) return true
    const hay = [r.orderId, r.customers, r.agent, r.vehicle, ...r.challans.map((c) => c.number)]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

/** Dispatch rows free to board onto a trip: not Delivered in Classic, and not
 *  already carried by an active trip. Grouped per order for the create form. */
export function freeDispatches(
  dispatches: readonly Dispatch[],
  details: readonly ShipmentDetail[],
): { orderId: string; customerName: string; rows: Dispatch[] }[] {
  const busy = new Set(details.filter((d) => isTripActive(d.shipment.status)).flatMap((d) => d.shipment.dispatchIds))
  const free = dispatches.filter((d) => !busy.has(d.id) && d.status !== 'Delivered' && d.orderId)
  const byOrder = new Map<string, Dispatch[]>()
  for (const d of free) {
    const list = byOrder.get(d.orderId!) ?? []
    list.push(d)
    byOrder.set(d.orderId!, list)
  }
  return [...byOrder.entries()].map(([orderId, rows]) => ({
    orderId,
    customerName: rows[0]?.customerName ?? '',
    rows,
  }))
}

/** The board's own PATCH arrows: reassignment on any active trip, and the
 *  Failed→Rescheduled retry. Everything else belongs to an endpoint. */
export const canReassign = (s: ShipmentStatus): boolean => isTripActive(s)
export const canReschedule = (s: ShipmentStatus): boolean => s === 'Failed'
