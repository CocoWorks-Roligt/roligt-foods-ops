/**
 * The qc module's fold (KPI.md §QC). The pass/fail trend rides qualityReport —
 * the same math the live Quality report reads, so the two can never disagree —
 * plus the module pieces the report does not carry: pending-queue aging,
 * turnaround, failed tests by category, and the quarantine position.
 *
 * Honest gaps, logged in DECISIONS (P5 D3a): CONTROL CHARTS and numeric
 * OUT-OF-SPEC ALERTS need parameter RESULTS as numbers against configurable
 * spec limits — a QC test records a Pass/Fail/Retest status, never a reading,
 * and no limits exist anywhere. The discrete truth is charted instead: FAILED
 * TESTS BY CATEGORY. Turnaround ages a DECIDED record only (Released or
 * Rejected — a Retest is still on the bench) from its batch's day to its
 * review's day. Quarantine volume is a POSITION (ledger-derived, unwindowed).
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { qualityReport } from '../reports/qualityReport.ts'
import { localDay } from '../utils.ts'
import { stockRows } from '../stock.ts'
import { itemName } from '../stock.ts'
import { qcStatuses, categoryTitle } from '../qcCategories.ts'
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

/** The fold never sees app_config (collections only), so category titles come
 *  from the built-ins; an admin-added key falls back to its own key — honest. */
const titleOf = (key: string): string =>
  categoryTitle({ config: {} } as Pick<AppState, 'config'>, key)

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

  // The window reads on the batch's date — the report's own rule (recordsIn).
  const batchDateOf = (batchId: string): string | undefined =>
    state.batches?.find((b) => b.id === batchId)?.date
  const windowed = (state.qcs ?? []).filter((q) => inWindow(batchDateOf(q.batchId), w))

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
      const made = batchDateOf(q.batchId)
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

  // ── Turnaround: a decided record's days on the bench, batch day → review day
  const decided = windowed.filter(
    (q) => (q.disposition === 'Released' || q.disposition === 'Rejected') && localDay(q.reviewedAt),
  )
  const turnOfMonth = new Map<string, { days: number; n: number }>()
  let turnSum = 0
  for (const q of decided) {
    const made = batchDateOf(q.batchId)
    const reviewed = localDay(q.reviewedAt)
    if (!made || !reviewed) continue
    const days = Math.max(0, daysBetween(localDay(made), reviewed))
    const m = monthOf(reviewed)
    const acc = turnOfMonth.get(m) ?? { days: 0, n: 0 }
    acc.days += days
    acc.n += 1
    turnOfMonth.set(m, acc)
    turnSum += days
  }
  const turnaround: KpiChart = {
    key: 'qc-turnaround',
    label: 'Avg turnaround (days)',
    kind: 'line',
    rows: [...turnOfMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, acc]) => ({ label: m, value: Number((acc.days / acc.n).toFixed(1)) })),
  }
  cards.push({
    key: 'qc-turnaround',
    label: 'Avg turnaround',
    value: decided.length ? Number((turnSum / decided.length).toFixed(1)) : 0,
    unit: 'days',
  })

  // ── Out-of-spec, as the records can say it: failed tests by category ──────
  const fails = new Map<string, number>()
  for (const q of windowed) {
    for (const [key, status] of Object.entries(qcStatuses(q))) {
      if (status === 'Fail') fails.set(key, (fails.get(key) ?? 0) + 1)
    }
  }
  const failedTests: KpiChart = {
    key: 'qc-failed-tests',
    label: 'Failed tests by category',
    kind: 'bar',
    rows: [...fails.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ label: titleOf(key), value })),
  }

  // ── Quarantine volume: a position, never windowed (the staged receipts'
  //    whole-load 'Quarantine' lines are its writers; the QC verdicts move
  //    them out). Qty never sums across uoms — the label carries the unit. ──
  const full = { ...state, ledger: state.ledger ?? [] } as AppState
  const quarantine = stockRows(full).filter((r) => r.status === 'Quarantine')
  const byItem = new Map<string, number>()
  for (const r of quarantine) {
    const label = `${itemName(full, r.item)} (${r.uom})`
    byItem.set(label, (byItem.get(label) ?? 0) + r.qty)
  }
  const quarantineChart: KpiChart = {
    key: 'qc-quarantine',
    label: 'In quarantine by item',
    kind: 'bar',
    rows: [...byItem.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
  }
  cards.push({ key: 'qc-quarantine-lots', label: 'Quarantine lots', value: quarantine.length })

  return {
    cards,
    charts: [trend, aging, turnaround, failedTests, quarantineChart],
  }
}
