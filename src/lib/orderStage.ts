/**
 * The Order stage form's pure folds (WORKFLOW W14). An open order's next action
 * is a dispatch, but what the desk owes first is seeing them honestly: in
 * ship-by order, the overdue ones named, and each line held against the
 * released packs the dispatch path itself would draw from — the same pool
 * `seedAllocations` fills from, never a reservation.
 *
 * The write is `saveOrder` — the SAME Classic path the register's raise/edit
 * modal posts — and the draft folds (`draftFromOrder`, `linesFromDraft`) are
 * the modal's own, shared.
 */
import { releasedPacksBySku } from './ordersView.ts'
import { stockRows } from './stock.ts'
import type { AppState, Order, OrderLine } from '../types.ts'

/** One open order as the desk reads it. */
export interface OpenOrderRow {
  order: Order
  /** Past its ship-by day — the pipeline Orders tile's own flag. */
  overdue: boolean
  /** Each line against released on-hand for its sku. */
  lines: OrderLineFill[]
  /** Every line fits released stock — a guide, not a reservation. */
  fillable: boolean
}

export interface OrderLineFill {
  sku: string
  qty: number
  /** Released packs on hand for this sku — the dispatch path's own pool. */
  onHand: number
  short: boolean
}

/**
 * The desk's queue: every open order (the pipeline Orders tile's own
 * predicate), soonest ship-by first with the undated last — the orders the
 * tile flags as overdue are exactly the head of this list.
 */
export function openOrderRows(state: AppState, today: string): OpenOrderRow[] {
  const available = releasedPacksBySku(state, stockRows(state))
  const onHand = (sku: string) => (available.get(sku) || []).reduce((a, r) => a + r.qty, 0)
  return state.orders
    .filter((o) => o.status === 'Open')
    .map((order) => {
      const lines: OrderLineFill[] = order.lines.map((l: OrderLine) => {
        const hand = onHand(l.sku)
        return { sku: l.sku, qty: l.qty, onHand: hand, short: l.qty > hand }
      })
      return {
        order,
        overdue: !!order.dueDate && order.dueDate < today,
        lines,
        fillable: lines.every((l) => !l.short),
      }
    })
    .sort(
      (a, b) =>
        (a.order.dueDate || '9999').localeCompare(b.order.dueDate || '9999') ||
        a.order.id.localeCompare(b.order.id),
    )
}
