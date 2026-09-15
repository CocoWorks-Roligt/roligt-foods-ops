/**
 * Stock issues — stock leaving for something that is not a sale.
 *
 * Samples to a lab, goods for a BTL activity, a dropped crate, a lot that timed out
 * in the freezer. Until this existed the only way out of finished-goods stock was a
 * dispatch, and a dispatch needs a customer, so every one of these was recorded
 * either as nothing at all — inventory quietly overstated — or as a sale to a
 * customer who never bought anything, which also spends a number out of a delivery
 * challan series that is supposed to run unbroken.
 *
 * An issue is deliberately the plainest document in the app: pick the stock, say why,
 * and it goes. No customer, no challan, no label, and it never reaches sales.
 *
 * Any status can be issued, on purpose. Writing off rejected or expired stock is the
 * whole point of half these reasons, so the picker offers whatever is physically
 * there and the reason is what says why it went.
 */

import { withoutDoc, type Problem } from './posting'
import { itemName, stockRows } from './stock'
import { nowISO, QTY_EPSILON, uid } from './utils'
import type { AppState, IssueReason, StockIssue, StockIssueLine, StockRow } from '../types'

/** One line as the form holds it: a stock row, named in full, and a quantity. */
export interface IssueLineInput {
  item: string
  lot: string
  location: string
  status: string
  qty: number
  expiry?: string
}

export interface StockIssueInput {
  date: string
  reason: IssueReason
  recipient?: string
  notes?: string
  lines: IssueLineInput[]
}

/**
 * Whether a form line and a stock row are the same stock. Everything that makes a row
 * distinct has to match: two bottles off one batch packed three weeks apart sit in the
 * same lot with different expiries and are not interchangeable.
 */
const sameRow = (l: IssueLineInput, r: StockRow) =>
  r.item === l.item &&
  r.lot === l.lot &&
  r.location === l.location &&
  r.status === l.status &&
  (r.expiry || '') === (l.expiry || '')

const sameLine = (a: IssueLineInput, b: IssueLineInput) =>
  a.item === b.item &&
  a.lot === b.lot &&
  a.location === b.location &&
  a.status === b.status &&
  (a.expiry || '') === (b.expiry || '')

const liveLines = (lines: IssueLineInput[]) =>
  lines.filter((l) => l.item && l.lot && l.location && l.qty > 0)

export const issueValue = (lines: StockIssueLine[]) =>
  lines.reduce((a, l) => a + l.qty * l.unitCost, 0)

/**
 * What the form got wrong, or null when it can post.
 *
 * `ignoreDoc` is the issue being edited: its own lines are taken back out of the
 * ledger before the check, so re-saving is measured against what stock would be
 * without this issue rather than against a balance it is itself holding down.
 */
export function checkStockIssue(
  state: AppState,
  input: StockIssueInput,
  ignoreDoc?: string,
): Problem {
  if (!input.reason) return 'Say why the stock is going.'
  if (!input.date) return 'Give the issue a date.'
  const lines = liveLines(input.lines)
  if (!lines.length) return 'Add at least one line of stock to issue.'

  /**
   * Two lines can name the same row, and compared one at a time each would clear on
   * its own while together they take more than the row holds. Add them up first —
   * this exact bug has been found in other documents in this codebase four times.
   */
  const wanted: { line: IssueLineInput; qty: number }[] = []
  for (const l of lines) {
    const existing = wanted.find((w) => sameLine(w.line, l))
    if (existing) existing.qty += l.qty
    else wanted.push({ line: l, qty: l.qty })
  }

  const rows = stockRows(withoutDoc(state, ignoreDoc))
  for (const { line, qty } of wanted) {
    const have = rows.filter((r) => sameRow(line, r)).reduce((a, r) => a + r.qty, 0)
    if (qty > have + QTY_EPSILON) {
      return `${itemName(state, line.item)} ${line.lot} in ${line.location} has only ${Number(
        have.toFixed(3),
      )} left, not ${Number(qty.toFixed(3))}.`
    }
  }
  return null
}

/**
 * Writes the ledger lines and returns the record. One ledger row per issue line: the
 * line already names exactly which stock row it came out of, so there is nothing to
 * walk and nothing to apportion.
 */
export function postStockIssueLines(
  draft: AppState,
  id: string,
  input: StockIssueInput,
): StockIssue {
  const rows = stockRows(draft)
  const lines: StockIssueLine[] = liveLines(input.lines).map((l) => {
    const row = rows.find((r) => sameRow(l, r))
    const item = draft.items.find((i) => i.id === l.item)
    return {
      item: l.item,
      itemType: row?.itemType || item?.type || '',
      lot: l.lot,
      location: l.location,
      status: l.status,
      uom: row?.uom || item?.uom || 'Unit',
      qty: l.qty,
      // Copied, not looked up: revaluing the item later must not rewrite what this
      // issue cost the plant on the day it happened.
      unitCost: row?.unitCost || 0,
      expiry: l.expiry || row?.expiry,
    }
  })

  for (const l of lines) {
    draft.ledger.push({
      id: uid('LED'),
      type: 'Stock Issue',
      doc: id,
      item: l.item,
      itemType: l.itemType,
      lot: l.lot,
      location: l.location,
      status: l.status,
      qtyIn: 0,
      qtyOut: l.qty,
      uom: l.uom,
      unitCost: l.unitCost,
      time: nowISO(),
      expiry: l.expiry,
    })
  }

  return {
    id,
    date: new Date(input.date).toISOString(),
    reason: input.reason,
    recipient: input.recipient?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    lines,
    value: issueValue(lines),
  }
}

/** "3 Pack OG Tender Coconut Water 5 L, 2 Pack …" — how an audit line reads. */
export const describeIssue = (state: AppState, lines: StockIssueLine[]) =>
  lines.map((l) => `${Number(l.qty.toFixed(3))} ${l.uom} ${itemName(state, l.item)}`).join(', ') ||
  'nothing'
