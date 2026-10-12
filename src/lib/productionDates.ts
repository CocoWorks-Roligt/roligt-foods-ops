/**
 * When the product under test was made — the dates QC reads a result against.
 *
 * A bulk is extracted on its batch's date, or blended on it when the batch is a blend.
 * A blend's own date says nothing about how old its juice is, so it also carries the
 * dates its components were extracted, followed back through any blend of blends. And
 * the finished packs are dated by the packing runs that drew the bulk.
 */
import { batchKind, runBulkItem } from './batches.ts'
import { fmtDate } from './utils.ts'
import type { AppState } from '../types.ts'

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
