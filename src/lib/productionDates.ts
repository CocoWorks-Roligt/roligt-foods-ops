/**
 * When the product under test was made — the dates QC reads a result against.
 *
 * A bulk is extracted on its batch's date, or blended on it when the batch is a blend.
 * A blend's own date says nothing about how old its juice is, so it also carries the
 * dates its components were extracted, followed back through any blend of blends. And
 * the finished packs are dated by the packing runs that drew the bulk.
 */
import { batchKind, runBulkItem } from './batches.ts'
import { dispatchRuns, resolveStockId, runsFilling } from './stockIds.ts'
import { fmtDate } from './utils.ts'
import type { AppState, Dispatch } from '../types.ts'

export interface ProductionDates {
  /** 'Extracted' or 'Blended' — what the batch's own date records. */
  made: 'Extracted' | 'Blended'
  date: string
  /** A blend's component extractions, oldest first. Empty for an extraction. */
  extracted: { batchId: string; date: string }[]
  /** The packing runs that drew this bulk, oldest first. */
  packed: { runId: string; date: string }[]
}

/**
 * The dates behind `batchId`. With `item`, packing counts only runs that drew that
 * bulk — a pressing's malai is packed apart from its water.
 */
export function productionDates(
  state: Pick<AppState, 'batches' | 'packingRuns'>,
  batchId: string,
  item?: string,
): ProductionDates | null {
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) return null
  const blend = batchKind(batch) === 'Melange'

  const extracted = new Map<string, string>()
  const seen = new Set<string>([batch.id])
  const walk = (lots: string[]) => {
    for (const lot of lots) {
      if (seen.has(lot)) continue
      seen.add(lot)
      const b = state.batches.find((x) => x.id === lot)
      if (!b) continue
      if (batchKind(b) === 'Melange') walk((b.blendLines || []).map((l) => l.lot))
      else extracted.set(b.id, b.date)
    }
  }
  if (blend) walk((batch.blendLines || []).map((l) => l.lot))

  const byDate = <T extends { date: string }>(a: T, b: T) => a.date.localeCompare(b.date)
  return {
    made: blend ? 'Blended' : 'Extracted',
    date: batch.date,
    extracted: [...extracted].map(([id, date]) => ({ batchId: id, date })).sort(byDate),
    packed: state.packingRuns
      .filter((r) => r.batchId === batch.id && (!item || runBulkItem(r) === item))
      .map((r) => ({ runId: r.id, date: r.date }))
      .sort(byDate),
  }
}

/** Distinct dates, formatted, in order — two runs on one day read as one day. */
export const fmtDates = (rows: { date: string }[]) => [...new Set(rows.map((r) => fmtDate(r.date)))].join(', ')

/** The dates as label/value pairs, for a details table or a report sheet. */
export function productionDateRows(d: ProductionDates | null): [string, string][] {
  if (!d) return []
  return [
    [d.made === 'Blended' ? 'Blending date' : 'Extraction date', fmtDate(d.date)],
    ...(d.made === 'Blended' ? [['Components extracted', fmtDates(d.extracted) || '-'] as [string, string]] : []),
    ['Packing date', fmtDates(d.packed) || 'Not packed yet'],
  ]
}

/**
 * One short line for anywhere a batch is named: "Extracted 1 Oct 2026" or
 * "Blended 4 Oct 2026". Empty when `batchId` is not a production batch — a receipt
 * lot, a packing-material lot.
 */
export function madeOn(state: Pick<AppState, 'batches'>, batchId?: string): string {
  const b = batchId ? state.batches.find((x) => x.id === batchId) : undefined
  return b ? `${batchKind(b) === 'Melange' ? 'Blended' : 'Extracted'} ${fmtDate(b.date)}` : ''
}

/** "Packed 2 Oct 2026 · extracted 1 Oct 2026" — a finished pack's two dates. */
const packedLine = (state: Pick<AppState, 'batches'>, packed: string[], batchId: string) => {
  const made = madeOn(state, batchId)
  const when = [...new Set(packed.map((d) => fmtDate(d)))].join(', ')
  return [when && `Packed ${when}`, when ? made.charAt(0).toLowerCase() + made.slice(1) : made]
    .filter(Boolean)
    .join(' · ')
}

/** The dates behind a stock ID: a pack's packing and extraction dates, a bulk's making. */
export function stockIdDates(state: AppState, stockId?: string): string {
  const ref = stockId ? resolveStockId(state, stockId) : undefined
  if (!ref) return ''
  if (ref.kind === 'pack') {
    const run = state.packingRuns.find((r) => r.id === ref.runId)
    return packedLine(state, run ? [run.date] : [], ref.batchId)
  }
  return ref.kind === 'bulk' || ref.kind === 'batch' ? madeOn(state, ref.batchId) : ''
}

/**
 * The dates behind a stock row by its lot. Finished goods sit on their batch's lot,
 * so the packing runs that filled the shelf give the packing date; anything else made
 * here reads its batch's date.
 */
export function lotDates(
  state: AppState,
  lot: string,
  finished?: { sku: string; expiry?: string; location?: string },
): string {
  if (finished) {
    const runs = runsFilling(state, lot, finished.sku, { expiry: finished.expiry, location: finished.location })
    return packedLine(state, runs.map((r) => r.date), lot)
  }
  return madeOn(state, lot)
}

/** A dispatch's packing and extraction dates, from the runs it drew. */
export const dispatchDates = (state: AppState, d: Dispatch) =>
  packedLine(state, dispatchRuns(state, d).map((r) => r.date), d.batchId)

/**
 * The ISO date a production batch was extracted or blended on, for an export
 * column. Empty when `batchId` is not a production batch.
 */
export const madeDate = (state: Pick<AppState, 'batches'>, batchId?: string): string =>
  (batchId && state.batches.find((b) => b.id === batchId)?.date) || ''

/** Distinct dates, oldest first, as one export cell. */
export const exportDates = (dates: string[], fmt: (d: string) => string = (d) => d) =>
  [...new Set(dates.filter(Boolean).sort().map(fmt))].join('; ')

/** The ISO dates of the packing runs that filled a finished-goods lot. */
export const packedRunDates = (
  state: AppState,
  lot: string,
  finished: { sku: string; expiry?: string; location?: string },
): string[] =>
  runsFilling(state, lot, finished.sku, { expiry: finished.expiry, location: finished.location }).map((r) => r.date)

/** `packedRunDates` as one export cell. */
export const lotPackedDates = (
  state: AppState,
  lot: string,
  finished: { sku: string; expiry?: string; location?: string },
  fmt?: (d: string) => string,
) => exportDates(packedRunDates(state, lot, finished), fmt)
