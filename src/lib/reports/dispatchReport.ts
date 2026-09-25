/**
 * Report 6 — dispatch, month-wise or batch-wise.
 *
 * Dispatch lines are grouped (by the month they went out, or by the batch they
 * came from) and then by SKU. Quantities are never summed across units: packs of
 * 5 L BiBs and kilograms of malai covers are different physical things, and a
 * single "units" column would add them into a number that means nothing — the
 * same rule the stock pages already work by.
 *
 * A dispatch line is either delivered (status Delivered) or still outstanding
 * (Dispatched / In Transit), and POD completeness counts the lines whose proof
 * of delivery was never written down.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState } from '../../types.ts'
import type { ReportWindow } from './params.ts'
import { inWindow } from './params.ts'
import { localDay } from '../utils.ts'

export type DispatchGrouping = 'month' | 'batch'

export interface DispatchRow {
  /** The group's key — a month, or a batch id. */
  group: string
  /** What the group's key reads like on the page. */
  groupLabel: string
  /** The batch the goods came from — always present, whichever way the rows are
   *  grouped, because it is how the row drills through. */
  batchId: string
  sku: string
  skuName: string
  uom: string
  qty: number
  deliveredQty: number
  /** Dispatched / In Transit — gone but not signed for. */
  pendingQty: number
  dispatchCount: number
  customers: string[]
  challans: string[]
  /** Dispatches in this cell with no proof of delivery recorded. */
  podMissing: number
  /** Orders these dispatches fulfilled, when they came from orders. */
  orderIds: string[]
}

const OUTSTANDING = ['Dispatched', 'In Transit']

export function dispatchRows(
  state: AppState,
  w: ReportWindow,
  groupBy: DispatchGrouping,
): DispatchRow[] {
  const inRange = state.dispatches.filter((d) => inWindow(localDay(d.dispatchTime), w))
  const cells = new Map<string, DispatchRow>()

  for (const d of inRange) {
    const day = localDay(d.dispatchTime)
    const group = groupBy === 'month' ? day.slice(0, 7) : d.batchId
    const key = `${group}|${d.sku}`
    const groupLabel =
      groupBy === 'month' ? group : state.batches.find((b) => b.id === group)?.id || group
    let row = cells.get(key)
    if (!row) {
      row = {
        group,
        groupLabel,
        batchId: d.batchId,
        sku: d.sku,
        skuName: state.items.find((i) => i.id === d.sku)?.name || d.sku,
        uom: state.items.find((i) => i.id === d.sku)?.uom || 'Pack',
        qty: 0,
        deliveredQty: 0,
        pendingQty: 0,
        dispatchCount: 0,
        customers: [],
        challans: [],
        podMissing: 0,
        orderIds: [],
      }
      cells.set(key, row)
    }
    row.qty += d.qty || 0
    if (OUTSTANDING.includes(d.status)) row.pendingQty += d.qty || 0
    else row.deliveredQty += d.qty || 0
    row.dispatchCount += 1
    if (d.status === 'Delivered' && !d.pod?.trim()) row.podMissing += 1
    const customer = d.customerName || state.customers.find((c) => c.id === d.customerId)?.name
    if (customer && !row.customers.includes(customer)) row.customers.push(customer)
    if (d.challan && !row.challans.includes(d.challan)) row.challans.push(d.challan)
    if (d.orderId && !row.orderIds.includes(d.orderId)) row.orderIds.push(d.orderId)
  }

  return [...cells.values()].sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.skuName.localeCompare(b.skuName) ||
      a.batchId.localeCompare(b.batchId),
  )
}
