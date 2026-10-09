/**
 * Stock moving between rooms, stock handed to NPD, and stock leaving for something
 * that is not a sale.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { checkStockIssue, describeIssue, postStockIssueLines } from '../../lib/issues'
import type { StockIssueInput } from '../../lib/issues'
import { checkSendToNpd, isNpdUse, postSendToNpd } from '../../lib/npd'
import type { SendToNpdInput } from '../../lib/npd'
import { checkArea } from '../../lib/posting'
import type { MoveStockInput } from '../../lib/posting'
import { isRow, itemName, locationLabel } from '../../lib/stock'
import { stockIdOfRow } from '../../lib/stockIds'
import { deepClone, nowISO, uid, fmtQty } from '../../lib/utils'
import { NPD_USE } from '../../types'
import { POSTED, goneFromDevice } from './deps'
import type { CoreDeps } from './deps'

/** How an issue reads in the audit trail — NPD use says what for and why. */
const describeRecord = (state: Parameters<typeof describeIssue>[0], issue: ReturnType<typeof postStockIssueLines>) =>
  isNpdUse(issue)
    ? `${issue.npdPurpose || 'Other'}${issue.recipient ? ` — ${issue.recipient}` : ''}: ${describeIssue(state, issue.lines)}. ${issue.notes || ''}`.trim()
    : `${issue.reason}${issue.recipient ? ` — ${issue.recipient}` : ''}: ${describeIssue(state, issue.lines)}.`

export function useInventory({ state, setState, nextId, log, forbidden, showToast, rows }: CoreDeps) {
  const moveStock = useCallback(
    (input: MoveStockInput): string | null => {
      // A stock move posts nothing but ledger lines and an audit row — the
      // server's ride-along gate lets exactly the Storage page's holder do
      // that without a document. Refuse before a line exists, so the work is
      // never created just to be unsavable.
      if (forbidden('Moving stock', 'page.storage')) return null
      const { item, lot, status, from, to, expiry, qty } = input
      if (!to || from === to) {
        showToast('Pick a different destination.')
        return null
      }
      const target = state.storageLocations.find((s) => s.name === to)
      if (!target || target.status !== 'Active') {
        showToast('Pick an active storage area.')
        return null
      }
      // Matched on the whole row identity. Two runs off one batch into one freezer are
      // two rows carrying two dates; found by item, lot, status and room alone, a move
      // took its ceiling from whichever came first and stamped its lines with that
      // row's date — so moving the newer stock drew the older bucket down instead.
      const r = rows.find(
        (x) => isRow(x, { item, lot, location: from, expiry }) && x.status === status,
      )
      if (!r || r.qty <= 0) {
        showToast('That stock is no longer on hand.')
        return null
      }
      if (qty <= 0 || qty > r.qty) {
        showToast(`Enter a quantity above 0 and no more than ${fmtQty(r.qty)} ${r.uom}.`)
        return null
      }
      // The dialog only offers areas that may take this stock, but the dropdown is not the
      // rule — this is, so a stale form or a second caller cannot route around it.
      const badArea = checkArea(state, to, r.itemType, { status: r.status })
      if (badArea) {
        showToast(badArea)
        return null
      }

      setState((prev) => {
        const draft = deepClone(prev)
        const doc = uid('MOV')
        const time = nowISO()
        // Out of the old place and into the new one at the same unit cost — a move
        // relocates stock, it never revalues it.
        const line = (location: string, qtyIn: number, qtyOut: number) => ({
          id: uid('LED'),
          type: 'Stock Transfer',
          doc,
          item: r.item,
          itemType: r.itemType,
          lot: r.lot,
          location,
          status: r.status,
          qtyIn,
          qtyOut,
          uom: r.uom,
          unitCost: r.unitCost,
          time,
          expiry: r.expiry,
        })
        draft.ledger.push(line(from, 0, qty))
        draft.ledger.push(line(to, qty, 0))
        // Filed under the stock item that moved, so its record's history carries it.
        log(
          draft,
          'Moved stock',
          stockIdOfRow(draft, r),
          `${qty} ${r.uom} of ${itemName(draft, item)} (${lot}) from ${locationLabel(draft, from)} to ${target.label}${input.note ? ` — ${input.note}` : ''}.`,
        )
        return draft
      })
      showToast(`Moved ${qty} ${r.uom} to ${target.label}.`)
      return POSTED
    },
    [forbidden, log, rows, setState, showToast, state],
  )

  /**
   * Hands stock to NPD: a move into an NPD area that flips the status to NPD on the way
   * in, after which nothing in production can draw it. It is a move in every other
   * respect — two ledger lines and an audit row, no document — so it takes the same
   * Storage-page gate moveStock does, and the server's ride-along rule lands it.
   */
  const sendToNpd = useCallback(
    (input: SendToNpdInput): string | null => {
      if (forbidden('Sending stock to NPD', 'page.storage')) return null
      const error = checkSendToNpd(state, input)
      if (error) {
        showToast(error)
        return null
      }
      const area = state.storageLocations.find((s) => s.name === input.to)
      let sent = ''
      setState((prev) => {
        const draft = deepClone(prev)
        // Checked again against the copy being written: a pack-out on another screen
        // can have drawn the row down since the form opened.
        if (checkSendToNpd(draft, input)) return prev
        const { doc, row } = postSendToNpd(draft, input)
        log(
          draft,
          'Sent stock to NPD',
          stockIdOfRow(draft, row),
          `${fmtQty(input.qty)} ${row.uom} of ${itemName(draft, row.item)} (${row.lot}, ${row.status}) from ${locationLabel(draft, input.location)} to ${area?.label || input.to}${input.note?.trim() ? ` — ${input.note.trim()}` : ''}.`,
        )
        sent = doc
        return draft
      })
      showToast(`Sent ${fmtQty(input.qty)} to NPD — ${area?.label || input.to}.`)
      return sent || POSTED
    },
    [forbidden, log, setState, showToast, state],
  )

  /**
   * Stock out for something that is not a sale.
   *
   * Kept apart from dispatch on purpose: no customer, no challan, no label, and it
   * never reaches sales or delivery reporting. Before this, a lab sample or a BTL run
   * had to be booked as a dispatch to an invented customer, which also spent a number
   * out of a challan series that has to run unbroken.
   */
  const createStockIssue = useCallback(
    (input: StockIssueInput): string | null => {
      const error = checkStockIssue(state, input)
      if (error) {
        showToast(error)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'issue')
        const issue = postStockIssueLines(draft, id, input)
        draft.stockIssues.unshift(issue)
        log(
          draft,
          isNpdUse(issue) ? 'Recorded NPD use' : 'Issued stock',
          id,
          describeRecord(draft, issue),
        )
        createdId = id
        return draft
      })
      showToast(input.reason === NPD_USE ? 'NPD use recorded.' : 'Stock issued.')
      return createdId || POSTED
    },
    [log, nextId, setState, showToast, state],
  )

  /**
   * Reverses the issue's own ledger lines and posts it again, which is how every
   * document in this app is edited — see `updateGrn`. Validating with the issue's own
   * lines taken back out is what lets an operator correct a quantity downwards without
   * being told the stock it is already holding down is unavailable.
   */
  const updateStockIssue = useCallback(
    (id: string, input: StockIssueInput): string | null => {
      const existing = state.stockIssues.find((i) => i.id === id)
      if (!existing) {
        showToast(goneFromDevice('stock issue'))
        return null
      }
      const error = checkStockIssue(state, input, id)
      if (error) {
        showToast(error)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        // The issue can have been deleted on another screen since the check above.
        // Re-posting regardless would leave ledger lines drawing stock down with no
        // document left to explain them.
        if (!draft.stockIssues.some((i) => i.id === id)) return prev
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        const issue = postStockIssueLines(draft, id, input)
        draft.stockIssues = draft.stockIssues.map((i) => (i.id === id ? issue : i))
        log(
          draft,
          isNpdUse(issue) ? 'Edited NPD use' : 'Edited stock issue',
          id,
          describeRecord(draft, issue),
        )
        return draft
      })
      showToast(input.reason === NPD_USE ? 'NPD use updated.' : 'Stock issue updated.')
      return id
    },
    [log, setState, showToast, state],
  )

  const deleteStockIssue = useCallback(
    (id: string) => {
      if (!state.stockIssues.some((i) => i.id === id)) {
        showToast(goneFromDevice('stock issue', 'try again'))
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const issue = draft.stockIssues.find((i) => i.id === id)
        if (!issue) return prev
        draft.stockIssues = draft.stockIssues.filter((i) => i.id !== id)
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        log(
          draft,
          isNpdUse(issue) ? 'Deleted NPD use' : 'Deleted stock issue',
          id,
          `Returned ${describeIssue(draft, issue.lines)} to ${isNpdUse(issue) ? 'NPD' : 'stock'}.`,
        )
        return draft
      })
      const npd = state.stockIssues.find((i) => i.id === id)
      showToast(npd && isNpdUse(npd) ? 'NPD use deleted; stock returned to NPD.' : 'Stock issue deleted; stock returned.')
    },
    [log, setState, showToast, state.stockIssues],
  )

  return useMemo(
    () => ({
      moveStock,
      sendToNpd,
      createStockIssue,
      updateStockIssue,
      deleteStockIssue,
    }),
    [
      moveStock,
      sendToNpd,
      createStockIssue,
      updateStockIssue,
      deleteStockIssue,
    ],
  )
}
