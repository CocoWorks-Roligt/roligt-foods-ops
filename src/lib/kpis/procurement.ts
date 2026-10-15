/**
 * The procurement module's fold (KPI.md §Procurement). The PO metrics the
 * catalog blocked on the purchase_orders entity are live now (W3): the status
 * funnel, the deliveries calendar, and supplier on-time % — computed off the
 * PO's OWN linkage (receivedGrnIds → the GRN's posted date vs expectedOn).
 * Spend and intake ride the same receipt rows the lot report reads.
 *
 * Honest gaps, logged in DECISIONS (P5): supplier LEAD TIME needs a sentAt on
 * the PO doc (no such field on the wire — avg(expectedOn) would be a guess,
 * not a lead time); days-of-stock-left needs the ledger fold + per-material
 * conversions and lands with the Inventory module's build.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { isFruitReceipt, receiptSupplier } from '../reports/procurement.ts'
import type { PurchaseOrder } from '../contracts.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

/** The documents collections the fold reads — not (and never) AppState keys. */
type WithDocs = Partial<AppState> & { purchase_orders?: PurchaseOrder[] }

/** PO statuses in the machine's own order — the funnel's bars. */
const PO_ORDER = ['draft', 'sent', 'acknowledged', 'received', 'closed'] as const

export function procurementKpis(state: Partial<AppState>, w: ReportWindow, _today: string): KpiPayload {
  // A PO with a promised day sits in its day's window; one without cannot be
  // placed anywhere in time, and hiding it would empty the funnel of drafts —
  // so un-promised POs count in whatever window is open.
  const pos = ((state as WithDocs).purchase_orders ?? []).filter(
    (p) => !p.expectedOn || inWindow(p.expectedOn, w),
  )
  const grns = state.grns ?? []
  const windowGrns = grns.filter((g) => inWindow(g.date, w))
  const vendors = state.vendors ?? []
  const vendorName = (id: string): string => vendors.find((v) => v.id === id)?.name || id || '—'

  // The funnel: every non-cancelled PO in the window, counted where it stands.
  const byStatus = new Map<string, number>()
  for (const p of pos) {
    if (p.status === 'cancelled') continue
    byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1)
  }
  const funnel: KpiChart = {
    key: 'proc-po-funnel',
    label: 'Purchase orders by status',
    kind: 'bar',
    rows: PO_ORDER.map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: byStatus.get(s) ?? 0 })),
  }

  // On-time: a PO is on time when its FIRST linked receipt landed on or before
  // the day the vendor promised. POs without a promised day do not answer.
  const grnDate = new Map<string, string>()
  for (const g of grns) grnDate.set(g.id, g.date)
  const judged = pos.filter((p) => p.expectedOn && p.receivedGrnIds.length > 0)
  const onTimeOf = (p: PurchaseOrder): boolean => {
    const dates = p.receivedGrnIds.map((id) => grnDate.get(id)).filter((d): d is string => !!d)
    if (!dates.length) return false
    return dates.sort()[0] <= (p.expectedOn as string)
  }
  const onTimeCount = judged.filter(onTimeOf).length
  const onTimePct = judged.length ? Number(((onTimeCount / judged.length) * 100).toFixed(1)) : 0

  const onTimeByVendor: KpiChart = {
    key: 'proc-vendor-ontime',
    label: 'Supplier on-time %',
    kind: 'bar',
    rows: Object.entries(
      judged.reduce<Record<string, { ok: number; n: number }>>((acc, p) => {
        const k = vendorName(p.vendorId)
        acc[k] = acc[k] ?? { ok: 0, n: 0 }
        acc[k].n += 1
        if (onTimeOf(p)) acc[k].ok += 1
        return acc
      }, {}),
    ).map(([label, { ok, n }]) => ({ label, value: Number(((ok / n) * 100).toFixed(1)) })),
  }

  const spendByMonth = new Map<string, number>()
  for (const g of windowGrns) {
    const m = monthOf(g.date)
    spendByMonth.set(m, (spendByMonth.get(m) ?? 0) + (g.landed ?? 0))
  }
  const spend: KpiChart = {
    key: 'proc-spend-trend',
    label: 'Spend by month',
    kind: 'line',
    rows: [...spendByMonth.entries()].sort().map(([label, value]) => ({ label, value: Math.round(value) })),
  }

  // The deliveries calendar: open POs owed by their promised day.
  const OPEN = new Set(['draft', 'sent', 'acknowledged'])
  const openPos = pos.filter((p) => OPEN.has(p.status))
  const owedByDay = new Map<string, number>()
  for (const p of openPos) {
    if (!p.expectedOn) continue
    owedByDay.set(p.expectedOn, (owedByDay.get(p.expectedOn) ?? 0) + 1)
  }
  const calendar: KpiChart = {
    key: 'proc-deliveries-calendar',
    label: 'Pending deliveries by promised day',
    kind: 'bar',
    rows: [...owedByDay.entries()].sort().map(([label, value]) => ({ label, value })),
  }

  // Coconut intake by supplier — the accepted nut count, coconut receipts
  // only, named by the lot report's own supplier vocabulary (receiptSupplier:
  // the farmer named on the receipt, or the vendor's name).
  const full = { ...state, purchaseProducts: state.purchaseProducts ?? [] } as AppState
  const coconutByVendor = new Map<string, number>()
  for (const g of windowGrns) {
    if (isFruitReceipt(full, g)) continue
    const name = receiptSupplier(g)
    coconutByVendor.set(name, (coconutByVendor.get(name) ?? 0) + g.accepted)
  }
  const intake: KpiChart = {
    key: 'proc-coconut-intake',
    label: 'Coconut intake by supplier',
    kind: 'bar',
    rows: [...coconutByVendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })),
  }

  const cards: KpiCard[] = [
    { key: 'proc-open-pos', label: 'Open POs', value: openPos.length, href: '/procurement?tab=po' },
    { key: 'proc-receipts', label: 'Receipts', value: windowGrns.length, href: '/procurement' },
    {
      key: 'proc-spend',
      label: 'Spend',
      value: Math.round([...spendByMonth.values()].reduce((a, b) => a + b, 0)),
      unit: '₹',
    },
    { key: 'proc-ontime', label: 'Supplier on-time', value: onTimePct, unit: '%' },
  ]

  return { cards, charts: [funnel, spend, calendar, onTimeByVendor, intake] }
}
