/**
 * The Blend stage form's pure folds (WORKFLOW W9) — the intermediate-run screen:
 * a recipe's components drawn from bulk lots (malai, water, milk, and powders
 * bought ready to use) into one blend lot, then closed with the mandatory
 * blend-stage spoilage. A coconut-milk run is one of these — a recipe whose
 * output is the milk bulk — which is why the form offers every active recipe
 * rather than naming one: blends consume the MILK lot, never the source malai
 * or coconuts (§3.3 step 4), and a milk run posted here lands in the pipeline
 * Blending queue (kind 'Melange'), which is where it belongs.
 *
 * Nothing is re-derived: the component pool IS the Classic blend form's own
 * fold (the write path judges blend lines against DRAWABLE — quarantine bulk is
 * legally drawable, so it is offered), the reason codes are the frozen seeds,
 * and the queue IS the pipeline Blending tile's own predicate. The mass-balance
 * folds live in extractionStage — they answer for any run, not just pressings.
 */
import { SPOILAGE_REASON_SEEDS, type SpoilageReason } from './contracts.ts'
import type { AppState, Batch, Melange, StockRow } from '../types.ts'
import { isDirectUse } from './batches.ts'
import { DRAWABLE } from './posting.ts'
import { poolByLot } from './stock.ts'
import { QTY_EPSILON } from './utils.ts'

/** A pooled component lot as the form offers it (poolByLot's shape). */
export type BlendableLot = ReturnType<typeof poolByLot>[number]

/**
 * Every lot a blend can draw, pooled by lot — the Classic form's own fold
 * verbatim: bulk on hand (malai, water, an earlier blend's milk), plus the
 * received lots of a raw material used as bought (stabilizer, sweetener,
 * salt), in the statuses the write path itself accepts (DRAWABLE — checkBatch
 * judges blend lines against it). Raw material that needs pressing is NOT
 * here: checkBatch refuses it in a blend ("draw the bulk pressed from it
 * instead"), which is the anti-double-consumption edge — a coconut cannot
 * sneak into a milk run.
 */
export function blendableLots(state: AppState, rows: readonly StockRow[]): BlendableLot[] {
  return poolByLot(
    rows.filter(
      (r) =>
        (r.itemType === 'Semi Finished' || isDirectUse(state.items.find((i) => i.id === r.item))) &&
        DRAWABLE.includes(r.status) &&
        r.qty > QTY_EPSILON,
    ),
  )
}

/**
 * The blend stage's own spoilage reason codes (DECISIONS #3): the frozen seed
 * list the backfill wrote, blend's stage codes plus the any-stage one. The
 * server holds the editable truth — a code the plant has since added is not
 * offered here but IS accepted there, and the close's refusal is the authority
 * if the lists ever drift.
 */
export function blendReasonCodes(): SpoilageReason[] {
  return SPOILAGE_REASON_SEEDS.filter((s) => s.active && (s.stage === 'blend' || s.stage === 'any'))
}

/** Batch statuses that mean a run is finished — pipeline.ts's own set, in step. */
const CLOSED_RUN = new Set(['Released', 'Rejected', 'Closed'])

/**
 * The Blend stage's close queue: open blend runs, oldest first — the same
 * predicate pipelineStages counts (plus 'Closed', which the close itself
 * writes), so the Blending tile's number and this list cannot disagree.
 */
export function openBlendRuns(batches: readonly Batch[]): Batch[] {
  return batches
    .filter((b) => b.kind === 'Melange' && !CLOSED_RUN.has(b.status))
    .sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id))
}

/**
 * The recipes the form offers: active melanges, the milk recipe among them.
 * Both spellings are live — legacy rows say 'Active', the Phase-2 backfill
 * normalises onto the contract's lowercase 'active' (RECIPE_STATUSES) — so the
 * filter is case-insensitive; a backfilled recipe must not vanish from the form.
 */
export function activeRecipes(melanges: readonly Melange[]): Melange[] {
  return melanges.filter((m) => m.status?.toLowerCase() === 'active')
}
