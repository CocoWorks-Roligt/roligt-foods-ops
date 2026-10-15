/**
 * The packing module's fold (KPI.md §Packing). Everything rides what the
 * packing runs stamped — packs per line, drawn bulk, the product master the
 * lines name. A packing run posts complete (W10: no close, no queue), so the
 * module's movements are all by run date and its one queue-shaped number is
 * none of its own making.
 *
 * Honest gaps, logged in DECISIONS (P5 D2a): THROUGHPUT PER SHIFT needs a
 * shiftId no packing run carries — packs by month is the honest cut (shifts
 * exist as staff assignments, but nothing ties a run to one). PACKED VS
 * PLANNED counts only plans entered for stage Packing in Packs — a plan in
 * Litres does not convert to packs without a product join the free-text
 * product name cannot be trusted to make. FILL-STAGE SPOILAGE records have
 * no writer today (a packing run has no close to file one; rejects at fill
 * are not reason-coded anywhere yet) — the pareto renders empty, honestly,
 * until a writer the design agrees on exists.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState, Product } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { packLabel } from '../packs.ts'
import type { ProductExtension, SpoilageRecord } from '../contracts.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

type WithDocs = Partial<AppState> & { spoilage_records?: SpoilageRecord[] }
type ProductDoc = Product & Partial<ProductExtension>

/** The backfill's own rule (backfillPhase2.inferPackFormat, verbatim in
 *  spirit — W6 receiptStage precedent): a stamped packFormat answers first;
 *  an unstamped product derives off its name and admin-named type, so the
 *  chart and the eventual stamp can never disagree. Exported for the packing
 *  register — one implementation decides BIB everywhere. */
export const packFormatOf = (p: ProductDoc): 'bib' | 'glass' =>
  p.packFormat ?? (`${p.name} ${p.type}`.toLowerCase().includes('bib') ? 'bib' : 'glass')

export function packingKpis(state: Partial<AppState>, w: ReportWindow, _today: string): KpiPayload {
  const products = state.products ?? []
  const productOf = (sku: string): ProductDoc | undefined => products.find((p) => p.id === sku)
  const runs = (state.packingRuns ?? []).filter((r) => inWindow(r.date, w))
  const packsOf = (r: { lines: { packs: number }[] }): number =>
    r.lines.reduce((a, l) => a + (l.packs || 0), 0)

  // ── Throughput: packs by month (per-shift needs a shiftId no run carries) ──
  const byMonth = new Map<string, number>()
  for (const r of runs) {
    const m = monthOf(r.date)
    byMonth.set(m, (byMonth.get(m) ?? 0) + packsOf(r))
  }
  const months = [...byMonth.keys()].sort()
  const throughput: KpiChart = {
    key: 'pk-throughput',
    label: 'Packs filled by month',
    kind: 'line',
    rows: months.map((m) => ({ label: m, value: byMonth.get(m) ?? 0 })),
  }

  // ── Packed vs planned (stage Packing, uom Packs — Litre plans don't convert)
  const plannedByMonth = new Map<string, number>()
  for (const p of (state.productionPlans ?? [])) {
    if (p.stage !== 'Packing' || p.status === 'Cancelled' || p.uom !== 'Packs') continue
    if (!inWindow(p.date, w)) continue
    const m = monthOf(p.date)
    plannedByMonth.set(m, (plannedByMonth.get(m) ?? 0) + p.qty)
  }
  const planMonths = [...new Set([...plannedByMonth.keys(), ...months])].sort()
  const packedVsPlanned: KpiChart = {
    key: 'pk-packed-vs-planned',
    label: 'Packed vs planned (packs)',
    kind: 'bar',
    rows: planMonths.flatMap((m) => [
      { series: 'Planned', label: m, value: plannedByMonth.get(m) ?? 0 },
      { series: 'Packed', label: m, value: byMonth.get(m) ?? 0 },
    ]),
  }

  // ── Format mix and size mix, off the product master the lines name ────────
  const byFormat = new Map<string, number>()
  const bySize = new Map<string, number>()
  for (const r of runs) {
    for (const l of r.lines) {
      const p = productOf(l.sku)
      const format = p ? packFormatOf(p) : 'unknown'
      byFormat.set(format, (byFormat.get(format) ?? 0) + (l.packs || 0))
      const size = p ? packLabel(p) : l.sku
      bySize.set(size, (bySize.get(size) ?? 0) + (l.packs || 0))
    }
  }
  const formatChart: KpiChart = {
    key: 'pk-format-mix',
    label: 'Glass vs BIB packs',
    kind: 'bar',
    rows: [...byFormat.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
  }
  const sizeChart: KpiChart = {
    key: 'pk-size-mix',
    label: 'Packs by size',
    kind: 'bar',
    rows: [...bySize.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
  }

  // ── Fill-stage spoilage pareto (no writer yet — honest empty until one is
  //    designed; windowed by the record's own day, the only date it has) ────
  const fillSPO = ((state as WithDocs).spoilage_records ?? []).filter(
    (r) => r.stage === 'fill' && inWindow(r.at.slice(0, 10), w),
  )
  const pareto = new Map<string, number>()
  for (const r of fillSPO) pareto.set(r.reasonCode, (pareto.get(r.reasonCode) ?? 0) + r.qty)
  const fillChart: KpiChart = {
    key: 'pk-fill-spoilage',
    label: 'Fill-stage spoilage by reason',
    kind: 'bar',
    rows: [...pareto.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value: Number(value.toFixed(1)) })),
  }

  const packs = runs.reduce((a, r) => a + packsOf(r), 0)
  const bibPacks = [...byFormat.entries()].filter(([f]) => f === 'bib').reduce((a, [, v]) => a + v, 0)

  const cards: KpiCard[] = [
    { key: 'pk-packs', label: 'Packs filled', value: packs, href: '/packing' },
    { key: 'pk-runs', label: 'Packing runs', value: runs.length, href: '/packing' },
    { key: 'pk-bib-share', label: 'BIB share', value: packs ? Number(((bibPacks / packs) * 100).toFixed(1)) : 0, unit: '%' },
    { key: 'pk-fill-spoilage', label: 'Fill spoilage records', value: fillSPO.length },
  ]

  return { cards, charts: [throughput, packedVsPlanned, formatChart, sizeChart, fillChart] }
}
