import { QTY_EPSILON } from './utils.ts'
import type { GradingMode } from './contracts.ts'
import type { Grn } from '../types.ts'

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
  /** How this load's grades arrive (the pipeline Receipt form). 'staged' books
   *  the whole load held for the grading form to sort; absent is the Classic
   *  receipt, graded at the gate — the two differ only in where the grades
   *  come from, so every other rule here reads them the same. */
  gradingMode?: GradingMode
  /** Purchase order this receipt answers, when it answers one. Rides the doc;
   *  the GRN↔PO linkage endpoint keeps the PO's own list. */
  poId?: string
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
 * Whether a receipt is graded. Produce counted by the piece (coconuts) is sorted into
 * grades A, B and C and can come with free pieces; produce bought by weight or volume
 * (beetroot by the kilo, vanilla by the litre) is not — what was received is what
 * went into stock, and that is all there is to say about it.
 */
export const gradedUnit = (uom?: string) => (uom || 'Piece').toLowerCase() === 'piece'

/**
 * The receipt as it is stored. An ungraded one has no free or rejected quantity and
 * books the whole load as grade A — the shape every kilogram and litre receipt
 * already had, from operators putting the whole load in A — so `accepted`, the
 * reports and the cost arithmetic read it exactly as before.
 */
export function asReceived<T extends Pick<GrnInput, 'uom' | 'total' | 'free' | 'a' | 'b' | 'c' | 'reject'>>(
  input: T,
): T {
  if (gradedUnit(input.uom)) return input
  return { ...input, free: 0, a: input.total, b: 0, c: 0, reject: 0 }
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
/** The arithmetic under a validated receipt — shared with the BFF's grading
 *  endpoint so server and client cost a load identically. */
export function grnMath(input: Pick<GrnInput, 'total' | 'free' | 'a' | 'b' | 'c' | 'rate' | 'transport'>) {
  const accepted = input.a + input.b + input.c
  const material = (input.total - input.free) * input.rate
  const landed = material + input.transport
  return { accepted, material, landed, grossCost: landed / input.total, usableCost: landed / accepted }
}

export function priceGrn(given: GrnInput): GrnMath {
  const input = asReceived(given)
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
  if (input.gradingMode === 'staged') {
    // The gate counted the load; the sorting happens later, on the grading
    // form (POST /api/grading). There are no grades to check yet — the load is
    // booked whole and held, so the questions left are the ones every receipt
    // answers, and the provisional arithmetic prices the whole load as
    // accepted until the grades re-derive it.
    if (total <= QTY_EPSILON) {
      return { ok: false, error: 'Received quantity must be greater than zero.' }
    }
    if (free < -QTY_EPSILON || free > total + QTY_EPSILON) {
      return { ok: false, error: `Free quantity must be between 0 and the ${total} received.` }
    }
    if (total - free > QTY_EPSILON && rate <= 0) {
      return { ok: false, error: `Enter the agreed rate per ${unit}.` }
    }
    return { ok: true, ...grnMath({ ...input, a: total, b: 0, c: 0 }) }
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
  return { ok: true, ...grnMath(input) }
}

/** Fields that move the money, and so are frozen once the lot reaches production. */
const GRN_COST_FIELDS = ['total', 'free', 'a', 'b', 'c', 'reject', 'rate', 'transport'] as const

export const grnCostsChanged = (g: Grn, input: GrnInput) =>
  GRN_COST_FIELDS.some((k) => Number(g[k] || 0) !== Number(input[k] || 0))

/**
 * A staged receipt whose grades have not landed yet — the Grading stage's
 * queue, and the one shape of receipt whose numbers must not be edited from
 * the Classic form (the grading endpoint re-derives them from the load).
 */
export const gradesPending = (g: Pick<Grn, 'gradingMode' | 'gradedOn'>) =>
  g.gradingMode === 'staged' && !g.gradedOn
