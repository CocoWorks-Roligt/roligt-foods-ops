/**
 * Reports 1 and 3 — the procurement lot report, and the same derivation filtered
 * to fruit other than tender coconut.
 *
 * Every figure is read off the receipt as it was posted: grading, rates and
 * landed costs are frozen at posting time by design (see lib/grn.ts), so a rate
 * change later never rewrites what a lot cost. The report only arranges them.
 *
 * Isomorphic: `.ts` extensions, no browser globals (see src/lib/permissions.ts).
 */

import { COCONUT_ITEM } from '../batches.ts'
import type { AppState, Grn } from '../../types.ts'
import type { CompareLine, ReportWindow } from './params.ts'
import { fmtDeltaPct, inWindow } from './params.ts'

export interface ProcurementLotRow {
  grnId: string
  lot: string
  date: string
  /** Who it was bought from — the vendor, or the farmer named on a direct purchase. */
  supplier: string
  /** The farmer who grew it, when the receipt says more than the vendor does. */
  farmer: string
  product: string
  uom: string
  total: number
  free: number
  a: number
  b: number
  c: number
  reject: number
  accepted: number
  rate: number
  transport: number
  landed: number
  usableCost: number
  /** Landed ÷ accepted, in the receipt's own unit. */
  perAccepted: number
}

/** A receipt's product name as the report reads it: what the receipt copied, or
 *  the purchase product's name now. */
function receiptProduct(state: AppState, g: Grn): string {
  if (g.productName) return g.productName
  return state.purchaseProducts.find((p) => p.id === g.purchaseProductId)?.name || 'Produce'
}

export function receiptSupplier(g: Grn): string {
  return g.farmer?.trim() || g.farmerName || '—'
}

/**
 * Whether a receipt is fruit other than tender coconut. A receipt that names no
 * item is a pre-fruit record and is tender coconut by design (see types.ts) —
 * the split is by item, never by date.
 */
export function isFruitReceipt(state: AppState, g: Grn): boolean {
  const item = g.itemId || state.purchaseProducts.find((p) => p.id === g.purchaseProductId)?.itemId
  return !!item && item !== COCONUT_ITEM
}

export interface ProcurementLotOptions {
  /** Report 3: keep only fruit (non-tender-coconut) receipts. */
  fruitsOnly?: boolean
}

export function procurementLotRows(
  state: AppState,
  w: ReportWindow,
  opts: ProcurementLotOptions = {},
): ProcurementLotRow[] {
  return state.grns
    .filter((g) => inWindow(g.date, w))
    .filter((g) => (opts.fruitsOnly ? isFruitReceipt(state, g) : true))
    .sort((a, b) => a.date.localeCompare(b.date) || a.lot.localeCompare(b.lot))
    .map((g) => ({
      grnId: g.id,
      lot: g.lot,
      date: g.date,
      supplier: receiptSupplier(g),
      farmer: g.farmer?.trim() || '',
      product: receiptProduct(state, g),
      uom: g.uom || 'Piece',
      total: g.total,
      free: g.free || 0,
      a: g.a,
      b: g.b,
      c: g.c,
      reject: g.reject,
      accepted: g.accepted,
      rate: g.rate,
      transport: g.transport,
      landed: g.landed,
      usableCost: g.usableCost,
      perAccepted: g.accepted ? g.landed / g.accepted : 0,
    }))
}

export interface UomTotal {
  uom: string
  qty: number
}

/** Totals for a set of receipt rows. Quantities are totalled per unit — pieces of
 *  coconut and kilograms of beetroot do not add up to anything. */
export interface ProcurementSummary {
  receipts: number
  qtyByUom: UomTotal[]
  acceptedByUom: UomTotal[]
  rejectedByUom: UomTotal[]
  freeByUom: UomTotal[]
  landed: number
  usableCost: number
  /** Weighted mean of per-accepted-unit cost across the receipts in the range,
   *  weighted by each one's accepted quantity per unit. */
  avgPerAcceptedByUom: UomTotal[]
  suppliers: number
}

const tally = (rows: { uom: string; qty: number }[]): UomTotal[] => {
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.uom, (by.get(r.uom) || 0) + r.qty)
  return [...by.entries()]
    .map(([uom, qty]) => ({ uom, qty: Number(qty.toFixed(3)) }))
    .sort((a, b) => b.qty - a.qty)
}

export function procurementSummary(rows: ProcurementLotRow[]): ProcurementSummary {
  const weighted = new Map<string, { cost: number; qty: number }>()
  for (const r of rows) {
    const acc = weighted.get(r.uom) || { cost: 0, qty: 0 }
    acc.cost += r.perAccepted * r.accepted
    acc.qty += r.accepted
    weighted.set(r.uom, acc)
  }
  return {
    receipts: rows.length,
    qtyByUom: tally(rows.map((r) => ({ uom: r.uom, qty: r.total }))),
    acceptedByUom: tally(rows.map((r) => ({ uom: r.uom, qty: r.accepted }))),
    rejectedByUom: tally(rows.map((r) => ({ uom: r.uom, qty: r.reject }))),
    freeByUom: tally(rows.map((r) => ({ uom: r.uom, qty: r.free }))),
    landed: Number(rows.reduce((a, r) => a + r.landed, 0).toFixed(2)),
    usableCost: Number(rows.reduce((a, r) => a + r.usableCost, 0).toFixed(2)),
    avgPerAcceptedByUom: [...weighted.entries()].map(([uom, x]) => ({
      uom,
      qty: x.qty ? Number((x.cost / x.qty).toFixed(2)) : 0,
    })),
    suppliers: new Set(rows.map((r) => r.supplier)).size,
  }
}

/** Two windows side by side. Money lines are single numbers; quantity lines are
 *  one per unit the receipts were counted in, labelled with it. The page supplies
 *  each window's label for the table header. */
export function procurementCompare(
  rowsA: ProcurementLotRow[],
  rowsB: ProcurementLotRow[],
): { summaryA: ProcurementSummary; summaryB: ProcurementSummary; lines: CompareLine[] } {
  const summaryA = procurementSummary(rowsA)
  const summaryB = procurementSummary(rowsB)
  const lines: CompareLine[] = []
  const pct = fmtDeltaPct
  const push = (label: string, a: number, b: number, suffix = '', good: 'up' | 'down' | null = null) =>
    lines.push({ label: `${label}${suffix}`, a: String(Number(a.toFixed(2))), b: String(Number(b.toFixed(2))), delta: pct(a, b), goodDirection: good })

  push('Receipts', summaryA.receipts, summaryB.receipts)
  push('Landed cost', summaryA.landed, summaryB.landed, ' (₹)')
  push('Usable cost', summaryA.usableCost, summaryB.usableCost, ' (₹)')
  push('Suppliers', summaryA.suppliers, summaryB.suppliers)

  // Quantities and unit costs per uom, so a month that added beetroot to coconut
  // does not compare pieces against kilograms.
  const uoms = new Set([
    ...summaryA.qtyByUom.map((x) => x.uom),
    ...summaryB.qtyByUom.map((x) => x.uom),
  ])
  for (const uom of uoms) {
    const qa = summaryA.qtyByUom.find((x) => x.uom === uom)?.qty || 0
    const qb = summaryB.qtyByUom.find((x) => x.uom === uom)?.qty || 0
    push('Received', qa, qb, ` (${uom})`)
    const ra = summaryA.rejectedByUom.find((x) => x.uom === uom)?.qty || 0
    const rb = summaryB.rejectedByUom.find((x) => x.uom === uom)?.qty || 0
    push('Rejected at gate', ra, rb, ` (${uom})`, 'down')
    const ca = summaryA.avgPerAcceptedByUom.find((x) => x.uom === uom)?.qty || 0
    const cb = summaryB.avgPerAcceptedByUom.find((x) => x.uom === uom)?.qty || 0
    push('Avg ₹ per accepted', ca, cb, ` ${uom}`, 'down')
  }
  return { summaryA, summaryB, lines }
}
