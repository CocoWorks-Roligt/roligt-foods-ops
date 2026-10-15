/**
 * The control-samples module's fold (KPI.md §Control Samples). Everything rides
 * the register's own folds — controlSampleRows/sampleStatus — and the tile's
 * own due predicate (dueSamples), so the dashboard, the pipeline tile and the
 * destruction shelf count the same rows. A sample is a record, never stock:
 * counts are ROWS (one per product per run), matching the tile, not bottles.
 *
 * Honest gaps, logged in DECISIONS (P5 D3a): LOCATION is not recorded — a
 * ControlSample carries collectedBy/remark and no storage bin, so no
 * by-location chart exists. REGISTER BY BATCH is the export register's job
 * (D3b); the dashboard's product mix is the honest by-cut. The kept/expiry
 * timeline and the due count are POSITIONS (unwindowed — a kept sample owes
 * its destruction whatever window is open); destructions and the product mix
 * window by the run/destroyed day.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { controlSampleRows } from '../controlSamples.ts'
import { dueSamples } from '../sampleStage.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

export function controlSamplesKpis(state: Partial<AppState>, w: ReportWindow, _today: string): KpiPayload {
  // controlSampleRows reads packingRuns/products/items — exactly the module's
  // declared collections, so the cast only satisfies its AppState signature.
  const rows = controlSampleRows(state as AppState, _today)
  const kept = rows.filter((r) => r.status !== 'Destroyed')

  // ── Retention-expiry timeline: kept samples by the month they expire ──────
  const byExpiry = new Map<string, number>()
  for (const r of kept) {
    const m = monthOf(r.sample.expiresOn)
    if (!m) continue
    byExpiry.set(m, (byExpiry.get(m) ?? 0) + 1)
  }
  const timeline: KpiChart = {
    key: 'cs-expiry-timeline',
    label: 'Kept samples by expiry month',
    kind: 'bar',
    rows: [...byExpiry.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value })),
  }

  // ── Destructions by month — the shelf keeping up ──────────────────────────
  const destroyedMonth = new Map<string, number>()
  for (const r of rows) {
    const day = r.sample.destroyedOn
    if (!day || !inWindow(day, w)) continue
    const m = monthOf(day)
    destroyedMonth.set(m, (destroyedMonth.get(m) ?? 0) + 1)
  }
  const destructions: KpiChart = {
    key: 'cs-destructions',
    label: 'Destructions by month',
    kind: 'line',
    rows: [...destroyedMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value })),
  }

  // ── Samples by product, windowed by the day the run filled them ───────────
  const byProduct = new Map<string, number>()
  for (const r of rows) {
    if (!inWindow(r.producedOn, w)) continue
    byProduct.set(r.product, (byProduct.get(r.product) ?? 0) + 1)
  }
  const products: KpiChart = {
    key: 'cs-by-product',
    label: 'Samples by product',
    kind: 'bar',
    rows: [...byProduct.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
  }

  const cards: KpiCard[] = [
    { key: 'cs-kept', label: 'Samples kept', value: kept.length, href: '/control-samples' },
    {
      key: 'cs-due',
      label: 'Due for destruction',
      value: dueSamples(state as AppState, _today).length,
      href: '/control-samples?tab=shelf',
    },
    { key: 'cs-expired', label: 'Past expiry, kept', value: rows.filter((r) => r.status === 'Expired').length },
    {
      key: 'cs-destroyed',
      label: 'Destroyed',
      value: rows.filter((r) => r.sample.destroyedOn && inWindow(r.sample.destroyedOn, w)).length,
    },
  ]

  return { cards, charts: [timeline, destructions, products] }
}
