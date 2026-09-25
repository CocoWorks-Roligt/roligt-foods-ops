/**
 * The procurement page's derivations — the two receipt lists and the arithmetic
 * the receiving form previews as it is typed. Pure: plain data in, plain data
 * out, so the costing rule and the "frozen once drawn" rule read without the page.
 */

import type { AppState, Grn, LedgerEntry, Vendor } from '../types.ts'
import { itemName } from './stock.ts'

/** The produce list: status first, then the search over receipt, lot, source and
 *  area, newest first (GRNs are appended oldest-first). */
export function filterGrnRows(grns: Grn[], search: string, status: string): Grn[] {
  const q = search.toLowerCase()
  return grns
    .filter(
      (g) =>
        (!status || g.status === status) &&
        [g.id, g.lot, g.farmerName, g.farmer || '', g.area || '']
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
    .slice()
    .reverse()
}

/** Lots already issued to production are costed into a batch — their numbers are frozen. */
export function drawnLots(ledger: LedgerEntry[]): Set<string> {
  return new Set(ledger.filter((l) => l.qtyOut > 0).map((l) => l.lot))
}

/** Every packing-material receipt, newest first. They are one ledger line each, so
 *  the ledger is the record — there is no second list to keep in step with it. */
export function pmReceiptRows(state: AppState, search: string): LedgerEntry[] {
  const q = search.trim().toLowerCase()
  return state.ledger
    .filter((l) => l.type === 'PM Receipt')
    .filter(
      (l) =>
        !q ||
        [l.doc, l.item, l.lot, itemName(state, l.item)]
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
    .slice()
    .sort((a, b) => b.time.localeCompare(a.time))
}

/** Whether a packing run has already drawn on what a receipt brought in — after
 *  that the run has costed itself at this rate, so the receipt can no longer move. */
export function pmReceiptConsumed(ledger: LedgerEntry[], doc: string): boolean {
  const line = ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
  if (!line) return false
  return ledger.some(
    (l) => l.doc !== doc && l.item === line.item && l.lot === line.lot && l.qtyOut > 0,
  )
}

/** Suppliers this material is linked to on Products & Materials, then everyone
 *  else — the link is a convenience, not a rule, because a one-off box of caps
 *  can come from anywhere. An unapproved supplier already on the form stays
 *  listed so editing notes does not silently drop it off the receipt. */
export function orderSuppliersByLink(vendors: Vendor[], linkedIds: string[], keepId: string): Vendor[] {
  const linked = new Set(linkedIds)
  const active = vendors.filter((v) => v.status === 'Active' || v.id === keepId)
  return [...active.filter((v) => linked.has(v.id)), ...active.filter((v) => !linked.has(v.id))]
}

/** What the receiving form previews as it is typed. Free quantity sits inside the
 *  total but is never charged; every piece received has to land in a grade or in
 *  rejected, which posting enforces — the preview says so before the whole form
 *  is filled. Inputs are already-coerced numbers; the form's blank-string
 *  handling stays with the form. */
export function grnPreview(input: {
  total: number
  free: number
  rate: number
  transport: number
  a: number
  b: number
  c: number
  reject: number
}): { chargeable: number; landed: number; accepted: number; graded: number; ungraded: number } {
  const chargeable = Math.max(0, input.total - input.free)
  const landed = chargeable * input.rate + input.transport
  const accepted = input.a + input.b + input.c
  const graded = accepted + input.reject
  const ungraded = input.total - graded
  return { chargeable, landed, accepted, graded, ungraded }
}
