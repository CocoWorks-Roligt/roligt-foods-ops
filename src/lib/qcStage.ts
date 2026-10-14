/**
 * The QC test-entry stage form's pure folds (WORKFLOW W11). A batch raises one
 * QC record per bulk output as it is booked; this form is the bench half of
 * the §3.3-7 hard gate — results in, disposition out, computed by the same
 * qcDecision the save itself runs. Nothing here re-derives a verdict, a
 * required-test list or a stock move: the form reads the write path's own
 * folds (qcCategories), and saveQc is the only write.
 */
import type { AppState, Batch, QcRecord } from '../types.ts'

/** One waiting record with the batch it came from (the queue reads the batch's date). */
export interface QcQueueEntry {
  q: QcRecord
  batch?: Batch
}

/**
 * The QC stage's queue: records still without a verdict, oldest batch first —
 * the same predicate pipelineStages counts, so the tile's number and the
 * form's list cannot disagree. A record drops out the moment its disposition
 * leaves Pending (saveQc stamps it; the snapshot carries it). Ties break by
 * batch then record id so the bench order is stable; the tile's count is the
 * same either way.
 */
export function pendingQc(state: Pick<AppState, 'qcs' | 'batches'>): QcQueueEntry[] {
  return state.qcs
    .filter((q) => q.disposition === 'Pending')
    .map((q) => ({ q, batch: state.batches.find((b) => b.id === q.batchId) }))
    .sort(
      (x, y) =>
        (x.batch?.date ?? '').localeCompare(y.batch?.date ?? '') ||
        x.q.batchId.localeCompare(y.q.batchId) ||
        x.q.id.localeCompare(y.q.id),
    )
}
