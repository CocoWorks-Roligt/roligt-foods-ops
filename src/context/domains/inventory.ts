/**
 * Stock moving between rooms, and stock leaving for something that is not a sale.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { checkStockIssue, describeIssue, postStockIssueLines } from '../../lib/issues'
import type { StockIssueInput } from '../../lib/issues'
import { checkArea } from '../../lib/posting'
import type { MoveStockInput } from '../../lib/posting'
import { isRow, itemName, locationLabel } from '../../lib/stock'
import { stockIdOfRow } from '../../lib/stockIds'
import { deepClone, nowISO, uid, fmtQty } from '../../lib/utils'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useInventory({ state, setState, nextId, log, showToast, rows }: CoreDeps) {
  const moveStock = useCallback(
    (input: MoveStockInput): string | null => {
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
    [log, rows, setState, showToast, state],
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
          'Issued stock',
          id,
          `${issue.reason}${issue.recipient ? ` — ${issue.recipient}` : ''}: ${describeIssue(draft, issue.lines)}.`,
        )
        createdId = id
        return draft
      })
      showToast('Stock issued.')
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
      if (!existing) return null
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
          'Edited stock issue',
          id,
          `${issue.reason}${issue.recipient ? ` — ${issue.recipient}` : ''}: ${describeIssue(draft, issue.lines)}.`,
        )
        return draft
      })
      showToast('Stock issue updated.')
      return id
    },
    [log, setState, showToast, state],
  )

  const deleteStockIssue = useCallback(
    (id: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const issue = draft.stockIssues.find((i) => i.id === id)
        if (!issue) return prev
        draft.stockIssues = draft.stockIssues.filter((i) => i.id !== id)
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        log(
          draft,
          'Deleted stock issue',
          id,
          `Returned ${describeIssue(draft, issue.lines)} to stock.`,
        )
        return draft
      })
      showToast('Stock issue deleted; stock returned.')
    },
    [log, setState, showToast],
  )

  return useMemo(
    () => ({
      moveStock,
      createStockIssue,
      updateStockIssue,
      deleteStockIssue,
    }),
    [
      moveStock,
      createStockIssue,
      updateStockIssue,
      deleteStockIssue,
    ],
  )
}
