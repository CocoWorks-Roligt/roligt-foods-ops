/**
 * Linked records — for any record in the plant, what it came from and what it went into.
 *
 * Every link here was already in the data: a batch keeps the lots it pressed, a QC
 * record its batch, a packing run its batch, a dispatch its order. What the app never
 * did was *follow* them. Each screen printed the neighbouring record's number as plain
 * text, so walking from a QC verdict back to the farmer's receipt meant reading a code
 * off one page and hunting for it on another. This is the one place those links are
 * resolved, so every screen can offer the same walk in both directions:
 *
 *   goods receipt → batch → QC record → packing run → dispatch → order
 *                    ↘ melange run ↗                ↘ stock issue
 *   packing material receipt → packing run
 */

import { batchKind, runBulkItem } from './batches'
import { resolveStockId } from './stockIds'
import type { AppState } from '../types'

export type DocKind =
  | 'grn'
  | 'batch'
  | 'melange'
  | 'qc'
  | 'packing'
  | 'material'
  | 'dispatch'
  | 'order'
  | 'issue'
  | 'stock'

export interface DocRef {
  id: string
  kind: DocKind
}

export const KIND_LABEL: Record<DocKind, string> = {
  grn: 'Goods receipt',
  batch: 'Production batch',
  melange: 'Melange run',
  qc: 'QC record',
  packing: 'Packing run',
  material: 'Packing material receipt',
  dispatch: 'Dispatch',
  order: 'Order',
  issue: 'Stock issue',
  stock: 'Stock item',
}

/** What a record number names. A receipt's lot resolves to the receipt itself. */
export function docRef(state: AppState, raw: string | undefined): DocRef | undefined {
  const id = (raw || '').trim()
  if (!id) return undefined
  const g = state.grns.find((x) => x.id === id || x.lot === id)
  if (g) return { id: g.id, kind: 'grn' }
  const b = state.batches.find((x) => x.id === id)
  if (b) return { id, kind: batchKind(b) === 'Melange' ? 'melange' : 'batch' }
  if (state.qcs.some((q) => q.id === id)) return { id, kind: 'qc' }
  if (state.packingRuns.some((r) => r.id === id)) return { id, kind: 'packing' }
  if (state.ledger.some((l) => l.type === 'PM Receipt' && l.doc === id)) return { id, kind: 'material' }
  if (state.dispatches.some((d) => d.id === id)) return { id, kind: 'dispatch' }
  if (state.orders.some((o) => o.id === id)) return { id, kind: 'order' }
  if ((state.stockIssues || []).some((i) => i.id === id)) return { id, kind: 'issue' }
  if (resolveStockId(state, id)) return { id, kind: 'stock' }
  return undefined
}

/** Where a record opens: its own page, with its View dialog up. A stock item opens its trace. */
export function docHref(ref: DocRef): string {
  const v = encodeURIComponent(ref.id)
  switch (ref.kind) {
    case 'grn':
      return `/procurement?view=${v}`
    case 'material':
      return `/procurement?tab=packing&view=${v}`
    case 'batch':
      return `/production?stage=extraction&view=${v}`
    case 'melange':
      return `/production?stage=melange&view=${v}`
    case 'qc':
      return `/quality?view=${v}`
    case 'packing':
      return `/packing?view=${v}`
    case 'dispatch':
      return `/dispatch?view=${v}`
    case 'order':
      return `/orders?view=${v}`
    case 'issue':
      return `/stock-issues?view=${v}`
    case 'stock':
      return `/traceability?q=${v}`
  }
}

export interface LinkedRecords {
  cameFrom: DocRef[]
  wentInto: DocRef[]
}

/** What one record came from and what it went into, each a record you can open. */
export function linkedRecords(state: AppState, raw: string): LinkedRecords {
  const cameFrom: DocRef[] = []
  const wentInto: DocRef[] = []
  const ref = docRef(state, raw)
  if (!ref) return { cameFrom, wentInto }

  const add = (list: DocRef[], id: string | undefined) => {
    const found = docRef(state, id)
    if (!found || found.kind === 'stock' || found.id === ref.id) return
    if (!list.some((r) => r.id === found.id)) list.push(found)
  }
  const issues = state.stockIssues || []
  /** Runs that filled this pack off this batch — told apart by expiry when both carry one. */
  const runsPacking = (batchId: string, sku: string, expiry?: string) =>
    state.packingRuns.filter(
      (r) =>
        r.batchId === batchId &&
        r.lines.some((l) => l.sku === sku && (!expiry || !l.expiry || l.expiry === expiry)),
    )
  const receiptOf = (item: string, lot: string) =>
    state.ledger.find((l) => l.type === 'PM Receipt' && l.item === item && l.lot === lot)?.doc

  switch (ref.kind) {
    case 'grn': {
      const g = state.grns.find((x) => x.id === ref.id)!
      state.batches.forEach((b) => {
        if (b.sourceLines.some((s) => s.lot === g.lot)) add(wentInto, b.id)
      })
      issues.forEach((i) => {
        if (i.lines.some((l) => l.lot === g.lot)) add(wentInto, i.id)
      })
      break
    }
    case 'batch':
    case 'melange': {
      const b = state.batches.find((x) => x.id === ref.id)!
      // An extraction came from the receipts it pressed; a melange from the batches it blended.
      b.sourceLines.forEach((s) => add(cameFrom, s.lot))
      ;(b.blendLines || []).forEach((l) => add(cameFrom, l.lot))
      state.qcs.forEach((q) => {
        if (q.batchId === b.id) add(wentInto, q.id)
      })
      state.batches.forEach((m) => {
        if ((m.blendLines || []).some((l) => l.lot === b.id)) add(wentInto, m.id)
      })
      state.packingRuns.forEach((r) => {
        if (r.batchId === b.id) add(wentInto, r.id)
      })
      state.dispatches.forEach((d) => {
        if (d.batchId === b.id) add(wentInto, d.id)
      })
      issues.forEach((i) => {
        if (i.lines.some((l) => l.lot === b.id)) add(wentInto, i.id)
      })
      break
    }
    case 'qc': {
      const q = state.qcs.find((x) => x.id === ref.id)!
      const b = state.batches.find((x) => x.id === q.batchId)
      add(cameFrom, q.batchId)
      // …and straight on to what that batch was made from, so a verdict reaches the goods
      // received in one step rather than by way of the batch.
      b?.sourceLines.forEach((s) => add(cameFrom, s.lot))
      ;(b?.blendLines || []).forEach((l) => add(cameFrom, l.lot))
      // The packs this verdict covers: filled from this batch, from this product.
      state.packingRuns.forEach((r) => {
        if (r.batchId === q.batchId && runBulkItem(r) === q.item) add(wentInto, r.id)
      })
      break
    }
    case 'packing': {
      const r = state.packingRuns.find((x) => x.id === ref.id)!
      add(cameFrom, r.batchId)
      add(cameFrom, state.qcs.find((q) => q.batchId === r.batchId && q.item === runBulkItem(r))?.id)
      state.ledger.forEach((l) => {
        if (l.doc === r.id && l.type === 'Packing Consume' && l.itemType === 'Packing Material') {
          add(cameFrom, receiptOf(l.item, l.lot))
        }
      })
      state.dispatches.forEach((d) => {
        if (runsPacking(d.batchId, d.sku, d.expiry).some((x) => x.id === r.id)) add(wentInto, d.id)
      })
      issues.forEach((i) => {
        if (
          i.lines.some(
            (l) =>
              l.itemType === 'Finished Goods' &&
              runsPacking(l.lot, l.item, l.expiry).some((x) => x.id === r.id),
          )
        ) {
          add(wentInto, i.id)
        }
      })
      break
    }
    case 'material': {
      const receipt = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === ref.id)!
      state.ledger.forEach((l) => {
        if (l.type === 'Packing Consume' && l.item === receipt.item && l.lot === receipt.lot) {
          add(wentInto, l.doc)
        }
      })
      issues.forEach((i) => {
        if (i.lines.some((l) => l.item === receipt.item && l.lot === receipt.lot)) add(wentInto, i.id)
      })
      break
    }
    case 'dispatch': {
      const d = state.dispatches.find((x) => x.id === ref.id)!
      add(cameFrom, d.orderId)
      runsPacking(d.batchId, d.sku, d.expiry).forEach((r) => add(cameFrom, r.id))
      add(cameFrom, d.batchId)
      break
    }
    case 'order': {
      state.dispatches.forEach((d) => {
        if (d.orderId === ref.id) add(wentInto, d.id)
      })
      break
    }
    case 'issue': {
      const i = issues.find((x) => x.id === ref.id)!
      for (const l of i.lines) {
        if (l.itemType === 'Finished Goods') {
          runsPacking(l.lot, l.item, l.expiry).forEach((r) => add(cameFrom, r.id))
        } else if (l.itemType === 'Packing Material') {
          add(cameFrom, receiptOf(l.item, l.lot))
        } else {
          // A receipt's lot, or a batch.
          add(cameFrom, l.lot)
        }
      }
      break
    }
    case 'stock':
      break
  }
  return { cameFrom, wentInto }
}
