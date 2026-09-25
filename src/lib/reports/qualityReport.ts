/**
 * Report 10 — quality: what QC decided, by month and by product.
 *
 * One row per QC record, which is one *product* of one batch — a coconut
 * pressing's water and malai are two records and either can be released while
 * the other waits. The batch's own status is the roll-up of its records
 * (lib/posting.ts `batchDisposition`), and `Partly Released` is reported as the
 * state it is, never averaged away into a rate.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState, QcRecord } from '../../types.ts'
import type { ReportWindow } from './params.ts'
import { inWindow, monthOf } from './params.ts'
import { localDay } from '../utils.ts'

/** The month a QC record belongs to: the month its review happened, falling back
 *  to the month the batch was run — a pending record has reviewed nothing yet. */
function qcMonth(state: AppState, q: QcRecord): string {
  const reviewed = localDay(q.reviewedAt)
  if (reviewed) return monthOf(reviewed)
  return monthOf(state.batches.find((b) => b.id === q.batchId)?.date)
}

export interface QualitySlice {
  key: string
  records: number
  released: number
  rejected: number
  retest: number
  pending: number
  /** Released ÷ decided-or-not — of everything tested, the share released.
   *  Null while there is nothing to divide. */
  releaseRate: number | null
  rejectRate: number | null
}

const emptySlice = (key: string): QualitySlice => ({
  key,
  records: 0,
  released: 0,
  rejected: 0,
  retest: 0,
  pending: 0,
  releaseRate: null,
  rejectRate: null,
})

function count(slice: QualitySlice, q: QcRecord): void {
  slice.records += 1
  if (q.disposition === 'Released') slice.released += 1
  else if (q.disposition === 'Rejected') slice.rejected += 1
  else if (q.disposition === 'Retest') slice.retest += 1
  else slice.pending += 1
}

function rate(slice: QualitySlice): QualitySlice {
  if (slice.records) {
    slice.releaseRate = Number(((slice.released / slice.records) * 100).toFixed(1))
    slice.rejectRate = Number(((slice.rejected / slice.records) * 100).toFixed(1))
  }
  return slice
}

/** The QC records in the window, with each one's batch month resolved — the
 *  window is read on the batch's date so a record is where its batch is. */
function recordsIn(state: AppState, w: ReportWindow): QcRecord[] {
  return state.qcs.filter((q) =>
    inWindow(state.batches.find((b) => b.id === q.batchId)?.date, w),
  )
}

export interface QualityReport {
  byMonth: QualitySlice[]
  byProduct: QualitySlice[]
  /** Batch status roll-ups in the window — the plant's own summary of itself. */
  batchStatuses: { status: string; count: number }[]
  /** Partly-released batches, with the products that disagree. */
  partlyReleased: { batchId: string; outputs: { item: string; name: string; disposition: string }[] }[]
}

export function qualityReport(state: AppState, w: ReportWindow): QualityReport {
  const records = recordsIn(state, w)

  const months = new Map<string, QualitySlice>()
  const products = new Map<string, QualitySlice>()
  const sliceOf = (map: Map<string, QualitySlice>, key: string): QualitySlice => {
    let s = map.get(key)
    if (!s) {
      s = emptySlice(key)
      map.set(key, s)
    }
    return s
  }
  for (const q of records) {
    count(sliceOf(months, qcMonth(state, q)), q)
    const key = q.item || state.batches.find((b) => b.id === q.batchId)?.id || ''
    const label = state.items.find((i) => i.id === key)?.name || key || 'Unknown product'
    count(sliceOf(products, label), q)
  }

  const statuses = new Map<string, number>()
  for (const b of state.batches.filter((b) => inWindow(b.date, w))) {
    statuses.set(b.status, (statuses.get(b.status) || 0) + 1)
  }

  const partly = state.batches
    .filter((b) => inWindow(b.date, w) && b.status === 'Partly Released')
    .map((b) => ({
      batchId: b.id,
      outputs: (b.qcIds || [])
        .map((id) => state.qcs.find((q) => q.id === id))
        .filter((q): q is QcRecord => !!q)
        .map((q) => ({
          item: q.item || '',
          name: state.items.find((i) => i.id === q.item)?.name || q.item || 'Main output',
          disposition: q.disposition,
        })),
    }))

  return {
    byMonth: [...months.values()].map(rate).sort((a, b) => a.key.localeCompare(b.key)),
    byProduct: [...products.values()].map(rate).sort((a, b) => b.records - a.records),
    batchStatuses: [...statuses.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    partlyReleased: partly,
  }
}
