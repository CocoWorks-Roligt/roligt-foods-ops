/**
 * The qc module's fold — the B4 reference implementation of a KPI fold: the
 * same wire shape every module answers (KpiCard/KpiChart, contracts), the same
 * math the live Quality report reads (this calls qualityReport, so the two can
 * never disagree), plus the module-specific pieces the report does not carry
 * (pending-queue aging). Definitions: KPI.md §QC.
 *
 * Skeleton scope (B4): pass/fail trend, pending count, release rate, pending
 * aging. Control charts, out-of-spec alerts, turnaround and quarantine volume
 * wait on the §2 qcs.results limits + ledger folds and land with the module's
 * full build (Phase 5).
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { qualityReport } from '../reports/qualityReport.ts'
import { localDay } from '../utils.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'

export interface KpiPayload {
  cards: KpiCard[]
  charts: KpiChart[]
}

const AGING_BUCKETS: { label: string; maxDays: number }[] = [
  { label: '0–2 days', maxDays: 2 },
  { label: '3–7 days', maxDays: 7 },
  { label: '8–14 days', maxDays: 14 },
  { label: '15+ days', maxDays: Infinity },
]

const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000)

export function qcKpis(state: Partial<AppState>, w: ReportWindow, today: string): KpiPayload {
  const report = qualityReport(
    {
      qcs: state.qcs ?? [],
      batches: state.batches ?? [],
      items: state.items ?? [],
    },
    w,
  )

  const totals = report.byMonth.reduce(
    (acc, m) => {
      acc.records += m.records
      acc.released += m.released
      acc.rejected += m.rejected
      acc.pending += m.pending
      return acc
    },
    { records: 0, released: 0, rejected: 0, pending: 0 },
  )
  const releasePct = totals.records ? Number(((totals.released / totals.records) * 100).toFixed(1)) : 0

  const cards: KpiCard[] = [
    { key: 'qc-pending', label: 'Pending QC', value: totals.pending, href: '/quality?disposition=Pending' },
    { key: 'qc-release-rate', label: 'Release rate', value: releasePct, unit: '%' },
    { key: 'qc-rejected', label: 'Rejected', value: totals.rejected, href: '/quality?disposition=Rejected' },
  ]

  const trend: KpiChart = {
    key: 'qc-passfail-trend',
    label: 'Dispositions by month',
    kind: 'line',
    rows: report.byMonth.flatMap((m) => [
      { series: 'Released', label: m.key, value: m.released },
      { series: 'Rejected', label: m.key, value: m.rejected },
      { series: 'Pending', label: m.key, value: m.pending },
    ]),
  }

  // Aging: a pending record ages from the day its batch was run — a pending
  // record has decided nothing yet, so there is no reviewedAt to age from.
  const buckets = new Map<string, number>(AGING_BUCKETS.map((b) => [b.label, 0]))
  for (const q of state.qcs ?? []) {
    if (q.disposition === 'Pending') {
      const made = state.batches?.find((b) => b.id === q.batchId)?.date
      if (!made) continue
      const days = daysBetween(localDay(made), today)
      const bucket = AGING_BUCKETS.find((b) => days <= b.maxDays) ?? AGING_BUCKETS[AGING_BUCKETS.length - 1]
      buckets.set(bucket.label, (buckets.get(bucket.label) ?? 0) + 1)
    }
  }
  const aging: KpiChart = {
    key: 'qc-pending-aging',
    label: 'Pending queue aging',
    kind: 'bar',
    rows: AGING_BUCKETS.map((b) => ({ label: b.label, value: buckets.get(b.label) ?? 0 })),
  }

  return { cards, charts: [trend, aging] }
}
