/**
 * The packaging-materials module's fold (KPI.md §Packaging Materials). The
 * position and the window both ride itemFlows — the classic PM report's own
 * engine — so the dashboard, the report and the D4b register count the same
 * rows: closing/belowReorder at today is the position (a two-sided `today`
 * window is itemFlows' own "balance of every line up to the window's end"),
 * and received/issued come from the caller's window. Reorder is the report's
 * own rule (items.reorder > 0); the sidebar badge's lowStockItems keeps its
 * lowStockPacks fallback — a pre-existing second rule for alerts, unchanged.
 *
 * Honest gaps, logged in DECISIONS (P5 D4a): BOXED VS LOOSE, PER-CUSTOMER
 * CARTON USE and CARTON RECONCILIATION all need the §3.3-9 carton master and
 * dispatch_v2's per-line packaging decisions, neither of which exists
 * (shipments read LOOSE by design, B5a; W15 deferred the carton step) — no
 * chart is fabricated for them. MIN/MAX bands beyond the single reorder level
 * wait on the items.min_stock/max_stock fields (§2).
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { itemFlows, lineDay, ISSUE_TYPES } from '../reports/inventoryReports.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

const PM_TYPES = ['Packing Material']

export function packagingMaterialsKpis(state: Partial<AppState>, w: ReportWindow, today: string): KpiPayload {
  // itemFlows reads items + ledger — exactly the module's declared collections;
  // the cast only satisfies its AppState signature.
  const s = state as AppState
  // The position: closing at a {today, today} window is the balance of every
  // line up to today — the report's own arithmetic, not a re-derived one.
  const position = itemFlows(s, { from: today, to: today }, PM_TYPES)
  const windowFlows = itemFlows(s, w, PM_TYPES)

  // ── Stock vs reorder level: the report's belowReorder pairs, uom on the label
  const withLevel = position.filter((r) => r.reorder !== null)
  const stockVsReorder: KpiChart = {
    key: 'pm-stock-vs-reorder',
    label: 'On hand vs reorder level',
    kind: 'bar',
    rows: withLevel.flatMap((r) => [
      { series: 'On hand', label: `${r.name} (${r.uom})`, value: r.closing },
      { series: 'Reorder', label: `${r.name} (${r.uom})`, value: r.reorder ?? 0 },
    ]),
  }

  // ── Consumption by month, one series per uom — never summed across uoms ────
  const pmItems = new Set((s.items ?? []).filter((i) => i.type === 'Packing Material').map((i) => i.id))
  const byMonth = new Map<string, number>() // `${uom}\u0000${month}` → qty issued
  const byItem = new Map<string, { name: string; uom: string; qty: number }>()
  for (const l of s.ledger ?? []) {
    if (!pmItems.has(l.item) || !ISSUE_TYPES.includes(l.type)) continue
    const day = lineDay(l)
    if (!inWindow(day, w)) continue
    const m = monthOf(day)
    const mk = `${l.uom}\u0000${m}`
    byMonth.set(mk, (byMonth.get(mk) ?? 0) + (l.qtyOut || 0))
    const acc = byItem.get(l.item) ?? {
      name: s.items.find((i) => i.id === l.item)!.name, // pmItems membership implies the master
      uom: l.uom,
      qty: 0,
    }
    acc.qty += l.qtyOut || 0
    byItem.set(l.item, acc)
  }
  const consumption: KpiChart = {
    key: 'pm-consumption',
    label: 'Consumption by month',
    kind: 'line',
    rows: [...byMonth.entries()]
      .sort(([a], [b]) => a.split('\u0000')[1].localeCompare(b.split('\u0000')[1]) || a.localeCompare(b))
      .map(([k, v]) => {
        const [uom, m] = k.split('\u0000')
        return { series: uom, label: m, value: Number(v.toFixed(1)) }
      }),
  }
  const mostConsumed: KpiChart = {
    key: 'pm-most-consumed',
    label: 'Most consumed materials',
    kind: 'bar',
    rows: [...byItem.entries()]
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, 8)
      .map(([, a]) => ({ label: `${a.name} (${a.uom})`, value: Number(a.qty.toFixed(1)) })),
  }

  const cards: KpiCard[] = [
    {
      key: 'pm-below-reorder',
      label: 'Below reorder level',
      value: position.filter((r) => r.belowReorder).length,
      href: '/packing-materials',
    },
    { key: 'pm-stocked', label: 'Materials stocked', value: position.length, href: '/packing-materials' },
    {
      key: 'pm-value',
      label: 'Stock value',
      value: Number(position.reduce((a, r) => a + r.closingValue, 0).toFixed(0)),
      unit: '₹',
    },
    { key: 'pm-received', label: 'Materials received', value: windowFlows.filter((r) => r.received > 0).length },
  ]

  return { cards, charts: [stockVsReorder, consumption, mostConsumed] }
}
