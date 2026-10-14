/**
 * The shipment-tracking module's fold (KPI.md §Shipment Tracking). The live
 * board numbers only — status counts, out-now, delivered-today, on-time — the
 * same figures the Shipment Tracking page's cards and sidebar badge read. The
 * cached daily folds (avg delivery time by agent, agent performance) are
 * Phase 5 module work, per the KPI skeleton note.
 *
 * Shipments are a server-endpoint-only collection: the fold reads them off
 * the documents state the KPI layer hands it, never off an AppState key.
 */

import type { Shipment } from '../contracts.ts'
import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow } from '../reports/params.ts'
import { localDay } from '../utils.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

/** The shipments the documents state carries — not (and never) an AppState key. */
type WithShipments = Partial<AppState> & { shipments?: Shipment[] }

export function shipmentTrackingKpis(
  state: Partial<AppState>,
  w: ReportWindow,
  today: string,
): KpiPayload {
  const shipments = ((state as WithShipments).shipments ?? []).filter((s) =>
    inWindow(localDay(s.times.created), w),
  )

  const out = shipments.filter((s) => s.status === 'Out for Delivery')
  const deliveredToday = shipments.filter(
    (s) => s.status === 'Delivered' && localDay(s.times.delivered ?? '') === today,
  )
  // On-time: delivered at or before the trip's ETA (KPI.md's formula — the
  // seed formula's `expected` vs deliveredTime stays the Classic dispatch
  // view; this is the shipment view).
  const withEta = shipments.filter((s) => s.eta && s.times.delivered)
  const onTime = withEta.filter((s) => (s.times.delivered ?? '') <= (s.eta ?? ''))
  const onTimePct = withEta.length ? Number(((onTime.length / withEta.length) * 100).toFixed(1)) : 0

  const cards: KpiCard[] = [
    { key: 'st-out', label: 'Out for delivery', value: out.length, href: '/shipments?status=Out for Delivery' },
    { key: 'st-delivered-today', label: 'Delivered today', value: deliveredToday.length, href: '/shipments?status=Delivered' },
    { key: 'st-on-time', label: 'On-time', value: onTimePct, unit: '%' },
  ]

  // The status board — every status the machine has a trip in, machine order.
  const statusOrder = [
    'Created',
    'Dispatched',
    'Out for Delivery',
    'Delivered',
    'Partially Delivered',
    'Returned',
    'Failed',
    'Rescheduled',
  ]
  const byStatus = new Map<string, number>()
  for (const s of shipments) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1)
  const board: KpiChart = {
    key: 'st-board',
    label: 'Trips by status',
    kind: 'bar',
    rows: statusOrder
      .filter((st) => (byStatus.get(st) ?? 0) > 0)
      .map((label) => ({ label, value: byStatus.get(label) ?? 0 })),
  }

  return { cards, charts: [board] }
}
