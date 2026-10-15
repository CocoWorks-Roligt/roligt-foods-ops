/**
 * The grading-extraction module's fold (KPI.md §Grading + §Extraction). Grade
 * figures ride the receipt as posted (rates and grades are frozen at posting
 * by design); extraction figures ride what the CLOSE stamped — the yield off
 * the run's own source/output lines, the spoilage off the spoilage_records
 * documents (closed runs only: Classic runs never owed one), the variance and
 * cycle time off the batch's massBalance/stageTimes stamps.
 *
 * Honest gaps, logged in DECISIONS (P5): the per-100 yield has no recipe
 * TARGET line yet (batches carry recipeId but targets are not seeded as
 * numbers — the window average is not a target and is not drawn); variance is
 * charted per closed batch with no tolerance row (the tolerance is config,
 * not data). Water per 100 = litres; malai per 100 = kg — the units are the
 * run's own, never summed across.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState, Batch } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { isFruitReceipt } from '../reports/procurement.ts'
import type { MassBalanceResult, SpoilageRecord } from '../contracts.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

type WithDocs = Partial<AppState> & { spoilage_records?: SpoilageRecord[] }

/** What the close stamps, read off the stored batch doc. */
type ClosedBatch = Batch & {
  stageTimes?: { started?: string; closed?: string }
  massBalance?: MassBalanceResult
}

const isExtraction = (b: Batch): boolean => b.kind === 'Extraction'

const HOURS = 3_600_000

export function gradingExtractionKpis(state: Partial<AppState>, w: ReportWindow, _today: string): KpiPayload {
  // isFruitReceipt reads purchaseProducts; default it so a caller's Partial
  // state (the KPI layer folds only the spec's collections) cannot crash it.
  const full = { ...state, purchaseProducts: state.purchaseProducts ?? [] } as AppState
  const grns = (state.grns ?? []).filter((g) => inWindow(g.date, w))
  const coconutGrns = grns.filter((g) => !isFruitReceipt(full, g))
  const batches = (state.batches ?? []) as ClosedBatch[]
  const windowBatches = batches.filter((b) => inWindow(b.date, w))
  const extractions = windowBatches.filter(isExtraction)
  const spoilage = ((state as WithDocs).spoilage_records ?? []).filter((r) =>
    windowBatches.some((b) => b.id === r.batchId),
  )

  // ── Grading: mix trend, reject trend, per-lot distribution ───────────────
  const mixByMonth = new Map<string, { a: number; b: number; c: number; reject: number }>()
  for (const g of coconutGrns) {
    const m = monthOf(g.date)
    const acc = mixByMonth.get(m) ?? { a: 0, b: 0, c: 0, reject: 0 }
    acc.a += g.a
    acc.b += g.b
    acc.c += g.c
    acc.reject += g.reject
    mixByMonth.set(m, acc)
  }
  const months = [...mixByMonth.keys()].sort()
  const mixTrend: KpiChart = {
    key: 'ge-grade-mix-trend',
    label: 'Grade mix by month',
    kind: 'stacked',
    rows: months.flatMap((m) => {
      const t = mixByMonth.get(m) as { a: number; b: number; c: number; reject: number }
      return [
        { series: 'A', label: m, value: t.a },
        { series: 'B', label: m, value: t.b },
        { series: 'C', label: m, value: t.c },
        { series: 'Reject', label: m, value: t.reject },
      ]
    }),
  }
  const rejectTrend: KpiChart = {
    key: 'ge-reject-pct-trend',
    label: 'Reject % by month',
    kind: 'line',
    rows: months.map((m) => {
      const t = mixByMonth.get(m) as { a: number; b: number; c: number; reject: number }
      const total = t.a + t.b + t.c + t.reject
      return { label: m, value: total ? Number(((t.reject / total) * 100).toFixed(1)) : 0 }
    }),
  }
  const recentLots = [...coconutGrns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
  const lotDist: KpiChart = {
    key: 'ge-grade-dist-lots',
    label: 'Grade distribution — recent lots',
    kind: 'stacked',
    rows: recentLots.reverse().flatMap((g) => [
      { series: 'A', label: g.lot, value: g.a },
      { series: 'B', label: g.lot, value: g.b },
      { series: 'C', label: g.lot, value: g.c },
      { series: 'Reject', label: g.lot, value: g.reject },
    ]),
  }

  // ── Extraction: yield per 100, spoilage Pareto, variance, cycle time ─────
  const yieldByMonth = new Map<string, { nuts: number; water: number; malai: number }>()
  for (const b of extractions) {
    const m = monthOf(b.date)
    const acc = yieldByMonth.get(m) ?? { nuts: 0, water: 0, malai: 0 }
    for (const s of b.sourceLines ?? []) {
      if ((s.uom ?? 'Piece') === 'Piece') acc.nuts += s.qty
    }
    for (const o of b.outputLines ?? []) {
      // Malai books uom 'Kg' (lib/batches' own spelling); water books 'L'.
      const uom = (o.uom ?? '').toLowerCase()
      if (uom === 'l') acc.water += o.qty
      else if (uom === 'kg') acc.malai += o.qty
    }
    yieldByMonth.set(m, acc)
  }
  const yieldChart: KpiChart = {
    key: 'ge-yield-per-100',
    label: 'Yield per 100 coconuts',
    kind: 'line',
    rows: [...yieldByMonth.keys()].sort().flatMap((m) => {
      const t = yieldByMonth.get(m) as { nuts: number; water: number; malai: number }
      const hundreds = t.nuts / 100
      if (!hundreds) return []
      return [
        { series: 'Water (L)', label: m, value: Number((t.water / hundreds).toFixed(1)) },
        { series: 'Malai (kg)', label: m, value: Number((t.malai / hundreds).toFixed(1)) },
      ]
    }),
  }

  const pareto = new Map<string, number>()
  for (const r of spoilage) pareto.set(r.reasonCode, (pareto.get(r.reasonCode) ?? 0) + r.qty)
  const spoilagePareto: KpiChart = {
    key: 'ge-spoilage-pareto',
    label: 'Spoilage by reason',
    kind: 'bar',
    rows: [...pareto.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value: Number(value.toFixed(1)) })),
  }

  const closed = extractions.filter((b) => b.massBalance && b.stageTimes?.closed)
  const variance: KpiChart = {
    key: 'ge-mass-balance-variance',
    label: 'Mass-balance variance % (closed runs)',
    kind: 'bar',
    rows: closed.map((b) => ({ label: b.id, value: Number((b.massBalance as MassBalanceResult).variancePct.toFixed(2)) })),
  }
  const cycle: KpiChart = {
    key: 'ge-cycle-time',
    label: 'Cycle time — hours start to close',
    kind: 'line',
    rows: closed
      .filter((b) => b.stageTimes?.started && b.stageTimes?.closed)
      .sort((a, b) => (a.stageTimes?.closed ?? '').localeCompare(b.stageTimes?.closed ?? ''))
      .map((b) => ({
        label: monthOf(b.stageTimes?.closed ?? b.date),
        value: Number(((Date.parse(b.stageTimes?.closed ?? '') - Date.parse(b.stageTimes?.started ?? '')) / HOURS).toFixed(1)),
      })),
  }

  const totalGrades = coconutGrns.reduce((t, g) => t + g.a + g.b + g.c + g.reject, 0)
  const rejectPct = totalGrades ? Number(((coconutGrns.reduce((t, g) => t + g.reject, 0) / totalGrades) * 100).toFixed(1)) : 0
  const lastYield = [...yieldChart.rows].filter((r) => r.series === 'Water (L)').at(-1)?.value ?? 0

  const cards: KpiCard[] = [
    { key: 'ge-reject-pct', label: 'Reject %', value: rejectPct, unit: '%' },
    { key: 'ge-water-per-100', label: 'Water / 100 nuts', value: lastYield, unit: 'L' },
    { key: 'ge-spoilage-events', label: 'Spoilage records', value: spoilage.length },
    { key: 'ge-extractions', label: 'Extraction runs', value: extractions.length, href: '/production?stage=run' },
  ]

  return { cards, charts: [mixTrend, rejectTrend, lotDist, yieldChart, spoilagePareto, variance, cycle] }
}
