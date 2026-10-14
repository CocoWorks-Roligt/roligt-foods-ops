/**
 * The Coconut Grading stage form's pure folds (WORKFLOW W7). A staged receipt
 * (W6) books the whole load into quarantine unsorted; this is the form that
 * sorts it — the client half of POST /api/grading. Kept out of the page so the
 * queue, the re-priced input and the live remaining count answer under test
 * the same way they answer on the floor.
 *
 * The validation is deliberately NOT re-derived here: gradingInput rebuilds the
 * staged grn as the GrnInput the gate form would have posted with these grades,
 * and priceGrn answers it — the same questions, the same QTY_EPSILON tolerance
 * and the same words the write path itself uses. The endpoint runs them again
 * server-side; that check is the one that counts.
 */
import type { GrnInput } from './grn.ts'
import type { Grn } from '../types.ts'

/** The grades an operator has sorted so far — free overrides the gate's count. */
export interface TypedGrades {
  a: number
  b: number
  c: number
  reject: number
  free?: number
}

/**
 * The Grading stage's queue: staged lots still waiting their grades, oldest
 * first — the same predicate pipelineStages counts, so the tile's number and
 * the form's list cannot disagree. A lot drops out the moment gradedOn lands
 * (the endpoint stamps it; the snapshot carries it).
 */
export function pendingGrading(grns: readonly Grn[]): Grn[] {
  return grns
    .filter((g) => g.gradingMode === 'staged' && !g.gradedOn)
    .sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id))
}

/**
 * The staged grn re-priced as the receipt the gate would have posted had it
 * graded at the door: the load's own total, rate, transport and (unless the
 * operator overrides it) the free count the gate took, with the typed grades.
 * priceGrn over this input is the form's whole client-side check.
 */
export function gradingInput(grn: Grn, typed: TypedGrades): GrnInput {
  return {
    date: grn.date,
    purchaseProductId: grn.purchaseProductId,
    itemId: grn.itemId,
    uom: grn.uom,
    location: grn.location,
    farmerId: grn.farmerId,
    farmer: grn.farmer || grn.farmerName,
    total: grn.total,
    free: typed.free ?? grn.free ?? 0,
    a: typed.a,
    b: typed.b,
    c: typed.c,
    reject: typed.reject,
    rate: grn.rate,
    transport: grn.transport,
    // no gradingMode: the point is the GATE-mode questions — the mismatch
    // wording and the accepted/free/rate checks the endpoint echoes
  }
}

/** How much of the counted load the typed grades have not sorted yet. */
export const remainingToSort = (grn: Grn, typed: TypedGrades): number =>
  grn.total - (typed.a + typed.b + typed.c + typed.reject)
