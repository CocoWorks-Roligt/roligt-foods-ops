/**
 * The orders-dispatch module's fold (KPI.md §Orders & Dispatch). Pipeline
 * counts read today's Order statuses (Open · Dispatched · Cancelled —
 * 'Partially Dispatched' arrives with the §2 delta and will simply appear as
 * another row); fulfilment compares window-ordered qty with window-dispatched
 * qty, per KPI.md's formula.
 *
 * Skeleton scope (B4): pipeline, fulfilment %, overdue, ordered-vs-dispatched
 * trend. D5a adds dispatch-vs-plan: no Dispatch plan stage exists
 * (PlanStage is Extraction | Melange | Packing), so the plan that feeds
 * dispatch is the stage-Packing Packs plan — the D2a packed-vs-planned rule
 * verbatim; a Litre plan never converts without an untrustworthy name join.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState, Order } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthsBetween, monthLabel } from '../reports/params.ts'
import { localDay } from '../utils.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

export function ordersDispatchKpis(
  state: Partial<AppState>,
  w: ReportWindow,
  today: string,
): KpiPayload {
  const orders = (state.orders ?? []).filter((o) => inWindow(o.date, w) && o.status !== 'Cancelled')
  const dispatches = (state.dispatches ?? []).filter((d) =>
    inWindow(localDay(d.dispatchTime), w),
  )

  const orderedQty = orders.reduce((n, o) => n + o.lines.reduce((m, l) => m + (l.qty || 0), 0), 0)
  const dispatchedQty = dispatches.reduce((n, d) => n + (d.qty || 0), 0)
  const fulfilmentPct = orderedQty ? Number(((dispatchedQty / orderedQty) * 100).toFixed(1)) : 0

  const open = orders.filter((o) => o.status === 'Open')
  const overdue = open.filter((o) => o.dueDate && o.dueDate < today)

  const cards: KpiCard[] = [
    { key: 'od-open', label: 'Open orders', value: open.length, href: '/orders?status=Open' },
    { key: 'od-overdue', label: 'Overdue', value: overdue.length, href: '/orders?status=Open&overdue=1' },
    { key: 'od-fulfilment', label: 'Fulfilment', value: fulfilmentPct, unit: '%' },
  ]

  // The pipeline chart counts every status present — rows appear as statuses do.
  const byStatus = new Map<string, number>()
  for (const o of orders) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1)
  const pipeline: KpiChart = {
    key: 'od-pipeline',
    label: 'Order pipeline',
    kind: 'bar',
    rows: [...byStatus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value })),
  }

  // Quantities are pack-count sums of like kinds (order lines and dispatch
  // lines are the same pack SKUs) — never mixed units.
  const months = monthsBetween(w)
  const orderedByMonth = new Map<string, number>(months.map((m) => [m, 0]))
  const dispatchedByMonth = new Map<string, number>(months.map((m) => [m, 0]))
  for (const o of orders as Order[]) {
    const m = localDay(o.date).slice(0, 7)
    if (orderedByMonth.has(m))
      orderedByMonth.set(m, (orderedByMonth.get(m) ?? 0) + o.lines.reduce((n, l) => n + (l.qty || 0), 0))
  }
  for (const d of dispatches) {
    const m = localDay(d.dispatchTime).slice(0, 7)
    if (dispatchedByMonth.has(m)) dispatchedByMonth.set(m, (dispatchedByMonth.get(m) ?? 0) + (d.qty || 0))
  }
  const trend: KpiChart = {
    key: 'od-fulfilment-trend',
    label: 'Ordered vs dispatched',
    kind: 'line',
    rows: months.flatMap((m) => [
      { series: 'Ordered', label: monthLabel(m), value: orderedByMonth.get(m) ?? 0 },
      { series: 'Dispatched', label: monthLabel(m), value: dispatchedByMonth.get(m) ?? 0 },
    ]),
  }

  // ── Dispatch vs plan (KPI.md's last row). The Packs plan is the plan that
  // feeds dispatch — the packing module's own packed-vs-planned rule (D2a);
  // plans in other uoms or stages never convert to pack counts.
  const plannedByMonth = new Map<string, number>(months.map((m) => [m, 0]))
  for (const p of state.productionPlans ?? []) {
    if (p.stage !== 'Packing' || p.status === 'Cancelled' || p.uom !== 'Packs') continue
    const m = p.date.slice(0, 7)
    if (plannedByMonth.has(m)) plannedByMonth.set(m, (plannedByMonth.get(m) ?? 0) + (p.qty || 0))
  }
  const dispatchVsPlan: KpiChart = {
    key: 'od-dispatch-vs-plan',
    label: 'Dispatch vs plan (packs)',
    kind: 'bar',
    rows: months.flatMap((m) => [
      { series: 'Planned', label: monthLabel(m), value: plannedByMonth.get(m) ?? 0 },
      { series: 'Dispatched', label: monthLabel(m), value: dispatchedByMonth.get(m) ?? 0 },
    ]),
  }

  return { cards, charts: [pipeline, trend, dispatchVsPlan] }
}
