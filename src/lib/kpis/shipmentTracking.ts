/**
 * The shipment-tracking module's fold (KPI.md §Shipment Tracking), grown to
 * its full build in D5a: the live board numbers (B5b) plus the cached daily
 * folds — avg delivery time by agent, agent performance (volume + on-time %),
 * and the failed/returned reasons pareto.
 *
 * ONE window rule for the module: a trip rides the window by its times.created
 * (the register windows the same way — D1b invariant), and events/returns hang
 * off their trip, so an event of an out-of-window trip never counts. Failure
 * reasons read payload.reason — the board's own lastFailReason vocabulary —
 * and return lines their own reason words; the two never merge into invented
 * categories.
 *
 * Shipments, delivery events and returns are server-endpoint-only
 * collections: the fold reads them off the documents state the KPI layer
 * hands it, never off an AppState key.
 */

import type { Shipment, DeliveryEvent, ReturnRecord } from '../contracts.ts'
import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow } from '../reports/params.ts'
import { localDay } from '../utils.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

/** The documents state the KPI layer hands the fold — not (and never) AppState keys. */
type DocumentsState = Partial<AppState> & {
  shipments?: Shipment[]
  delivery_events?: DeliveryEvent[]
  returns?: ReturnRecord[]
}

/** An event's failure reason — the board drawer's own read (lastFailReason). */
const eventReason = (e: DeliveryEvent): string =>
  typeof e.payload?.reason === 'string' && e.payload.reason.trim() ? e.payload.reason.trim() : ''

export function shipmentTrackingKpis(
  state: Partial<AppState>,
  w: ReportWindow,
  today: string,
): KpiPayload {
  const docs = state as DocumentsState
  const shipments = (docs.shipments ?? []).filter((s) =>
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

  // ── Avg delivery time (KPI.md: times.delivered − times.dispatched) ─────────
  const durations = shipments
    .filter((s) => s.times.dispatched && s.times.delivered)
    .map((s) => (Date.parse(s.times.delivered as string) - Date.parse(s.times.dispatched as string)) / 3_600_000)
  const avgHours = durations.length
    ? Number((durations.reduce((n, h) => n + h, 0) / durations.length).toFixed(1))
    : 0

  const cards: KpiCard[] = [
    { key: 'st-out', label: 'Out for delivery', value: out.length, href: '/shipments?status=Out for Delivery' },
    { key: 'st-delivered-today', label: 'Delivered today', value: deliveredToday.length, href: '/shipments?status=Delivered' },
    { key: 'st-on-time', label: 'On-time', value: onTimePct, unit: '%' },
    { key: 'st-avg-delivery', label: 'Avg delivery time', value: avgHours, unit: 'h' },
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

  // ── Agent folds. The label is agentUserId itself — a users-name join does
  // not exist in the documents state and an email is readable (logged gap).
  const agentOf = (s: Shipment): string => s.agentUserId || 'Unassigned'
  const agents = [...new Set(shipments.filter((s) => s.times.delivered).map(agentOf))].sort()
  const hoursByAgent = new Map<string, number[]>(agents.map((a) => [a, []]))
  const volumeByAgent = new Map<string, number>(agents.map((a) => [a, 0]))
  const onTimeByAgent = new Map<string, { n: number; on: number }>(agents.map((a) => [a, { n: 0, on: 0 }]))
  for (const s of shipments) {
    if (!s.times.delivered) continue
    const a = agentOf(s)
    volumeByAgent.set(a, (volumeByAgent.get(a) ?? 0) + 1)
    if (s.times.dispatched) {
      hoursByAgent.get(a)?.push(
        (Date.parse(s.times.delivered) - Date.parse(s.times.dispatched)) / 3_600_000,
      )
    }
    if (s.eta) {
      const slot = onTimeByAgent.get(a) ?? { n: 0, on: 0 }
      slot.n += 1
      if (s.times.delivered <= s.eta) slot.on += 1
      onTimeByAgent.set(a, slot)
    }
  }
  const avgByAgent: KpiChart = {
    key: 'st-avg-by-agent',
    label: 'Avg delivery time by agent (h)',
    kind: 'bar',
    rows: agents.flatMap((a) => {
      const hs = hoursByAgent.get(a) ?? []
      if (!hs.length) return []
      return [{ label: a, value: Number((hs.reduce((n, h) => n + h, 0) / hs.length).toFixed(1)) }]
    }),
  }
  const volumeChart: KpiChart = {
    key: 'st-agent-volume',
    label: 'Deliveries by agent',
    kind: 'bar',
    rows: agents.map((a) => ({ label: a, value: volumeByAgent.get(a) ?? 0 })),
  }
  const onTimeChart: KpiChart = {
    key: 'st-agent-on-time',
    label: 'On-time % by agent',
    kind: 'bar',
    rows: agents.flatMap((a) => {
      const slot = onTimeByAgent.get(a)
      if (!slot?.n) return []
      return [{ label: a, value: Number(((slot.on / slot.n) * 100).toFixed(1)) }]
    }),
  }

  // ── Failed/returned reasons (KPI.md: delivery_events failed/rescheduled +
  // returns reasons). Events and returns window by their TRIP's created day —
  // the module's one rule; an orphan whose trip is missing never counts.
  const windowedIds = new Set(shipments.map((s) => s.id))
  const reasons = new Map<string, number>()
  for (const e of docs.delivery_events ?? []) {
    if (!windowedIds.has(e.shipmentId)) continue
    if (e.type !== 'failed' && e.type !== 'rescheduled') continue
    const reason = eventReason(e)
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  for (const r of docs.returns ?? []) {
    if (!windowedIds.has(r.shipmentId)) continue
    for (const line of r.lines) {
      if (line.reason.trim()) reasons.set(line.reason.trim(), (reasons.get(line.reason.trim()) ?? 0) + 1)
    }
  }
  const reasonsChart: KpiChart = {
    key: 'st-fail-reasons',
    label: 'Failed & returned — by reason',
    kind: 'bar',
    rows: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
  }

  return { cards, charts: [board, avgByAgent, volumeChart, onTimeChart, reasonsChart] }
}
