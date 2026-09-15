/**
 * The audit trail, read one transaction at a time.
 *
 * Every entry was only ever shown as one long list, newest first, which answers "what
 * happened today" and nothing else. The question the plant actually asks is about a
 * record: who received this lot, who changed that batch, who released this malai and
 * when. So entries are gathered per transaction — every entry about one receipt, one
 * batch, one QC record, one run — both for the record's own View and for the Audit Log.
 *
 * The trail is insert-only, so entries written under older filing rules stay as they
 * were written and are read here instead: QC verdicts used to be filed under the batch,
 * stock moves under the lot, and a sticker print under every reference it printed.
 */

import { docRef, type DocKind } from './links'
import { itemName } from './stock'
import { outputStockIds, packStockIds } from './stockIds'
import type { AppState, AuditEntry } from '../types'

/** What a QC verdict was logged as, under both the old batch-level and the per-product rule. */
const QC_VERDICTS = new Set([
  'Released batch',
  'Rejected batch',
  'Placed batch on hold',
  'Released product',
  'Rejected product',
  'Held product for retest',
])

/** The references an entry was filed under — a sticker print names several. */
const filedUnder = (a: AuditEntry) =>
  a.doc
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)

/** Everything that happened to one record, oldest first. */
export function historyOf(state: AppState, id: string): AuditEntry[] {
  const keys = new Set([id])
  const grn = state.grns.find((g) => g.id === id)
  // Moves and stickers for produce were filed under its lot.
  if (grn) keys.add(grn.lot)
  const batch = state.batches.find((b) => b.id === id)
  if (batch) {
    // A batch's trail takes in its outputs' moves and its products' QC records.
    outputStockIds(batch).forEach((l) => keys.add(l.stockId))
    state.qcs.filter((q) => q.batchId === id).forEach((q) => keys.add(q.id))
  }
  const run = state.packingRuns.find((r) => r.id === id)
  if (run) packStockIds(run).forEach((l) => keys.add(l.stockId))
  const receipt = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === id)
  // Packing-material stickers are referenced as item·lot·location.
  if (receipt) keys.add(`${receipt.item}·${receipt.lot}`)

  const belongs = (a: AuditEntry) =>
    filedUnder(a).some((d) => keys.has(d) || [...keys].some((k) => d.startsWith(`${k}·`)))
  const out = state.audits.filter(belongs)

  const qc = state.qcs.find((q) => q.id === id)
  if (qc) {
    // Verdicts written before they were filed under the QC record sit under its batch.
    // Where a batch had one record there is no doubt whose they were; where it had
    // several, the entry names the product it was about.
    const siblings = state.qcs.filter((q) => q.batchId === qc.batchId)
    const product = itemName(state, qc.item || '')
    for (const a of state.audits) {
      if (a.doc !== qc.batchId || !QC_VERDICTS.has(a.action)) continue
      if (siblings.length === 1 || a.details.startsWith(product)) out.push(a)
    }
  }

  const seen = new Set<string>()
  return out
    .filter((a) => !seen.has(a.id) && !!seen.add(a.id))
    .sort((a, b) => a.time.localeCompare(b.time))
}

export interface Transaction {
  /** The record the entries are about. */
  id: string
  kind?: DocKind
  /** Newest first. */
  entries: AuditEntry[]
}

/**
 * The whole trail, one line per transaction. An entry filed under a stock item, a lot or
 * a sticker reference is counted against the document that item belongs to.
 */
export function transactions(state: AppState): Transaction[] {
  const owner = new Map<string, string>()
  for (const g of state.grns) {
    owner.set(g.id, g.id)
    owner.set(g.lot, g.id)
  }
  for (const b of state.batches) {
    owner.set(b.id, b.id)
    outputStockIds(b).forEach((l) => owner.set(l.stockId, b.id))
  }
  for (const q of state.qcs) owner.set(q.id, q.id)
  for (const r of state.packingRuns) {
    owner.set(r.id, r.id)
    packStockIds(r).forEach((l) => owner.set(l.stockId, r.id))
  }
  for (const l of state.ledger) {
    if (l.type !== 'PM Receipt') continue
    owner.set(l.doc, l.doc)
    owner.set(`${l.item}·${l.lot}`, l.doc)
  }
  for (const d of state.dispatches) owner.set(d.id, d.id)
  for (const o of state.orders) owner.set(o.id, o.id)
  for (const i of state.stockIssues || []) owner.set(i.id, i.id)

  const ownerOf = (ref: string) => {
    const parts = ref.split('·')
    return owner.get(ref) || owner.get(parts.slice(0, 2).join('·')) || owner.get(parts[0]) || ref
  }

  const groups = new Map<string, AuditEntry[]>()
  for (const a of state.audits) {
    const owners = new Set(filedUnder(a).map(ownerOf))
    if (!owners.size) owners.add('—')
    for (const o of owners) {
      const list = groups.get(o)
      if (list) list.push(a)
      else groups.set(o, [a])
    }
  }
  return [...groups]
    .map(([id, entries]) => ({
      id,
      kind: docRef(state, id)?.kind,
      entries: entries.slice().sort((a, b) => b.time.localeCompare(a.time)),
    }))
    .sort((a, b) => b.entries[0].time.localeCompare(a.entries[0].time))
}
