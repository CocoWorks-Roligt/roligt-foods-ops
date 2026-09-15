/**
 * Stock IDs — one unique, traceable code for every item of stock the plant holds.
 *
 * Stock was only ever identified by product code and lot, and for anything a batch
 * made the lot is the batch: its coconut water and its malai share one, so the product
 * code was the only thing telling them apart. Six batches of water read as SF-0001 six
 * times, and nothing on screen could be handed to Traceability to follow one of them.
 *
 * A stock ID names the item itself, and is built from the document that created it:
 *
 *   produce           the receipt lot          LOT-20260911-001
 *   bulk from a batch batch and output number  BAT-2026-0002/2
 *   packed goods      run and line number      PKG-2026-0003/1
 *   packing material  the receipt              PMR-2026-0004
 *
 * Deliberately not a counter. An ID derived from its document can never collide with
 * another, and gives the same answer on every device without being written anywhere —
 * so a batch posted before IDs existed has one the moment it is read, and a client
 * still running older code cannot mint a number somebody else also minted.
 */

import { batchOutputs, runBulkItem } from './batches'
import type { AppState, Batch, PackingRun } from '../types'

export const stockIdFor = (doc: string, n: number) => `${doc}/${n}`

/** The number on the end of one of `doc`'s stock IDs, or 0 if it is not one. */
const ordinalOf = (doc: string, id: string) => {
  const prefix = `${doc}/`
  if (!id.startsWith(prefix)) return 0
  const n = Number(id.slice(prefix.length))
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Gives each line of a document its stock ID.
 *
 * A new document is numbered in line order. A document being re-posted by an edit
 * keeps the ID each line already had, matched by `keyOf` — a sticker on a tub must not
 * change because somebody corrected a quantity — and a line the edit adds takes the
 * next number up, never one a dropped line used to carry.
 */
export function withStockIds<T extends { stockId?: string }>(
  doc: string,
  lines: T[],
  keyOf: (line: T) => string,
  previous: T[] = [],
): T[] {
  if (!previous.length) return lines.map((line, i) => ({ ...line, stockId: stockIdFor(doc, i + 1) }))
  const kept = new Map<string, string[]>()
  let highest = 0
  previous.forEach((line, i) => {
    const id = line.stockId || stockIdFor(doc, i + 1)
    highest = Math.max(highest, ordinalOf(doc, id))
    kept.set(keyOf(line), [...(kept.get(keyOf(line)) || []), id])
  })
  return lines.map((line) => ({
    ...line,
    stockId: kept.get(keyOf(line))?.shift() || stockIdFor(doc, ++highest),
  }))
}

/** A batch's outputs, each with its stock ID — derived for batches posted before IDs. */
export const outputStockIds = (b: Batch) =>
  batchOutputs(b).map((line, i) => ({ ...line, stockId: line.stockId || stockIdFor(b.id, i + 1) }))

/** A packing run's lines, each with its stock ID. */
export const packStockIds = (r: PackingRun) =>
  r.lines.map((line, i) => ({ ...line, stockId: line.stockId || stockIdFor(r.id, i + 1) }))

/** Packs a batch booked onto itself before packing runs existed, numbered after its bulk. */
export const legacyPackStockIds = (b: Batch) =>
  (b.outputs || []).map((o, i) => ({ ...o, stockId: stockIdFor(b.id, batchOutputs(b).length + i + 1) }))

/** The stock ID of one stock row. */
export function stockIdOfRow(
  state: AppState,
  row: { item: string; itemType: string; lot: string; expiry?: string },
): string {
  switch (row.itemType) {
    case 'Semi Finished': {
      const b = state.batches.find((x) => x.id === row.lot)
      return (b && outputStockIds(b).find((l) => l.item === row.item)?.stockId) || row.lot
    }
    case 'Finished Goods': {
      const lines = (state.packingRuns || [])
        .filter((r) => r.batchId === row.lot)
        .flatMap((r) =>
          packStockIds(r)
            .filter((l) => l.sku === row.item)
            .map((l) => ({ ...l, packedOn: r.date })),
        )
      // The expiry is what tells two runs of one pack off one batch apart.
      const exact = row.expiry ? lines.find((l) => l.expiry === row.expiry) : undefined
      const earliest = lines.slice().sort((a, b) => a.packedOn.localeCompare(b.packedOn))[0]
      const found = (exact || earliest)?.stockId
      if (found) return found
      const b = state.batches.find((x) => x.id === row.lot)
      return (b && legacyPackStockIds(b).find((o) => o.sku === row.item)?.stockId) || row.lot
    }
    case 'Packing Material': {
      const receipt = state.ledger
        .filter((l) => l.type === 'PM Receipt' && l.item === row.item && l.lot === row.lot)
        .sort((a, b) => a.time.localeCompare(b.time))[0]
      return receipt?.doc || row.lot
    }
    default:
      // A receipt books one product into one lot, so the lot already names it.
      return row.lot
  }
}

/** What a stock ID refers to. */
export type StockRef =
  | { kind: 'raw'; id: string; lot: string; item: string }
  | { kind: 'bulk'; id: string; batchId: string; item: string }
  | { kind: 'pack'; id: string; runId: string; batchId: string; sku: string; bulkItem: string }
  | { kind: 'batch'; id: string; batchId: string }
  | { kind: 'material'; id: string; doc: string; item: string; lot: string }

/** Reads a stock ID back to the stock it names. Case does not matter; undefined if unknown. */
export function resolveStockId(state: AppState, raw: string): StockRef | undefined {
  const t = raw.trim().toLowerCase()
  if (!t) return undefined
  for (const b of state.batches) {
    const out = outputStockIds(b).find((l) => l.stockId.toLowerCase() === t)
    if (out) return { kind: 'bulk', id: out.stockId, batchId: b.id, item: out.item }
    const legacy = legacyPackStockIds(b).find((o) => o.stockId.toLowerCase() === t)
    if (legacy) return { kind: 'batch', id: legacy.stockId, batchId: b.id }
  }
  for (const r of state.packingRuns || []) {
    const line = packStockIds(r).find((l) => l.stockId.toLowerCase() === t)
    if (line) {
      return {
        kind: 'pack',
        id: line.stockId,
        runId: r.id,
        batchId: r.batchId,
        sku: line.sku,
        bulkItem: runBulkItem(r),
      }
    }
  }
  const g = state.grns.find((x) => x.lot.toLowerCase() === t)
  if (g) return { kind: 'raw', id: g.lot, lot: g.lot, item: g.itemId || '' }
  const pm = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc.toLowerCase() === t)
  if (pm) return { kind: 'material', id: pm.doc, doc: pm.doc, item: pm.item, lot: pm.lot }
  return undefined
}

/** How an item of stock came to exist: the verb, the day, and the document it came from. */
export function stockOrigin(
  state: AppState,
  ref: StockRef,
): { verb: string; when?: string; from: string; doc?: string } {
  switch (ref.kind) {
    case 'raw': {
      const g = state.grns.find((x) => x.lot === ref.lot)
      return { verb: 'Received', when: g?.date, from: g?.id || ref.lot, doc: g?.id }
    }
    case 'bulk':
    case 'batch': {
      const b = state.batches.find((x) => x.id === ref.batchId)
      return { verb: 'Made', when: b?.date, from: ref.batchId, doc: ref.batchId }
    }
    case 'pack': {
      const r = state.packingRuns.find((x) => x.id === ref.runId)
      return { verb: 'Packed', when: r?.date, from: `${ref.runId} · ${ref.batchId}`, doc: ref.runId }
    }
    case 'material': {
      const l = state.ledger.find((x) => x.type === 'PM Receipt' && x.doc === ref.doc)
      return { verb: 'Received', when: l?.time, from: `Supplier lot ${ref.lot}`, doc: ref.doc }
    }
  }
}
