/**
 * What a customer asked for, and the goods that left against it.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { checkDispatch, checkOrderDispatch } from '../../lib/posting'
import type { DispatchInput, OrderAllocation } from '../../lib/posting'
import { isRow, locationLabel, stockRows, itemName } from '../../lib/stock'
import { deepClone, nowISO, uid } from '../../lib/utils'
import type { Dispatch, OrderLine } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps, DeliveryInput } from './deps'

export function useSales({ state, setState, nextId, log, showToast, announcement }: CoreDeps) {
  const saveOrder = useCallback(
    (input: { customerId: string; date: string; lines: OrderLine[]; notes?: string }, id?: string) => {
      const customer = state.customers.find((c) => c.id === input.customerId)
      if (!customer) {
        showToast('Select a customer.')
        return null
      }
      const lines = input.lines.filter((l) => l.sku && l.qty > 0)
      if (!lines.length) {
        showToast('Add at least one product to the order.')
        return null
      }
      if (new Set(lines.map((l) => l.sku)).size !== lines.length) {
        showToast('Each product can only be listed once — change the quantity instead.')
        return null
      }
      let savedId = id || ''
      setState((prev) => {
        const draft = deepClone(prev)
        if (id) {
          const o = draft.orders.find((x) => x.id === id)
          if (!o) return prev
          if (o.status !== 'Open') return prev
          Object.assign(o, {
            customerId: customer.id,
            customerName: customer.name,
            date: new Date(input.date).toISOString(),
            lines,
            notes: input.notes,
          })
          log(draft, 'Edited order', id, `${customer.name} — ${lines.length} line(s).`)
        } else {
          savedId = nextId(draft, 'order')
          draft.orders.push({
            id: savedId,
            customerId: customer.id,
            customerName: customer.name,
            date: new Date(input.date).toISOString(),
            lines,
            status: 'Open',
            notes: input.notes,
          })
          log(draft, 'Raised order', savedId, `${customer.name} — ${lines.length} line(s).`)
        }
        return draft
      })
      showToast(id ? 'Order updated.' : 'Order raised.')
      return savedId || POSTED
    },
    [log, nextId, setState, showToast, state.customers],
  )

  const cancelOrder = useCallback(
    (id: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const o = draft.orders.find((x) => x.id === id)
        if (!o || o.status !== 'Open') return prev
        o.status = 'Cancelled'
        log(draft, 'Cancelled order', id, o.customerName)
        return draft
      })
      showToast('Order cancelled.')
    },
    [log, setState, showToast],
  )

  const deleteOrder = useCallback(
    (id: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const o = draft.orders.find((x) => x.id === id)
        if (!o || o.status === 'Dispatched') return prev
        draft.orders = draft.orders.filter((x) => x.id !== id)
        log(draft, 'Deleted order', id, o.customerName)
        return draft
      })
      showToast('Order deleted.')
    },
    [log, setState, showToast],
  )

  /**
   * Sends a whole order out in one write. Every line is checked against live stock
   * first and the lot refused outright if any of it falls short, so the ledger never
   * ends up holding half an order. The lines become ordinary dispatch records sharing
   * one challan, which keeps the existing challan, POD and delivery machinery working.
   */
  const dispatchOrder = useCallback(
    (orderId: string, allocations: OrderAllocation[], vehicle: string, expected?: string) => {
      const order = state.orders.find((o) => o.id === orderId)
      if (!order) return null
      if (order.status !== 'Open') {
        showToast('That order has already been dealt with.')
        return null
      }
      const check = checkOrderDispatch(state, order, allocations)
      if (!check.ok) {
        showToast(check.error)
        return null
      }
      let challanNo = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const o = draft.orders.find((x) => x.id === orderId)
        if (!o) return prev
        challanNo = nextId(draft, 'challan')
        const time = nowISO()
        const live = stockRows(draft)
        for (const row of check.rows) {
          const id = nextId(draft, 'dispatch')
          // The row that was actually checked, date and status included. Matched on
          // item, lot and room alone this could answer with a quarantined or rejected
          // row sitting in the same place, and book the dispatch at its cost.
          const stock = live.find(
            (r) =>
              isRow(r, {
                item: row.sku,
                lot: row.lot,
                location: row.location,
                expiry: row.expiry,
              }) && r.status === 'Released',
          )
          draft.ledger.push({
            id: uid('LED'),
            type: 'Dispatch',
            doc: id,
            item: row.sku,
            itemType: 'Finished Goods',
            lot: row.lot,
            location: row.location,
            status: 'Released',
            qtyIn: 0,
            qtyOut: row.qty,
            uom: stock?.uom || 'Pack',
            unitCost: stock?.unitCost || 0,
            time,
            expiry: row.expiry,
          })
          draft.dispatches.push({
            id,
            customerId: o.customerId,
            customerName: o.customerName,
            batchId: row.lot,
            sku: row.sku,
            qty: row.qty,
            expiry: row.expiry,
            challan: challanNo,
            vehicle,
            dispatchTime: time,
            expected,
            status: 'Dispatched',
            pod: '',
            orderId: o.id,
          })
          // Each dispatch its own entry, as one raised on the Dispatch page gets — the
          // order's entry below says only that the order went.
          log(
            draft,
            'Confirmed dispatch',
            id,
            `Deducted ${row.qty} ${stock?.uom || 'Pack'} of ${itemName(draft, row.sku)} from ${row.lot} at ${locationLabel(draft, row.location)} for ${o.id}.`,
          )
        }
        o.status = 'Dispatched'
        o.challan = challanNo
        o.dispatchedAt = time
        log(
          draft,
          'Dispatched order',
          o.id,
          `${o.customerName} — ${check.rows.length} line(s) on ${challanNo}.`,
        )
        announcement.current = `Order dispatched on ${challanNo}.`
        return draft
      })
      return challanNo || POSTED
    },
    [announcement, log, nextId, setState, showToast, state],
  )

  const createDispatch = useCallback(
    (input: DispatchInput): string | null => {
      const check = checkDispatch(state, input)
      if (!check.ok) {
        showToast(check.error)
        return null
      }
      const r = check.row
      const customer = state.customers.find((c) => c.id === input.customerId)!

      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'dispatch')
        const challan = nextId(draft, 'challan')
        draft.ledger.push({
          id: uid('LED'),
          type: 'Dispatch',
          doc: id,
          item: input.sku,
          itemType: 'Finished Goods',
          lot: input.batchId,
          location: r.location,
          status: 'Released',
          qtyIn: 0,
          qtyOut: input.qty,
          uom: r.uom,
          unitCost: r.unitCost,
          time: nowISO(),
          expiry: r.expiry,
        })
        const d: Dispatch = {
          id,
          customerId: customer.id,
          customerName: customer.name,
          batchId: input.batchId,
          sku: input.sku,
          qty: input.qty,
          expiry: r.expiry,
          challan,
          vehicle: input.vehicle,
          dispatchTime: nowISO(),
          expected: input.expected,
          status: 'Dispatched',
          pod: '',
          notes: input.notes,
        }
        draft.dispatches.push(d)
        log(
          draft,
          'Confirmed dispatch',
          id,
          `Deducted ${input.qty} ${r.uom} of ${itemName(draft, input.sku)} from ${input.batchId} at ${locationLabel(draft, r.location)}.`,
        )
        createdId = id
        announcement.current = `${id} confirmed.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, setState, showToast, state],
  )

  const updateDispatch = useCallback(
    (id: string, input: DispatchInput): string | null => {
      if (!state.dispatches.some((d) => d.id === id)) return null
      // Nothing is drawn from a dispatch, so it is measured against stock as it stood
      // before it went out and its deduction is simply re-posted from the new figures.
      const check = checkDispatch(state, input, id)
      if (!check.ok) {
        showToast(check.error)
        return null
      }
      const r = check.row
      const customer = state.customers.find((c) => c.id === input.customerId)!

      setState((prev) => {
        const draft = deepClone(prev)
        const d = draft.dispatches.find((x) => x.id === id)
        if (!d) return prev
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        draft.ledger.push({
          id: uid('LED'),
          type: 'Dispatch',
          doc: id,
          item: input.sku,
          itemType: 'Finished Goods',
          lot: input.batchId,
          location: r.location,
          status: 'Released',
          qtyIn: 0,
          qtyOut: input.qty,
          uom: r.uom,
          unitCost: r.unitCost,
          time: nowISO(),
          expiry: r.expiry,
        })
        // Challan, dispatch time and the delivery record stay put — an edit corrects
        // what went out, it does not re-issue the document or reopen the delivery.
        d.customerId = customer.id
        d.customerName = customer.name
        d.batchId = input.batchId
        d.sku = input.sku
        d.qty = input.qty
        d.expiry = r.expiry
        d.vehicle = input.vehicle
        d.expected = input.expected
        d.notes = input.notes
        log(
          draft,
          'Edited dispatch',
          id,
          `Now ${input.qty} ${r.uom} of ${input.sku} from ${input.batchId} to ${customer.name}.`,
        )
        return draft
      })
      showToast(`${id} updated.`)
      return id
    },
    [log, setState, showToast, state],
  )

  const deleteDispatch = useCallback(
    (id: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const d = draft.dispatches.find((x) => x.id === id)
        if (!d) return prev
        draft.dispatches = draft.dispatches.filter((x) => x.id !== id)
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)

        /**
         * An order goes out complete, on one challan. Deleting the last line of that
         * challan put the stock back on the shelf but left the order marked Dispatched
         * against a challan with nothing on it — and `dispatchOrder` refuses an order
         * that is not Open, so the customer's order was stuck for good with no way to
         * send it again.
         */
        const order = d.orderId ? draft.orders.find((o) => o.id === d.orderId) : undefined
        const reopened = order && !draft.dispatches.some((x) => x.orderId === order.id)
        if (order && reopened) {
          order.status = 'Open'
          order.challan = undefined
          order.dispatchedAt = undefined
        }

        log(
          draft,
          'Deleted dispatch',
          id,
          `Reversed ${d.qty} ${d.sku} back to Released stock.${
            reopened ? ` ${order!.id} is open again.` : ''
          }`,
        )
        announcement.current = reopened
          ? `Dispatch deleted; ${order!.id} is open again and its stock is back.`
          : 'Dispatch deleted; stock recalculated.'
        return draft
      })
    },
    [announcement, log, setState],
  )

  /**
   * Closes the trip and records who took the goods.
   *
   * Stock came off the books at dispatch, so nothing here touches inventory. What it
   * does carry is the proof: a name or a slip reference, and the photographs taken at
   * the door — the signed slip, the stacked cartons, the temperature on the probe.
   * A typed name is somebody's word for it; a photograph is the record.
   */
  const completeDelivery = useCallback(
    (id: string, input: DeliveryInput) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const d = draft.dispatches.find((x) => x.id === id)
        if (!d) return prev
        d.status = input.status
        d.pod = input.pod
        d.deliveryNote = input.note
        d.podPhotos = input.photos?.length ? input.photos : undefined
        // Kept, not restamped: reopening a delivered trip to attach the photo somebody
        // forgot must not move the time it was actually delivered.
        d.deliveredTime = d.deliveredTime || nowISO()
        const shots = input.photos?.length || 0
        log(
          draft,
          'Updated delivery',
          d.id,
          `${d.status}${shots ? ` · ${shots} proof photo(s)` : ''}. No second stock deduction.`,
        )
        return draft
      })
      showToast('Delivery status updated.')
    },
    [log, setState, showToast],
  )

  return useMemo(
    () => ({
      saveOrder,
      cancelOrder,
      deleteOrder,
      dispatchOrder,
      createDispatch,
      updateDispatch,
      deleteDispatch,
      completeDelivery,
    }),
    [
      saveOrder,
      cancelOrder,
      deleteOrder,
      dispatchOrder,
      createDispatch,
      updateDispatch,
      deleteDispatch,
      completeDelivery,
    ],
  )
}
