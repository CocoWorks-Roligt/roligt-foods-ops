/**
 * Reports 4 and 5 — production, month by month and batch by batch.
 *
 * The one method decision this module owns, applied everywhere bulk is totalled:
 *
 *   net-new bulk = extraction outputs + mélange outputs − bulk a mélange drew
 *
 * A mélange run blends bulk an extraction already produced. Adding its output on
 * top of extraction's would print the same litres twice — a plant that pressed
 * 100 L, blended all of it into ABC and reported 200 L made is lying by exactly
 * the blended amount. So a mélange contributes only what it *added*: outputs
 * minus the bulk it drew. (In practice a blend's output can exceed its draw —
 * water added, yields — which is exactly the part that is new.)
 *
 * By-products count as new output of the extraction that made them: malai is
 * genuinely material that did not exist before the pressing, even though it
 * carries none of the batch's cost.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import {
  batchInputQty,
  batchInputUom,
  batchKind,
  batchOutputs,
  batchWastage,
  batchYield,
  mainOutput,
} from '../batches.ts'
import type { AppState, Batch, BulkOutputLine } from '../../types.ts'
import type { CompareLine, ReportWindow } from './params.ts'
import { fmtDeltaPct, inWindow, monthsBetween } from './params.ts'

/** Quantities kept apart by unit — litres and kilograms never sum. */
export interface ByUom {
  uom: string
  qty: number
}

const fold = (entries: { uom: string; qty: number }[]): ByUom[] => {
  const by = new Map<string, number>()
  for (const e of entries) by.set(e.uom, (by.get(e.uom) || 0) + e.qty)
  return [...by.entries()]
    .map(([uom, qty]) => ({ uom, qty: Number(qty.toFixed(3)) }))
    .sort((a, b) => b.qty - a.qty)
}

/** Output lines of a batch that are new material: every line of an extraction,
 *  and of a mélange only its outputs minus what it drew (per unit). */
export function netNewOutputs(b: Batch): ByUom[] {
  if (batchKind(b) !== 'Melange') return fold(batchOutputs(b).map((o) => ({ uom: o.uom, qty: o.qty })))
  const out = fold(batchOutputs(b).map((o) => ({ uom: o.uom, qty: o.qty })))
  const drawn = fold((b.blendLines || []).map((l) => ({ uom: l.uom || 'Litre', qty: l.qty })))
  return fold([
    ...out.map((o) => {
      const d = drawn.find((x) => x.uom === o.uom)?.qty || 0
      return { uom: o.uom, qty: o.qty - d }
    }),
    // A mélange can draw in a unit none of its outputs is counted in; that draw
    // still has to come off that unit's net-new figure.
    ...drawn
      .filter((d) => !out.some((o) => o.uom === d.uom))
      .map((d) => ({ uom: d.uom, qty: -d.qty })),
  ])
}

/** A yield pairing the plant reads: output unit over input unit. */
export const yieldPair = (outUom: string, inUom: string) =>
  `${outUom === 'Kg' ? 'kg' : 'L'} / ${inUom.toLowerCase()}`

export interface ProductionMonthRow {
  month: string
  extractions: number
  melanges: number
  netNew: ByUom[]
  spoiled: ByUom[]
  wastage: ByUom[]
  /** Average yield per pairing of output unit and input unit — 0.205 L/piece and
   *  0.5 L/kg average to nothing, so each pairing averages on its own. */
  avgYield: { pair: string; avg: number }[]
  /** Extraction main-output cost per unit, weighted by main-output quantity. */
  costPerUnit: { uom: string; value: number }[]
  packsFilled: number
  packRuns: number
  rmCost: number
  pmCost: number
  directCost: number
}

export interface ProductionReport {
  rows: ProductionMonthRow[]
  totals: ProductionMonthRow
}

const emptyMonth = (month: string): ProductionMonthRow => ({
  month,
  extractions: 0,
  melanges: 0,
  netNew: [],
  spoiled: [],
  wastage: [],
  avgYield: [],
  costPerUnit: [],
  packsFilled: 0,
  packRuns: 0,
  rmCost: 0,
  pmCost: 0,
  directCost: 0,
})

interface MonthAcc extends ProductionMonthRow {
  yieldTotals: Map<string, { total: number; count: number }>
  costTotals: Map<string, { cost: number; qty: number }>
}

function accumulate(acc: MonthAcc, b: Batch): void {
  const main = mainOutput(b)
  if (batchKind(b) === 'Melange') {
    acc.melanges += 1
  } else {
    acc.extractions += 1
    if (main && main.qty > 0) {
      const pair = yieldPair(main.uom, batchInputUom(b))
      const y = acc.yieldTotals.get(pair) || { total: 0, count: 0 }
      y.total += batchYield(b)
      y.count += 1
      acc.yieldTotals.set(pair, y)
      const c = acc.costTotals.get(main.uom) || { cost: 0, qty: 0 }
      c.cost += (b.costPerL || 0) * main.qty
      c.qty += main.qty
      acc.costTotals.set(main.uom, c)
    }
  }
  acc.netNew = fold([
    ...acc.netNew,
    ...netNewOutputs(b).map((x) => ({ uom: x.uom, qty: x.qty })),
  ])
  acc.spoiled = fold([...acc.spoiled, { uom: batchInputUom(b), qty: b.spoiled || 0 }])
  acc.wastage = fold([
    ...acc.wastage,
    { uom: main?.uom || 'Litre', qty: batchWastage(b) },
  ])
  acc.rmCost += b.rmCost || 0
  acc.pmCost += b.pmCost || 0
  acc.directCost += b.directCost || 0
}

function finish(acc: MonthAcc): ProductionMonthRow {
  return {
    ...acc,
    avgYield: [...acc.yieldTotals.entries()].map(([pair, y]) => ({
      pair,
      avg: Number((y.total / y.count).toFixed(3)),
    })),
    costPerUnit: [...acc.costTotals.entries()].map(([uom, c]) => ({
      uom,
      value: Number((c.cost / c.qty).toFixed(2)),
    })),
    rmCost: Number(acc.rmCost.toFixed(2)),
    pmCost: Number(acc.pmCost.toFixed(2)),
    directCost: Number(acc.directCost.toFixed(2)),
  }
}

/** Report 4: one row per calendar month in the window (and the window's totals),
 *  from the batches run and the packs filled in it. */
export function productionReport(state: AppState, w: ReportWindow): ProductionReport {
  const months = monthsBetween(w)
  if (!months.length) {
    const empty = finish(accOf(''))
    return { rows: [], totals: empty }
  }
  const accs = new Map<string, MonthAcc>(months.map((m) => [m, accOf(m)]))

  for (const b of state.batches) {
    if (!inWindow(b.date, w)) continue
    // monthsBetween covers the window end to end, so every in-window batch date
    // lands on a month that exists in the map.
    accumulate(accs.get(b.date.slice(0, 7))!, b)
  }
  for (const r of state.packingRuns) {
    if (!inWindow(r.date, w)) continue
    const m = accs.get(r.date.slice(0, 7))
    if (!m) continue
    m.packRuns += 1
    m.packsFilled += r.lines.reduce((a, l) => a + (l.packs || 0), 0)
    m.pmCost += r.pmCost || 0
  }

  const rows = months.map((m) => finish(accs.get(m)!))
  const total = accOf('')
  for (const m of accs.values()) accumulateInto(total, m)
  return { rows, totals: finish(total) }
}

function accOf(month: string): MonthAcc {
  return { ...emptyMonth(month), yieldTotals: new Map(), costTotals: new Map() }
}

/** Fold a finished month into the running totals. */
function accumulateInto(total: MonthAcc, m: ProductionMonthRow): void {
  total.extractions += m.extractions
  total.melanges += m.melanges
  total.netNew = fold([...total.netNew, ...m.netNew])
  total.spoiled = fold([...total.spoiled, ...m.spoiled])
  total.wastage = fold([...total.wastage, ...m.wastage])
  total.packsFilled += m.packsFilled
  total.packRuns += m.packRuns
  total.rmCost += m.rmCost
  total.pmCost += m.pmCost
  total.directCost += m.directCost
  for (const y of m.avgYield) {
    // The month stored its mean, not its sum; for the window's mean the months
    // are averaged unweighted — a month with one batch counts like a month with
    // forty, which is the honest reading of "how did a typical month run".
    const acc = total.yieldTotals.get(y.pair) || { total: 0, count: 0 }
    acc.total += y.avg
    acc.count += 1
    total.yieldTotals.set(y.pair, acc)
  }
  for (const c of m.costPerUnit) {
    // As with yield: the window averages its months' means, unweighted.
    const acc = total.costTotals.get(c.uom) || { cost: 0, qty: 0 }
    acc.cost += c.value
    acc.qty += 1
    total.costTotals.set(c.uom, acc)
  }
}

/** Report 4's compare lines, from two windows' totals. */
export function productionCompare(a: ProductionMonthRow, b: ProductionMonthRow): CompareLine[] {
  const lines: CompareLine[] = []
  const pct = fmtDeltaPct
  const push = (label: string, x: number, y: number, suffix = '', good: 'up' | 'down' | null = null) =>
    lines.push({
      label: `${label}${suffix}`,
      a: String(Number(x.toFixed(2))),
      b: String(Number(y.toFixed(2))),
      delta: pct(x, y),
      goodDirection: good,
    })
  push('Extraction batches', a.extractions, b.extractions)
  push('Mélange runs', a.melanges, b.melanges)
  const uoms = new Set([...a.netNew.map((x) => x.uom), ...b.netNew.map((x) => x.uom)])
  for (const uom of uoms) {
    push(
      'Net-new bulk',
      a.netNew.find((x) => x.uom === uom)?.qty || 0,
      b.netNew.find((x) => x.uom === uom)?.qty || 0,
      uom === 'Kg' ? ' (kg)' : ' (L)',
    )
  }
  push('Packs filled', a.packsFilled, b.packsFilled)
  push('Raw material cost', a.rmCost, b.rmCost, ' (₹)')
  push('Direct cost', a.directCost, b.directCost, ' (₹)')
  for (const y of a.avgYield) {
    const other = b.avgYield.find((x) => x.pair === y.pair)
    if (other) push(`Avg yield ${y.pair}`, y.avg, other.avg, '', 'up')
  }
  for (const c of a.costPerUnit) {
    const other = b.costPerUnit.find((x) => x.uom === c.uom)
    if (other) push('Avg cost per unit', c.value, other.value, ` (₹/${c.uom === 'Kg' ? 'kg' : 'L'})`, 'down')
  }
  return lines
}

/** Report 5: one row per batch in the window. */
export interface BatchWiseRow {
  batchId: string
  date: string
  kind: 'Extraction' | 'Melange'
  /** Recipe name for a mélange, main-output item name for an extraction. */
  label: string
  inputQty: number
  inputUom: string
  spoiled: number
  wastage: number
  outputs: { item: string; name: string; qty: number; uom: string; costShare: number }[]
  mainQty: number
  mainUom: string
  yieldPerUnit: number | null
  rmCost: number
  pmCost: number
  directCost: number
  totalCost: number
  costPerUnit: number
  status: string
  qcIds: string[]
}

export function batchWiseRows(state: AppState, w: ReportWindow): BatchWiseRow[] {
  return state.batches
    .filter((b) => inWindow(b.date, w))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((b) => {
      const kind = batchKind(b)
      const outputs: BulkOutputLine[] = batchOutputs(b)
      const main = mainOutput(b)
      const label =
        kind === 'Melange'
          ? state.melanges.find((m) => m.id === b.melangeId)?.name || main?.item || b.id
          : state.items.find((i) => i.id === main?.item)?.name || main?.item || b.id
      const total = (b.rmCost || 0) + (b.pmCost || 0) + (b.directCost || 0)
      return {
        batchId: b.id,
        date: b.date,
        kind,
        label,
        inputQty: batchInputQty(b),
        inputUom: batchInputUom(b),
        spoiled: b.spoiled || 0,
        wastage: Number(batchWastage(b).toFixed(3)),
        outputs: outputs.map((o) => ({
          item: o.item,
          name: state.items.find((i) => i.id === o.item)?.name || o.item,
          qty: o.qty,
          uom: o.uom,
          costShare: o.costShare,
        })),
        mainQty: main?.qty || 0,
        mainUom: main?.uom || '',
        yieldPerUnit: kind === 'Extraction' && batchInputQty(b) ? batchYield(b) : null,
        rmCost: b.rmCost || 0,
        pmCost: b.pmCost || 0,
        directCost: b.directCost || 0,
        totalCost: Number(total.toFixed(2)),
        costPerUnit: b.costPerL || 0,
        status: b.status,
        qcIds: b.qcIds || (b.qcId ? [b.qcId] : []),
      }
    })
}
