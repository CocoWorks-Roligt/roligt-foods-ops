import { QTY_EPSILON } from './utils'
import type { Grn } from '../types'

export interface GrnInput {
  date: string
  /** Purchase product being received. Required — it carries the item, the unit and
   *  the suppliers the receipt is checked against. */
  purchaseProductId?: string
  /** Raw-material item the receipt books against. */
  itemId?: string
  /** What is being counted — Piece, Kg, Litre. */
  uom?: string
  /** Store the lot is put away in, by ledger key. */
  location?: string
  farmerId: string
  farmer?: string
  area?: string
  harvestedOn?: string
  total: number
  free: number
  a: number
  b: number
  c: number
  reject: number
  rate: number
  transport: number
  notes?: string
}

export type GrnMath =
  | { ok: false; error: string }
  | {
      ok: true
      accepted: number
      material: number
      landed: number
      grossCost: number
      usableCost: number
    }

/**
 * Validates a receipt and derives its costs. Free produce arrives and is graded with
 * the rest of the load — it sits inside `total` and adds to stock — it is only left
 * out of the priced quantity, which pulls the cost per usable unit down. Rejected
 * produce is paid for like any other; its cost lands on what was accepted.
 *
 * Coconuts are counted in pieces and beetroot in kilograms, but the arithmetic is the
 * same either way, so the unit only ever shows up in the wording.
 */
export function priceGrn(input: GrnInput): GrnMath {
  const { total, free, a, b, c, reject, rate } = input
  const unit = (input.uom || 'Piece').toLowerCase()
  // The product is what tells the receipt which stock item to book, what it is counted
  // in and who may supply it. Receiving without one used to fall back to coconuts,
  // which quietly booked beetroot as coconut on any receipt posted in a hurry.
  if (!input.purchaseProductId) {
    return { ok: false, error: 'Pick the produce being received.' }
  }
  // A one-off purchase straight from a small farmer needs no vendor master —
  // the farmer name on the receipt is enough to keep the lot traceable.
  if (!input.farmerId && !input.farmer?.trim()) {
    return {
      ok: false,
      error: 'Select an approved vendor, or enter the farmer name for a direct purchase.',
    }
  }
  // Compared with a tolerance, not exactly. Coconuts are whole pieces, but produce
  // bought by weight is not: 0.1 + 0.2 is not 0.3 in binary floating point, so an
  // exact test rejected correctly graded receipts the moment the plant weighed
  // anything. Every other quantity check in the app already works this way.
  const graded = a + b + c + reject
  if (Math.abs(graded - total) > QTY_EPSILON) {
    return {
      ok: false,
      error: `Grade mismatch: grade total is ${Number(graded.toFixed(3))}, but received is ${Number(
        Number(total).toFixed(3),
      )}.`,
    }
  }
  const accepted = a + b + c
  if (accepted <= QTY_EPSILON) {
    return { ok: false, error: 'Accepted quantity must be greater than zero.' }
  }
  if (free < -QTY_EPSILON || free > total + QTY_EPSILON) {
    return { ok: false, error: `Free quantity must be between 0 and the ${total} received.` }
  }
  // The rate is per-receipt and always typed by the operator, so a chargeable lot
  // with no rate is a missed entry, not a genuinely free load.
  if (total - free > QTY_EPSILON && rate <= 0) {
    return { ok: false, error: `Enter the agreed rate per ${unit}.` }
  }
  const material = (total - free) * rate
  const landed = material + input.transport
  return {
    ok: true,
    accepted,
    material,
    landed,
    grossCost: landed / total,
    usableCost: landed / accepted,
  }
}

/** Fields that move the money, and so are frozen once the lot reaches production. */
const GRN_COST_FIELDS = ['total', 'free', 'a', 'b', 'c', 'reject', 'rate', 'transport'] as const

export const grnCostsChanged = (g: Grn, input: GrnInput) =>
  GRN_COST_FIELDS.some((k) => Number(g[k] || 0) !== Number(input[k] || 0))
