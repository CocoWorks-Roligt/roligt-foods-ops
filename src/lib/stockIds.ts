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
import { localDay } from './utils'
import type { AppState, Batch, Dispatch, LedgerEntry, PackingRun } from '../types'

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

// ---- which document some stock came from ------------------------------------------------
//
// Stock in the ledger is known by item, lot, place, status and date. For a pack the lot is
// the batch, so two runs of one pack off one batch on one day land on the same row; for
// packing material the lot is the supplier's free-text reference, which two deliveries of
// one supplier batch share. Everything below answers "which run, which receipt" from what
// the ledger does record — when things happened, how much, and where they were put.

/** Where and when some stock was, for telling apart the documents that could have supplied it. */
export interface StockPlace {
  expiry?: string
  location?: string
  /** When it left, or was counted. */
  time?: string
}

/** Ledger lines by item and lot, gathered once for each version of the ledger. */
const linesByItemLot = new WeakMap<
  LedgerEntry[],
  { size: number; index: Map<string, LedgerEntry[]> }
>()

function linesOf(state: AppState, item: string, lot: string): LedgerEntry[] {
  let cached = linesByItemLot.get(state.ledger)
  if (!cached || cached.size !== state.ledger.length) {
    const index = new Map<string, LedgerEntry[]>()
    for (const l of state.ledger) {
      const key = `${l.item}\n${l.lot}`
      const list = index.get(key)
      if (list) list.push(l)
      else index.set(key, [l])
    }
    cached = { size: state.ledger.length, index }
    linesByItemLot.set(state.ledger, cached)
  }
  return cached.index.get(`${item}\n${lot}`) || []
}

/**
 * When a ledger line happened, by the document it belongs to. The line's own time is when
 * it was posted, and an edit re-posts every line of its document — so the run's, the
 * issue's or the dispatch's own date is the truer clock wherever there is one.
 */
export function happenedAt(state: AppState, l: LedgerEntry): string {
  switch (l.type) {
    case 'Packing Output':
    case 'Packing Consume':
      return state.packingRuns.find((r) => r.id === l.doc)?.date || l.time
    case 'Stock Issue':
      return (state.stockIssues || []).find((i) => i.id === l.doc)?.date || l.time
    case 'Dispatch':
      return state.dispatches.find((d) => d.id === l.doc)?.dispatchTime || l.time
    default:
      return l.time
  }
}

/** A moment, comparable: the local day, then stock coming in before stock going out, then the clock. */
interface Stamp {
  day: string
  incoming: boolean
  at: number
}
const stampOf = (when: string, incoming: boolean): Stamp => {
  const t = Date.parse(when.includes('T') ? when : `${when.slice(0, 10)}T00:00`)
  return { day: localDay(when), incoming, at: Number.isNaN(t) ? 0 : t }
}
const earlier = (a: Stamp, b: Stamp) =>
  a.day !== b.day ? a.day < b.day : a.incoming !== b.incoming ? a.incoming : a.at < b.at

/**
 * The sources — packing runs, or receipts of packing material — that could still have held
 * some of one item·lot when `at` happened, or could still hold some now.
 *
 * A source is ruled out only when it must have run dry: when, even had every earlier draw
 * come out of the other sources first, nothing of it would be left. That never guesses
 * which delivery an operator picked up, and still knows that covers used up before the
 * second truck arrived were the first truck's.
 */
function stillHolding(
  state: AppState,
  item: string,
  lot: string,
  expiry: string | undefined,
  sourceType: string,
  docs: string[],
  at?: string,
): Set<string> {
  const until = at ? stampOf(at, false) : undefined
  const moves = linesOf(state, item, lot)
    .filter(
      (l) =>
        // A move or a QC release takes stock out and puts the same stock back.
        l.type !== 'Stock Transfer' &&
        l.type !== 'QC Status Transfer' &&
        (!expiry || !l.expiry || l.expiry === expiry),
    )
    .map((l) => ({ l, stamp: stampOf(happenedAt(state, l), l.qtyIn > 0) }))
    .filter((m) => !until || earlier(m.stamp, until))
    .sort((a, b) => (earlier(a.stamp, b.stamp) ? -1 : earlier(b.stamp, a.stamp) ? 1 : 0))
  const holding = new Set<string>()
  for (const doc of docs) {
    let mine = 0
    let others = 0
    for (const { l } of moves) {
      if (l.qtyIn > 0) {
        if (l.type === sourceType && l.doc === doc) mine += l.qtyIn
        else others += l.qtyIn
        continue
      }
      const fromOthers = Math.min(others, l.qtyOut)
      others -= fromOthers
      mine = Math.max(0, mine - (l.qtyOut - fromOthers))
    }
    if (mine > 1e-9) holding.add(doc)
  }
  return holding
}

/** Every place stock found at `at.location` could have come from: there, and wherever it was moved in from. */
function placesFeeding(state: AppState, item: string, lot: string, at: StockPlace): Set<string> {
  const lines = linesOf(state, item, lot)
  const start = at.location || ''
  const places = new Set([start])
  const queue = [start]
  while (queue.length) {
    const here = queue.pop() as string
    for (const l of lines) {
      if (l.type !== 'Stock Transfer' || l.qtyIn <= 0 || l.location !== here) continue
      if (at.expiry && l.expiry && l.expiry !== at.expiry) continue
      if (at.time && localDay(l.time) > localDay(at.time)) continue
      for (const o of lines) {
        if (o.type !== 'Stock Transfer' || o.doc !== l.doc || o.qtyOut <= 0) continue
        if (places.has(o.location)) continue
        places.add(o.location)
        queue.push(o.location)
      }
    }
  }
  return places
}

/**
 * Narrows the documents that could have supplied some stock, one test at a time. A test
 * that would rule out every candidate is skipped rather than trusted, and candidates that
 * still cannot be told apart all come back: packs pooled on one shelf are genuinely
 * either, and a trace must never quietly pick one.
 */
function narrowSources<T>(candidates: T[], tests: ((c: T[]) => T[])[]): T[] {
  let out = candidates
  for (const test of tests) {
    if (out.length < 2) break
    const kept = test(out)
    if (kept.length) out = kept
  }
  return out
}

/**
 * The packing runs finished packs of one batch could have come from.
 *
 * A dispatch, an issue and a stock row each name the pack, the batch and the best-before —
 * and two runs of one pack off one batch on the same day share all three, so matching on
 * those alone read one run's dispatches as the other's. Nothing packed after the day the
 * packs left, no run whose packs had all gone already, and no run that put nothing where
 * the packs were taken from (following any moves) can be the one.
 */
export function runsFilling(
  state: AppState,
  batchId: string,
  sku: string,
  at: StockPlace = {},
): PackingRun[] {
  const candidates = (state.packingRuns || []).filter(
    (r) =>
      r.batchId === batchId &&
      r.lines.some((l) => l.sku === sku && (!at.expiry || !l.expiry || l.expiry === at.expiry)),
  )
  if (candidates.length < 2) return candidates
  const putAway = (r: PackingRun) => {
    const put = linesOf(state, sku, batchId)
      .filter((l) => l.type === 'Packing Output' && l.doc === r.id)
      .map((l) => l.location)
    return put.length ? put : r.location ? [r.location] : []
  }
  return narrowSources(candidates, [
    (rs) => {
      if (!at.time) return rs
      const left = localDay(at.time)
      return rs.filter((r) => localDay(r.date) <= left)
    },
    (rs) => {
      const holding = stillHolding(
        state,
        sku,
        batchId,
        at.expiry,
        'Packing Output',
        rs.map((r) => r.id),
        at.time,
      )
      return rs.filter((r) => holding.has(r.id))
    },
    (rs) => {
      if (!at.location) return rs
      const places = placesFeeding(state, sku, batchId, at)
      return rs.filter((r) => putAway(r).some((p) => places.has(p)))
    },
  ])
}

/** The runs a dispatch's packs came from, read off the stock it actually drew. */
export function dispatchRuns(state: AppState, d: Dispatch): PackingRun[] {
  const drawn = linesOf(state, d.sku, d.batchId).filter(
    (l) => l.type === 'Dispatch' && l.doc === d.id,
  )
  if (!drawn.length) {
    return runsFilling(state, d.batchId, d.sku, { expiry: d.expiry, time: d.dispatchTime })
  }
  const found = new Map<string, PackingRun>()
  for (const l of drawn) {
    runsFilling(state, d.batchId, d.sku, {
      expiry: l.expiry || d.expiry,
      location: l.location,
      time: d.dispatchTime || l.time,
    }).forEach((r) => found.set(r.id, r))
  }
  return [...found.values()]
}

/**
 * The receipts packing material of one item and supplier lot could have come from. The
 * supplier lot is free text, and two deliveries of one supplier batch carry the same one:
 * a receipt that had not arrived yet, had been used up, or was put away somewhere else
 * is not where the material came from.
 */
export function receiptsFor(
  state: AppState,
  item: string,
  lot: string,
  at: StockPlace = {},
): string[] {
  const candidates = linesOf(state, item, lot).filter((l) => l.type === 'PM Receipt')
  const kept = narrowSources(candidates, [
    (ls) => {
      if (!at.time) return ls
      const left = localDay(at.time)
      return ls.filter((l) => localDay(l.time) <= left)
    },
    (ls) => {
      const holding = stillHolding(
        state,
        item,
        lot,
        undefined,
        'PM Receipt',
        ls.map((l) => l.doc),
        at.time,
      )
      return ls.filter((l) => holding.has(l.doc))
    },
    (ls) => {
      if (!at.location) return ls
      const places = placesFeeding(state, item, lot, at)
      return ls.filter((l) => places.has(l.location))
    },
  ])
  return [...new Set(kept.map((l) => l.doc))]
}

type StockRowLike = { item: string; itemType: string; lot: string; location?: string; expiry?: string }

/**
 * Every stock ID one stock row holds. A row is one item in one place with one date, and
 * two runs — or two deliveries of one supplier lot — put away together pool into it, so
 * each of them is named rather than whichever was found first.
 */
export function stockIdsOfRow(state: AppState, row: StockRowLike): string[] {
  switch (row.itemType) {
    case 'Semi Finished': {
      const b = state.batches.find((x) => x.id === row.lot)
      return [(b && outputStockIds(b).find((l) => l.item === row.item)?.stockId) || row.lot]
    }
    case 'Finished Goods': {
      // The expiry tells two runs of one pack off one batch apart; the room, two runs of one day.
      let runs = runsFilling(state, row.lot, row.item, { expiry: row.expiry, location: row.location })
      if (!runs.length && row.expiry) runs = runsFilling(state, row.lot, row.item, { location: row.location })
      const ids = runs
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .flatMap((r) => {
          const lines = packStockIds(r).filter((l) => l.sku === row.item)
          const dated = lines.filter((l) => l.expiry === row.expiry)
          return (dated.length ? dated : lines).map((l) => l.stockId)
        })
      if (ids.length) return ids
      const b = state.batches.find((x) => x.id === row.lot)
      return [(b && legacyPackStockIds(b).find((o) => o.sku === row.item)?.stockId) || row.lot]
    }
    case 'Packing Material': {
      const docs = receiptsFor(state, row.item, row.lot, { location: row.location })
      return docs.length ? docs : [row.lot]
    }
    default:
      // A receipt books one product into one lot, so the lot already names it.
      return [row.lot]
  }
}

/** The stock ID of one stock row — the first of those it holds, where it pools several. */
export const stockIdOfRow = (state: AppState, row: StockRowLike): string =>
  stockIdsOfRow(state, row)[0]

/** What a stock ID refers to. */
export type StockRef =
  | { kind: 'raw'; id: string; lot: string; item: string }
  | { kind: 'bulk'; id: string; batchId: string; item: string }
  | { kind: 'pack'; id: string; runId: string; batchId: string; sku: string; bulkItem: string }
  /** A pack booked on the batch itself, before packing runs existed. */
  | { kind: 'batch'; id: string; batchId: string; sku: string }
  | { kind: 'material'; id: string; doc: string; item: string; lot: string }

/** Reads a stock ID back to the stock it names. Case does not matter; undefined if unknown. */
export function resolveStockId(state: AppState, raw: string): StockRef | undefined {
  const t = raw.trim().toLowerCase()
  if (!t) return undefined
  for (const b of state.batches) {
    const out = outputStockIds(b).find((l) => l.stockId.toLowerCase() === t)
    if (out) return { kind: 'bulk', id: out.stockId, batchId: b.id, item: out.item }
    const legacy = legacyPackStockIds(b).find((o) => o.stockId.toLowerCase() === t)
    if (legacy) return { kind: 'batch', id: legacy.stockId, batchId: b.id, sku: legacy.sku }
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
