/**
 * Report 2 — lot yield: what each farmer's lot finally became.
 *
 * The join the register never draws: a receipt's accepted quantity on one side,
 * the batches that pressed it on the other. A batch may draw more than one lot,
 * and a lot may feed more than one batch, so a lot's share of a batch is its
 * issued quantity over the batch's whole issue — everything the lot is credited
 * with is pro-rata on that share.
 *
 * Only extraction batches attribute to lots. A mélange draws bulk that an
 * extraction already produced, so counting its output against the lot's fruit
 * would count the same litres twice — the same double-count rule the production
 * report applies to net-new bulk.
 *
 * A lot nothing has pressed yet is a live question, not a zero: it reads
 * "yield pending" and stays out of the cost-per-litre denominator, so it cannot
 * drag the month's ₹/L toward infinity.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import { batchOutputs, mainOutput, batchKind } from '../batches.ts'
import type { AppState, Batch, Grn } from '../../types.ts'
import type { ReportWindow } from './params.ts'
import { inWindow } from './params.ts'
import { receiptSupplier } from './procurement.ts'

export interface LotYieldRow {
  grnId: string
  lot: string
  date: string
  supplier: string
  product: string
  /** What the receipt counts in — pieces, kilograms. */
  uom: string
  /** Grades A+B+C as received. */
  received: number
  /** Rejected at the gate, before it ever reached a press. */
  gateReject: number
  /** Issued to extraction batches, attributed over all of history. */
  issued: number
  /** Production spoilage attributed to this lot, pro-rata by its share of each
   *  batch's issue. */
  spoiled: number
  /** Issued − spoiled: what actually reached the press. */
  netPressed: number
  /** Main-output quantity attributed to the lot (litres of water, kg of blend …). */
  mainQty: number
  mainUom: string
  /** By-product attributed to the lot — malai kg on a coconut lot. Carries no
   *  cost, so it never enters the cost per unit. */
  byQty: number
  byUom: string
  /** Main output per unit issued. Null while yield is pending. */
  yieldPerUnit: number | null
  /** The receipt's usable cost (₹ per accepted unit). */
  usableCost: number
  /** Usable cost ÷ attributed main output — ₹ per litre the lot's fruit became. */
  costPerUnit: number | null
  /** Stored costPerL of the batches that drew this lot, weighted by attributed
   *  main quantity — the cross-check against the derived figure. */
  storedCostPerUnit: number | null
  /** No batch has drawn this lot yet. */
  pending: boolean
  /** Batches that pressed the lot, oldest first. */
  batches: string[]
}

/** Per-lot accumulators for one pass over the batches. */
interface LotAcc {
  issued: number
  spoiled: number
  mainQty: number
  byQty: number
  byUom: string
  costWeighted: number
  mainWeighted: number
  batches: string[]
}

export function lotYieldRows(state: AppState, w: ReportWindow): LotYieldRow[] {
  const acc = new Map<string, LotAcc>()
  const lot = (key: string): LotAcc => {
    let a = acc.get(key)
    if (!a) {
      a = { issued: 0, spoiled: 0, mainQty: 0, byQty: 0, byUom: '', costWeighted: 0, mainWeighted: 0, batches: [] }
      acc.set(key, a)
    }
    return a
  }

  for (const b of state.batches) {
    if (batchKind(b) !== 'Extraction') continue
    attributeBatch(b, lot)
  }

  return state.grns
    .filter((g) => inWindow(g.date, w))
    .sort((a, b) => a.date.localeCompare(b.date) || a.lot.localeCompare(b.lot))
    .map((g) => rowFor(state, g, acc.get(g.lot)))
}

/** Attribute one extraction batch's outputs and spoilage to the lots it pressed. */
function attributeBatch(b: Batch, lot: (key: string) => LotAcc): void {
  const totalIssued = b.sourceLines.reduce((a, s) => a + (s.qty || 0), 0)
  if (!totalIssued) return
  const outputs = batchOutputs(b)
  // mainOutput re-runs batchOutputs, and for a batch in the deprecated shape each
  // call builds its lines afresh — never reference-equal — so the by-products are
  // picked out of the same array the main line came from.
  const main = outputs.find((l) => l.costShare > 0) || outputs[0]
  const by = main ? outputs.filter((o) => o !== main) : []
  const mainQty = main?.qty || 0
  const byQty = by.reduce((a, o) => a + o.qty, 0)

  for (const s of b.sourceLines) {
    const share = (s.qty || 0) / totalIssued
    const a = lot(s.lot)
    a.issued += s.qty || 0
    a.spoiled += (b.spoiled || 0) * share
    a.mainQty += mainQty * share
    a.byQty += byQty * share
    // A by-product is malai-shaped — one line, counted in one unit. If a batch
    // ever books two, the first unit the lot saw is the one reported.
    a.byUom = a.byUom || by[0]?.uom || ''
    if (mainQty > 0) {
      a.costWeighted += (b.costPerL || 0) * mainQty * share
      a.mainWeighted += mainQty * share
    }
    if (!a.batches.includes(b.id)) a.batches.push(b.id)
  }
}

function rowFor(state: AppState, g: Grn, a?: LotAcc): LotYieldRow {
  const acc = a || { issued: 0, spoiled: 0, mainQty: 0, byQty: 0, byUom: '', costWeighted: 0, mainWeighted: 0, batches: [] }
  const pending = acc.issued <= 0
  const product =
    g.productName || state.purchaseProducts.find((p) => p.id === g.purchaseProductId)?.name || 'Produce'
  // The main output's unit, read off the batch that pressed the lot; falls back to
  // litres, the unit coconut water and every juice but malai is counted in.
  const mainUom = state.batches.find((b) => acc.batches.includes(b.id))
    ? mainOutputOfUom(state, acc.batches)
    : 'Litre'
  return {
    grnId: g.id,
    lot: g.lot,
    date: g.date,
    supplier: receiptSupplier(g),
    product,
    uom: g.uom || 'Piece',
    received: g.accepted,
    gateReject: g.reject,
    issued: Number(acc.issued.toFixed(3)),
    spoiled: Number(acc.spoiled.toFixed(3)),
    netPressed: Number(Math.max(0, acc.issued - acc.spoiled).toFixed(3)),
    mainQty: Number(acc.mainQty.toFixed(3)),
    mainUom,
    byQty: Number(acc.byQty.toFixed(3)),
    byUom: acc.byUom,
    yieldPerUnit: pending || !acc.issued ? null : acc.mainQty / acc.issued,
    usableCost: g.usableCost,
    // The lot's whole landed cost (usable cost × accepted pieces, which is the
    // landed cost exactly) spread over the litres its fruit became.
    costPerUnit: !pending && acc.mainQty > 0 ? g.landed / acc.mainQty : null,
    storedCostPerUnit:
      !pending && acc.mainWeighted > 0 ? acc.costWeighted / acc.mainWeighted : null,
    pending,
    batches: acc.batches,
  }
}

/** The unit the first attributing batch's main output was counted in. */
function mainOutputOfUom(state: AppState, batchIds: string[]): string {
  for (const id of batchIds) {
    const b = state.batches.find((x) => x.id === id)
    const main = b && mainOutput(b)
    if (main) return main.uom
  }
  return 'Litre'
}
