/**
 * The Extraction stage form's pure folds (WORKFLOW W8). The form is the
 * pipeline flag's pressing screen: graded coconut lots in (the Grading form's
 * output), water / malai / by-products out, and the spoilage the run lost —
 * posted through the SAME Classic write path the old form used (createBatch:
 * checkBatch, postBatchLines, QC raised per output) and then closed through the
 * B3 machinery (POST /api/transformations/close), which files the spoilage
 * records and stamps the mass balance the server computed. Kept out of the
 * page so every answer here answers under test the way it answers on the floor.
 *
 * Nothing is re-derived: the client-side check IS checkBatch (the write path's
 * own questions and words), the live verdict IS computeMassBalance over the
 * same items fold the close endpoint runs, and the queue IS the pipeline
 * Extraction tile's own predicate.
 */
import type { MassBalanceItems, MassBalanceLine } from './rules/massBalance.ts'
import { SPOILAGE_REASON_SEEDS, type SpoilageReason } from './contracts.ts'
import type { Batch, Item, StockRow } from '../types.ts'
import type { AppState } from '../types.ts'
import { isDirectUse } from './batches.ts'
import { poolByLot } from './stock.ts'

/** A pooled input lot as the form offers it (poolByLot's shape). */
export type PressableLot = ReturnType<typeof poolByLot>[number]

/**
 * The lots a pressing can draw: raw material on offer as Available, pooled by
 * lot. This mirrors the Classic form's own rmLots fold exactly — including
 * Available-only — because that is the rule the write path enforces
 * (checkBatch judges source lines against ['Available']); canConsumeLot is the
 * blend/pack/dispatch question and would offer quarantine raw stock the post
 * itself would then refuse. A raw material bought ready to use is never
 * pressed; it goes straight into blends.
 */
export function pressableLots(state: AppState, rows: readonly StockRow[]): PressableLot[] {
  return poolByLot(
    rows.filter(
      (r) =>
        r.itemType === 'Raw Material' &&
        r.status === 'Available' &&
        r.qty > 0 &&
        !isDirectUse(state.items.find((i) => i.id === r.item)),
    ),
  )
}

/**
 * The extraction stage's own spoilage reason codes (DECISIONS #3): the frozen
 * seed list the backfill wrote, extraction's stage codes plus the any-stage
 * one. The server holds the editable truth — a code the plant has since added
 * is not offered here but IS accepted there, and the close's refusal is the
 * authority if the lists ever drift.
 */
export function extractionReasonCodes(): SpoilageReason[] {
  return SPOILAGE_REASON_SEEDS.filter(
    (s) => s.active && (s.stage === 'extraction' || s.stage === 'any'),
  )
}

/**
 * The material masters as the mass balance reads them — the same fold the
 * close endpoint runs over the items collection (uom, kg per counting unit,
 * kg per litre), so the bar on screen and the verdict the server stores judge
 * the same conversions.
 */
export function massBalanceItemsOf(items: readonly Item[]): MassBalanceItems {
  const out: MassBalanceItems = {}
  for (const item of items) {
    const ext = item as Item & { avgUnitWeight?: number; densityKgPerL?: number }
    out[item.id] = {
      uom: item.uom,
      ...(Number(ext.avgUnitWeight) > 0 ? { avgUnitWeight: Number(ext.avgUnitWeight) } : {}),
      ...(Number(ext.densityKgPerL) > 0 ? { densityKgPerL: Number(ext.densityKgPerL) } : {}),
    }
  }
  return out
}

/** Batch statuses that mean a run is finished — pipeline.ts's own set, in step. */
const CLOSED_RUN = new Set(['Released', 'Rejected', 'Closed'])

/**
 * The Extraction stage's close queue: open extraction runs, oldest first —
 * the same predicate pipelineStages counts (plus 'Closed', which the close
 * itself writes), so the tile's number and this list cannot disagree.
 */
export function openExtractionRuns(batches: readonly Batch[]): Batch[] {
  return batches
    .filter((b) => (b.kind || 'Extraction') === 'Extraction' && !CLOSED_RUN.has(b.status))
    .sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id))
}

/**
 * A posted run's inputs and outputs as mass-balance lines — the client mirror
 * of rulesGate.batchLines, fallbacks included: a line with no unit reads the
 * item's own, and a batch posted before outputLines existed still answers
 * through its waterLitres/malaiKg pair.
 */
export function runMassLines(
  batch: Batch,
  items: MassBalanceItems = {},
): { inputs: MassBalanceLine[]; outputs: MassBalanceLine[] } {
  const line = (item: string, qty: number, uom?: string): MassBalanceLine => ({
    item,
    qty,
    uom: uom || items[item]?.uom || '',
  })
  const inputs: MassBalanceLine[] = [...batch.sourceLines, ...(batch.blendLines ?? [])]
    .filter((l) => l.qty > 0)
    .map((l) => line(l.item ?? '', l.qty, l.uom))
  const lines = batch.outputLines ?? []
  const outputs: MassBalanceLine[] = lines.length
    ? lines.filter((l) => l.qty > 0).map((l) => line(l.item, l.qty, l.uom))
    : [
        ...(Number(batch.waterLitres) > 0
          ? [{ item: '', qty: Number(batch.waterLitres), uom: 'Litre' }]
          : []),
        ...(Number(batch.malaiKg) > 0 ? [{ item: '', qty: Number(batch.malaiKg), uom: 'Kg' }] : []),
      ]
  return { inputs, outputs }
}
