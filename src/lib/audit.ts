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
 * stock moves under the lot, a sticker print under every reference it printed, and a
 * dispatch raised from an order or a QC record raised with its batch got no entry at all.
 */

import { docRef, type DocKind } from './links'
import { itemName } from './stock'
import { legacyPackStockIds, outputStockIds, packStockIds, receiptsFor } from './stockIds'
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

/** What a record's own creation is logged as. */
const CREATED = new Set(['Confirmed dispatch', 'Raised QC record'])

/**
 * Every reference an entry can be filed under that the plant still knows, spelled exactly
 * as the app writes them: record numbers, lots, stock IDs and sticker references.
 */
function knownReferences(state: AppState): Set<string> {
  const known = new Set<string>()
  const add = (v?: string) => {
    if (v) known.add(v)
  }
  state.grns.forEach((g) => {
    add(g.id)
    add(g.lot)
  })
  state.batches.forEach((b) => {
    add(b.id)
    outputStockIds(b).forEach((l) => add(l.stockId))
    legacyPackStockIds(b).forEach((o) => add(o.stockId))
  })
  state.qcs.forEach((q) => add(q.id))
  state.packingRuns.forEach((r) => {
    add(r.id)
    packStockIds(r).forEach((l) => {
      add(l.stockId)
      add(`${r.id}·${l.sku}`)
    })
  })
  state.ledger.forEach((l) => {
    if (l.type === 'PM Receipt') add(l.doc)
    if (l.itemType === 'Packing Material') {
      add(`${l.item}·${l.lot}`)
      add(`${l.item}·${l.lot}·${l.location}`)
    }
  })
  state.dispatches.forEach((d) => add(d.id))
  state.orders.forEach((o) => add(o.id))
  ;(state.stockIssues || []).forEach((i) => add(i.id))
  return known
}

/**
 * The references an entry was filed under. A sticker print used to name every sticker it
 * printed in one string joined with ", " — and a supplier lot or a store can carry a comma
 * in its own name. So the pieces are read back into the longest references the plant
 * knows, and only what matches nothing is taken piece by piece.
 */
function filedUnder(a: AuditEntry, known: Set<string>): string[] {
  const pieces = a.doc.split(', ')
  const refs: string[] = []
  for (let i = 0; i < pieces.length; ) {
    let j = pieces.length
    while (j > i + 1 && !known.has(pieces.slice(i, j).join(', '))) j--
    refs.push(pieces.slice(i, j).join(', ').trim())
    i = j
  }
  return refs.filter(Boolean)
}

/** The place in an item·lot·place reference to packing material — '' when it names none, undefined when the reference is not to it. */
const pmPlace = (ref: string, item: string, lot: string) => {
  const head = `${item}·${lot}`
  if (ref === head) return ''
  return ref.startsWith(`${head}·`) ? ref.slice(head.length + 1) : undefined
}

/**
 * The receipt an item·lot·place reference was about when its supplier lot has since been
 * corrected: the one receipt of that item in that store that already existed when the
 * entry was written and was edited after it. Anything less certain is left unmatched.
 */
function correctedReceipt(state: AppState, ref: string, a: AuditEntry): string | undefined {
  const parts = ref.split('·')
  if (parts.length < 3) return undefined
  const item = parts[0]
  const place = parts[parts.length - 1]
  const lot = parts.slice(1, -1).join('·')
  const receipts = state.ledger.filter((l) => l.type === 'PM Receipt' && l.item === item)
  if (!receipts.length || receipts.some((l) => l.lot === lot)) return undefined
  // A receipt of the same item deleted since could just as well have been the one.
  const name = itemName(state, item)
  if (
    state.audits.some(
      (e) => e.action === 'Deleted packing stock' && e.time >= a.time && e.details.startsWith(`${name}:`),
    )
  ) {
    return undefined
  }
  const docs = [...new Set(receipts.filter((l) => l.location === place).map((l) => l.doc))].filter(
    (doc) =>
      state.audits.some((e) => e.doc === doc && e.action === 'Added packing stock' && e.time <= a.time) &&
      state.audits.some((e) => e.doc === doc && e.action === 'Edited packing stock' && e.time >= a.time),
  )
  return docs.length === 1 ? docs[0] : undefined
}

/**
 * The posting that brought a record into being, for records that were never written an
 * entry of their own: a dispatch raised from an order was logged once, under the order,
 * and a QC record raised with its batch was logged under the batch. Only that one entry
 * stands in — never the rest of the parent's trail.
 */
function createdBy(state: AppState, id: string): AuditEntry[] {
  const d = state.dispatches.find((x) => x.id === id)
  if (d) {
    if (!d.orderId) return []
    return state.audits.filter(
      (a) => a.doc === d.orderId && a.action === 'Dispatched order' && a.time === d.dispatchTime,
    )
  }
  const q = state.qcs.find((x) => x.id === id)
  if (!q) return []
  return state.audits
    .filter(
      (a) => a.doc === q.batchId && (a.action === 'Posted production' || a.action === 'Posted melange'),
    )
    .sort((x, y) => x.time.localeCompare(y.time))
    .slice(0, 1)
}

/** Everything that happened to one record, oldest first. */
export function historyOf(state: AppState, id: string): AuditEntry[] {
  const known = knownReferences(state)
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
  /**
   * Packing-material stickers — and moves logged before stock IDs — are referenced as
   * item·lot·location, which every delivery sharing a supplier lot answers to. Such an
   * entry is this receipt's only if the receipt could still have held that stock then;
   * one written before its supplier lot was corrected is its own if it is the only one
   * it can be.
   */
  const receiptEntry = (ref: string, a: AuditEntry) => {
    if (!receipt) return false
    const place = pmPlace(ref, receipt.item, receipt.lot)
    if (place === undefined) return correctedReceipt(state, ref, a) === id
    return receiptsFor(state, receipt.item, receipt.lot, {
      location: place || undefined,
      time: a.time,
    }).includes(id)
  }

  const belongs = (a: AuditEntry) =>
    filedUnder(a, known).some(
      (d) => keys.has(d) || [...keys].some((k) => d.startsWith(`${k}·`)) || receiptEntry(d, a),
    )
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
  if (!out.some((a) => CREATED.has(a.action))) out.push(...createdBy(state, id))

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
 * a sticker reference is counted against the document that item belongs to — including a
 * document deleted since, which still owns what happened to it.
 */
export function transactions(state: AppState): Transaction[] {
  const known = knownReferences(state)
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
  /** Packing material by item·lot — the way stickers and older moves refer to it. */
  const materialLots = new Map<string, { item: string; lot: string }>()
  for (const l of state.ledger) {
    if (l.type !== 'PM Receipt') continue
    owner.set(l.doc, l.doc)
    materialLots.set(`${l.item}·${l.lot}`, { item: l.item, lot: l.lot })
  }
  for (const d of state.dispatches) owner.set(d.id, d.id)
  for (const o of state.orders) owner.set(o.id, o.id)
  for (const i of state.stockIssues || []) owner.set(i.id, i.id)
  // A receipt deleted since still owns its lot: its own entries name the lot they created.
  for (const a of state.audits) {
    if (a.action !== 'Posted receipt' && a.action !== 'Edited receipt' && a.action !== 'Deleted receipt') {
      continue
    }
    const lot = /^(?:Created|Updated|Removed) (.+?)(?:; | and its )/.exec(a.details)?.[1]
    if (lot && !owner.has(lot)) owner.set(lot, a.doc)
  }
  /** Every reference anything was filed under — a deleted record's number still counts as one. */
  const everFiled = new Set(state.audits.flatMap((a) => filedUnder(a, known)))

  /**
   * The records a reference belongs to. Packing material named by item·lot·place goes to
   * the receipts that could still have held it when the entry was written — two
   * deliveries can share a supplier lot, and one of them may be long used up.
   */
  const ownersOf = (ref: string, a: AuditEntry): string[] => {
    const own = owner.get(ref)
    if (own) return [own]
    const parts = ref.split('·')
    const material = materialLots.get(parts.slice(0, 2).join('·'))
    if (material) {
      const docs = receiptsFor(state, material.item, material.lot, {
        location: parts.slice(2).join('·') || undefined,
        time: a.time,
      })
      if (docs.length) return docs
    }
    const corrected = correctedReceipt(state, ref, a)
    if (corrected) return [corrected]
    // A stock ID belongs to the document before its "/n", and a pack sticker to the run
    // before its "·" — even once that document has been deleted.
    const base = parts[0].replace(/\/\d+$/, '')
    const found = owner.get(parts.slice(0, 2).join('·')) || owner.get(parts[0]) || owner.get(base)
    if (found) return [found]
    return [base !== ref && everFiled.has(base) ? base : ref]
  }

  const groups = new Map<string, AuditEntry[]>()
  for (const a of state.audits) {
    const owners = new Set(filedUnder(a, known).flatMap((ref) => ownersOf(ref, a)))
    if (!owners.size) owners.add('—')
    for (const o of owners) {
      const list = groups.get(o)
      if (list) list.push(a)
      else groups.set(o, [a])
    }
  }
  // A record created without an entry of its own still gets its line: the posting that created it.
  const created = [
    ...state.dispatches.filter((d) => d.orderId).map((d) => d.id),
    ...state.qcs.map((q) => q.id),
  ]
  for (const id of created) {
    const list = groups.get(id) || []
    if (list.some((a) => CREATED.has(a.action))) continue
    const stand = createdBy(state, id).filter((a) => !list.includes(a))
    if (stand.length) groups.set(id, [...list, ...stand])
  }
  return [...groups]
    .map(([id, entries]) => ({
      id,
      kind: docRef(state, id)?.kind,
      entries: entries.slice().sort((a, b) => b.time.localeCompare(a.time)),
    }))
    .sort((a, b) => b.entries[0].time.localeCompare(a.entries[0].time))
}
