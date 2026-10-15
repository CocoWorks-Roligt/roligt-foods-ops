/**
 * The intermediates-blending module's fold (KPI.md §Intermediates & Blending).
 * Blend figures ride what the runs themselves stamped: output as NET-NEW bulk
 * (production.ts's one method decision — a blend's output minus the bulk it
 * drew, or the same litres print twice), draws off blendLines, the queue off
 * openBlendRuns (the pipeline Blending tile's own predicate, W9 — one
 * implementation, not a re-derivation). Intermediate stock is a POSITION, not
 * a movement: stockRows filtered to Semi Finished, never windowed.
 *
 * Honest gaps, logged in DECISIONS (P5 D2a): no run is named "milk" — which
 * recipe is the milk one is live data (B1 seeded no melanges), so the module
 * counts blend runs generally, exactly as the Blend stage form offers every
 * active recipe. Planned-vs-made totals by month and uom only: a plan naming a
 * product is free text and is never matched per-product to a run's output
 * (name-matching boarded the wrong vehicle in HEAVY). Run uoms spell both
 * 'L' and 'Litre' depending on their writer — keyed normalized, litres and
 * kilograms still never sum.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import { inWindow, monthOf } from '../reports/params.ts'
import { netNewOutputs } from '../reports/production.ts'
import { stockRows } from '../stock.ts'
import { openBlendRuns } from '../blendStage.ts'
import type { KpiCard, KpiChart } from '../contracts.ts'
import type { KpiPayload } from './qc.ts'

/** 'Litre' and 'L' are the same bucket; 'Kg'/'kg' its own. Litres and
 *  kilograms never sum, so the bucket is the unit the chart names. */
const uomKey = (uom: string): string => (uom.toLowerCase() === 'kg' ? 'kg' : 'L')

export function intermediatesBlendingKpis(
  state: Partial<AppState>,
  w: ReportWindow,
  today: string,
): KpiPayload {
  const items = state.items ?? []
  const itemName = (id: string): string => items.find((i) => i.id === id)?.name || id
  const batches = (state.batches ?? []).filter((b) => b.kind === 'Melange')
  const windowRuns = batches.filter((b) => inWindow(b.date, w))
  const plans = (state.productionPlans ?? []).filter(
    (p) => p.stage === 'Melange' && p.status !== 'Cancelled' && inWindow(p.date, w),
  )

  // ── Blend output: net-new by month, per uom (L and kg never sum) ──────────
  const madeByMonth = new Map<string, Map<string, number>>()
  const addMade = (month: string, uom: string, qty: number): void => {
    const acc = madeByMonth.get(month) ?? new Map<string, number>()
    const k = uomKey(uom)
    acc.set(k, (acc.get(k) ?? 0) + qty)
    madeByMonth.set(month, acc)
  }
  for (const b of windowRuns) for (const o of netNewOutputs(b)) addMade(monthOf(b.date), o.uom, o.qty)
  const months = [...madeByMonth.keys()].sort()
  const outputTrend: KpiChart = {
    key: 'ib-blend-output-trend',
    label: 'Blend output by month (net new)',
    kind: 'line',
    rows: months.flatMap((m) =>
      [...(madeByMonth.get(m) ?? new Map()).entries()]
        .sort()
        .map(([uom, qty]) => ({ series: `Net new (${uom})`, label: m, value: Number(qty.toFixed(1)) })),
    ),
  }

  // ── Recipe vs actual: mean deviation per component, in percentage points ──
  // The union of the recipe's components and what the run actually drew: a
  // component the recipe lists but the run never drew is a −share deviation,
  // not an absence. A run whose recipe no longer resolves never answers.
  const melanges = state.melanges ?? []
  const deviation = new Map<string, { sum: number; n: number }>()
  for (const b of windowRuns) {
    const recipe = melanges.find((m) => m.id === b.melangeId)
    if (!recipe) continue
    const drawn = new Map<string, number>()
    let total = 0
    for (const l of b.blendLines ?? []) {
      drawn.set(l.item, (drawn.get(l.item) ?? 0) + l.qty)
      total += l.qty
    }
    if (total <= 0) continue
    const shares = new Map<string, number>()
    for (const [item, qty] of drawn) shares.set(item, (qty / total) * 100)
    for (const c of recipe.components) shares.set(c.item, shares.get(c.item) ?? 0)
    for (const [item, actual] of shares) {
      const recipeShare = recipe.components.find((c) => c.item === item)?.share ?? 0
      const acc = deviation.get(item) ?? { sum: 0, n: 0 }
      acc.sum += actual - recipeShare
      acc.n += 1
      deviation.set(item, acc)
    }
  }
  const recipeVariance: KpiChart = {
    key: 'ib-recipe-variance',
    label: 'Recipe vs actual draw — deviation (pp)',
    kind: 'bar',
    rows: [...deviation.entries()]
      .map(([item, acc]) => ({ label: itemName(item), value: Number((acc.sum / acc.n).toFixed(1)) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  }

  // ── Components drawn by month (grouped, never stacked: malai kg + water L) ──
  const drawnByMonth = new Map<string, Map<string, number>>()
  for (const b of windowRuns) {
    const m = monthOf(b.date)
    const acc = drawnByMonth.get(m) ?? new Map<string, number>()
    for (const l of b.blendLines ?? []) {
      const uom = uomKey(l.uom ?? items.find((i) => i.id === l.item)?.uom ?? '')
      const key = `${l.item}|${uom}`
      acc.set(key, (acc.get(key) ?? 0) + l.qty)
    }
    drawnByMonth.set(m, acc)
  }
  const consumption: KpiChart = {
    key: 'ib-component-consumption',
    label: 'Blend components drawn by month',
    kind: 'bar',
    rows: [...drawnByMonth.keys()].sort().flatMap((m) =>
      [...(drawnByMonth.get(m) ?? new Map()).entries()]
        .map(([key, qty]) => {
          const [item, uom] = key.split('|')
          return { series: `${itemName(item)}${uom ? ` (${uom})` : ''}`, label: m, value: Number(qty.toFixed(1)) }
        })
        .sort((a, b) => a.series.localeCompare(b.series)),
    ),
  }

  // ── Intermediate stock: a position, per item, with the expiry clock ───────
  const stock = stockRows({ ...state, ledger: state.ledger ?? [] } as AppState).filter(
    (r) => r.itemType === 'Semi Finished',
  )
  const stockByItem = new Map<string, { qty: number; uom: string }>()
  for (const r of stock) {
    const acc = stockByItem.get(r.item) ?? { qty: 0, uom: r.uom }
    acc.qty += r.qty
    stockByItem.set(r.item, acc)
  }
  const stockChart: KpiChart = {
    key: 'ib-intermediate-stock',
    label: 'Intermediate bulk on hand',
    kind: 'bar',
    rows: [...stockByItem.entries()]
      .map(([item, acc]) => ({ label: `${itemName(item)} (${uomKey(acc.uom)})`, value: Number(acc.qty.toFixed(1)) }))
      .sort((a, b) => b.value - a.value),
  }
  const dayMs = 86_400_000
  const nearExpiry = stock.filter(
    (r) => r.expiry && Date.parse(`${r.expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) <= 30 * dayMs,
  ).length

  // ── The queue: open vs closed, the tile's own predicate ───────────────────
  const open = openBlendRuns(batches).length
  const runsByStatus: KpiChart = {
    key: 'ib-runs-by-status',
    label: 'Blend runs open vs closed',
    kind: 'bar',
    rows: [
      { label: 'Open', value: open },
      { label: 'Closed', value: batches.length - open },
    ],
  }

  // ── Planned vs made: totals by month and uom (no per-product matching) ────
  const plannedByMonth = new Map<string, Map<string, number>>()
  for (const p of plans) {
    const m = monthOf(p.date)
    const acc = plannedByMonth.get(m) ?? new Map<string, number>()
    const k = uomKey(p.uom)
    acc.set(k, (acc.get(k) ?? 0) + p.qty)
    plannedByMonth.set(m, acc)
  }
  const planMonths = [...new Set([...plannedByMonth.keys(), ...months])].sort()
  const planVsActual: KpiChart = {
    key: 'ib-plan-vs-actual',
    label: 'Planned vs made (net new)',
    kind: 'bar',
    rows: planMonths.flatMap((m) => {
      const uoms = [
        ...new Set([...(plannedByMonth.get(m) ?? new Map()).keys(), ...(madeByMonth.get(m) ?? new Map()).keys()]),
      ].sort()
      return uoms.flatMap((uom) => [
        { series: `Planned (${uom})`, label: m, value: Number((plannedByMonth.get(m)?.get(uom) ?? 0).toFixed(1)) },
        { series: `Made (${uom})`, label: m, value: Number((madeByMonth.get(m)?.get(uom) ?? 0).toFixed(1)) },
      ])
    }),
  }

  const netNewL = windowRuns.reduce((t, b) => {
    for (const o of netNewOutputs(b)) if (uomKey(o.uom) === 'L') t += o.qty
    return t
  }, 0)

  const cards: KpiCard[] = [
    { key: 'ib-blend-runs', label: 'Blend runs', value: windowRuns.length, href: '/production?stage=blend' },
    { key: 'ib-blend-net-new', label: 'Blends made (net new)', value: Number(netNewL.toFixed(1)), unit: 'L' },
    { key: 'ib-open-blends', label: 'Open blend runs', value: open, href: '/production?stage=blend' },
    { key: 'ib-near-expiry', label: 'Intermediates expired / ≤30 d', value: nearExpiry },
  ]

  return {
    cards,
    charts: [outputTrend, recipeVariance, consumption, stockChart, runsByStatus, planVsActual],
  }
}
