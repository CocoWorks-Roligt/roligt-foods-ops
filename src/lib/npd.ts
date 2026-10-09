/**
 * New product development — the stock production hands to NPD, and what NPD does
 * with it.
 *
 * Two halves, and neither needed a new table:
 *  - Sending is a move. The stock goes into an NPD area (a storage area of type
 *    'NPD Area') and changes status to NPD_STATUS on the way in. Nothing downstream
 *    draws that status, so the moment it lands it has left production for good — no
 *    batch, blend, packing run, dispatch or QC transfer can reach it again.
 *  - Using is a stock issue with reason NPD_USE: what was used, how much, what for
 *    (a purpose from NPD_PURPOSES) and why in words. It rides the stock issues
 *    collection, so the NPD page's writes are that collection's writes.
 *
 * The monthly report is read straight off both: what arrived in NPD areas, what was
 * used and for what, and what NPD was still holding when the month closed.
 */

import { areaRefusal, itemName, locationLabel, NPD_STATUS, stockRows } from './stock'
import { localDay, nowISO, QTY_EPSILON, uid } from './utils'
import type { Problem } from './posting'
import { NPD_USE, type AppState, type LedgerEntry, type StockIssue, type StockRow } from '../types'

/** NPD areas stock can be sent into right now. */
export const npdAreas = (state: AppState) =>
  state.storageLocations.filter((s) => s.type === 'NPD Area' && s.status === 'Active')

/** Stock NPD is holding: every row sent to it and not yet recorded as used. */
export const npdRows = (state: AppState) =>
  stockRows(state).filter((r) => r.status === NPD_STATUS && r.qty > QTY_EPSILON)

/** Whether an issue is NPD's record of use rather than an ordinary stock issue. */
export const isNpdUse = (issue: Pick<StockIssue, 'reason'>) => issue.reason === NPD_USE

/**
 * Whether this row can be sent to testing or NPD. Rejected stock cannot — QC has said
 * it is not fit, so it is written off from Stock Issues instead — and stock NPD already
 * holds is not sent anywhere again.
 */
export const sendable = (r: Pick<StockRow, 'status' | 'qty'>) =>
  r.qty > QTY_EPSILON && r.status !== 'Rejected' && r.status !== NPD_STATUS

export interface SendToNpdInput {
  item: string
  lot: string
  location: string
  status: string
  expiry?: string
  qty: number
  /** The NPD area's ledger key. */
  to: string
  note?: string
}

const sameRow = (r: StockRow, i: SendToNpdInput) =>
  r.item === i.item &&
  r.lot === i.lot &&
  r.location === i.location &&
  r.status === i.status &&
  (r.expiry || '') === (i.expiry || '')

/** What is wrong with the send, or null when it can post. */
export function checkSendToNpd(state: AppState, input: SendToNpdInput): Problem {
  const row = stockRows(state).find((r) => sameRow(r, input))
  if (!row || row.qty <= QTY_EPSILON) return 'That stock is no longer on hand.'
  if (row.status === 'Rejected') {
    return 'QC has rejected this stock, so it cannot go to NPD — write it off from Stock Issues.'
  }
  if (row.status === NPD_STATUS) return 'NPD already holds this stock.'
  if (!(input.qty > 0) || input.qty > row.qty + QTY_EPSILON) {
    return `Enter a quantity above 0 and no more than ${Number(row.qty.toFixed(3))} ${row.uom}.`
  }
  if (!npdAreas(state).length) {
    return 'There is no NPD area yet — add one on the Storage page (type “NPD area”) first.'
  }
  const area = state.storageLocations.find((s) => s.name === input.to)
  if (!area) return 'Pick the NPD area it is going to.'
  return areaRefusal(area, row.itemType, NPD_STATUS)
}

/**
 * Posts the send: out of where it sat under its own status, into the NPD area under
 * NPD_STATUS, at the same unit cost. Two 'Stock Transfer' lines, like any move, so the
 * Storage page's move history and the stock-id chain read it as one. Returns the doc.
 */
export function postSendToNpd(draft: AppState, input: SendToNpdInput): { doc: string; row: StockRow } {
  const row = stockRows(draft).find((r) => sameRow(r, input)) as StockRow
  const doc = uid('NPD')
  const time = nowISO()
  const line = (location: string, status: string, qtyIn: number, qtyOut: number): LedgerEntry => ({
    id: uid('LED'),
    type: 'Stock Transfer',
    doc,
    item: row.item,
    itemType: row.itemType,
    lot: row.lot,
    location,
    status,
    qtyIn,
    qtyOut,
    uom: row.uom,
    unitCost: row.unitCost,
    time,
    expiry: row.expiry,
  })
  draft.ledger.push(line(input.location, row.status, 0, input.qty))
  draft.ledger.push(line(input.to, NPD_STATUS, input.qty, 0))
  return { doc, row }
}

/** "2026-10" for a date, read off the local clock like every other day in the app. */
export const monthOf = (iso: string) => localDay(iso).slice(0, 7)

/** One stock item's total inside a report. */
export interface NpdItemTotal {
  item: string
  name: string
  uom: string
  qty: number
  value: number
}

/** One purpose's total — what the month's use went on. */
export interface NpdPurposeTotal {
  purpose: string
  records: number
  value: number
  items: NpdItemTotal[]
}

export interface NpdReceipt {
  doc: string
  time: string
  item: string
  name: string
  lot: string
  from: string
  /** What it was before NPD took it — Quarantine, Released, Available. */
  fromStatus: string
  to: string
  qty: number
  uom: string
  value: number
}

export interface NpdMonth {
  month: string
  received: NpdReceipt[]
  receivedValue: number
  uses: StockIssue[]
  usedValue: number
  byPurpose: NpdPurposeTotal[]
  byItem: NpdItemTotal[]
  /** What NPD still held at the close of the month. */
  heldAtClose: NpdItemTotal[]
  heldValue: number
}

/** Adds one quantity into a per-item total, keeping units apart. */
function addTo(totals: NpdItemTotal[], state: AppState, item: string, uom: string, qty: number, value: number) {
  const t = totals.find((x) => x.item === item && x.uom === uom)
  if (t) {
    t.qty += qty
    t.value += value
  } else totals.push({ item, name: itemName(state, item), uom, qty, value })
}

const byValue = <T extends { value: number }>(a: T, b: T) => b.value - a.value

/**
 * The month's NPD report: what came in, what was used and for what, what was left.
 *
 * "Came in" is a send — a transfer whose in-leg is NPD stock and whose out-leg was not
 * — so shuffling stock between two NPD areas is not counted as receiving it twice.
 */
export function npdMonthReport(state: AppState, month: string): NpdMonth {
  const legs = new Map<string, { out?: LedgerEntry; in?: LedgerEntry }>()
  for (const l of state.ledger) {
    if (l.type !== 'Stock Transfer') continue
    const pair = legs.get(l.doc) || {}
    if (l.qtyOut > 0) pair.out = l
    else if (l.qtyIn > 0) pair.in = l
    legs.set(l.doc, pair)
  }
  const received: NpdReceipt[] = []
  for (const { in: i, out: o } of legs.values()) {
    if (!i || !o || i.status !== NPD_STATUS || o.status === NPD_STATUS) continue
    if (monthOf(i.time) !== month) continue
    received.push({
      doc: i.doc,
      time: i.time,
      item: i.item,
      name: itemName(state, i.item),
      lot: i.lot,
      from: locationLabel(state, o.location),
      fromStatus: o.status,
      to: locationLabel(state, i.location),
      qty: i.qtyIn,
      uom: i.uom,
      value: i.qtyIn * i.unitCost,
    })
  }
  received.sort((a, b) => b.time.localeCompare(a.time))

  const uses = (state.stockIssues || [])
    .filter((x) => isNpdUse(x) && monthOf(x.date) === month)
    .sort((a, b) => b.date.localeCompare(a.date))
  const byPurpose: NpdPurposeTotal[] = []
  const byItem: NpdItemTotal[] = []
  for (const use of uses) {
    const purpose = use.npdPurpose || 'Other'
    let p = byPurpose.find((x) => x.purpose === purpose)
    if (!p) byPurpose.push((p = { purpose, records: 0, value: 0, items: [] }))
    p.records += 1
    for (const l of use.lines) {
      const value = l.qty * l.unitCost
      p.value += value
      addTo(p.items, state, l.item, l.uom, l.qty, value)
      addTo(byItem, state, l.item, l.uom, l.qty, value)
    }
  }

  // Held at close: every NPD-status ledger line up to the end of the month.
  const heldAtClose: NpdItemTotal[] = []
  for (const l of state.ledger) {
    if (l.status !== NPD_STATUS || monthOf(l.time) > month) continue
    addTo(heldAtClose, state, l.item, l.uom, l.qtyIn - l.qtyOut, (l.qtyIn - l.qtyOut) * l.unitCost)
  }
  const held = heldAtClose.filter((t) => t.qty > QTY_EPSILON)

  const sum = (xs: { value: number }[]) => xs.reduce((a, x) => a + x.value, 0)
  return {
    month,
    received,
    receivedValue: sum(received),
    uses,
    usedValue: sum(uses),
    byPurpose: byPurpose.sort(byValue),
    byItem: byItem.sort(byValue),
    heldAtClose: held.sort(byValue),
    heldValue: sum(held),
  }
}
