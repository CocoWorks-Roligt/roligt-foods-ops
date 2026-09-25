/**
 * Reports 7, 8 and 9 — raw material, packing material, and finished goods on
 * hand. One ledger engine, three readings of it.
 *
 * The engine folds ledger lines by item over three cuts:
 *
 *   opening  = balance of every line before the window starts
 *   received = the receipt types inside the window (GRN produce, or PM receipts)
 *   issued   = the consume/dispatch/issue types inside the window
 *   closing  = balance of every line up to the window's end
 *
 * Closing is folded from *all* line types, not just the named receipts and
 * issues, so a status transfer or a move — which nets to zero at item level but
 * is neither a receipt nor an issue — still lands where the Inventory page says
 * it lands. A report and its register cannot disagree if they read the same rows
 * the same way (invariant 1 of the plan). The finished-goods reading goes
 * further and folds through `stockRows` itself, the same function the Inventory
 * page builds its table from.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import { locationLabel, stockRows } from '../stock.ts'
import type { AppState, LedgerEntry } from '../../types.ts'
import type { ReportWindow } from './params.ts'
import { localDay } from '../utils.ts'

const RECEIPT_TYPES = ['Receipt', 'PM Receipt']
const ISSUE_TYPES = ['Production Consume', 'Packing Consume', 'Stock Issue']

export interface ItemFlowRow {
  item: string
  name: string
  uom: string
  itemType: string
  opening: number
  received: number
  issued: number
  closing: number
  openingValue: number
  closingValue: number
  /** PM report: the master's reorder level, when one is set. */
  reorder: number | null
  /** Closing below the reorder level. */
  belowReorder: boolean
}

/** The day a ledger line happened, as a local date key — the ledger's `time` is
 *  an ISO timestamp, whose first ten characters are the day in Greenwich. */
const lineDay = (l: LedgerEntry) => localDay(l.time)

/** Opening → received → issued → closing for every item of the given types that
 *  the ledger has ever seen. */
export function itemFlows(state: AppState, w: ReportWindow, itemTypes: string[]): ItemFlowRow[] {
  const items = state.items.filter((i) => itemTypes.includes(i.type))
  const acc = new Map<
    string,
    { opening: number; received: number; issued: number; closing: number; openingValue: number; closingValue: number }
  >()
  const rowOf = (key: string) => {
    let a = acc.get(key)
    if (!a) {
      a = { opening: 0, received: 0, issued: 0, closing: 0, openingValue: 0, closingValue: 0 }
      acc.set(key, a)
    }
    return a
  }

  for (const l of state.ledger) {
    if (!items.some((i) => i.id === l.item)) continue
    const a = rowOf(l.item)
    const moved = (l.qtyIn || 0) - (l.qtyOut || 0)
    const day = lineDay(l)
    if (day < w.from) {
      a.opening += moved
      a.openingValue += moved * (l.unitCost || 0)
    }
    if (day <= w.to) {
      a.closing += moved
      a.closingValue += moved * (l.unitCost || 0)
    }
    if (day >= w.from && day <= w.to) {
      if (RECEIPT_TYPES.includes(l.type)) a.received += l.qtyIn || 0
      if (ISSUE_TYPES.includes(l.type)) a.issued += l.qtyOut || 0
    }
  }

  return [...acc.entries()]
    .map(([id, a]) => {
      const item = items.find((i) => i.id === id)!
      const round = (n: number) => Number(n.toFixed(3))
      return {
        item: id,
        name: item.name,
        uom: item.uom,
        itemType: item.type,
        opening: round(a.opening),
        received: round(a.received),
        issued: round(a.issued),
        closing: round(a.closing),
        openingValue: Number(a.openingValue.toFixed(2)),
        closingValue: Number(a.closingValue.toFixed(2)),
        reorder: item.reorder > 0 ? item.reorder : null,
        belowReorder: item.reorder > 0 && a.closing < item.reorder,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface LotAgeRow {
  lot: string
  grnId: string
  /** The date ageing runs from: the harvest date when the receipt has one,
   *  otherwise the day it was received. */
  from: string
  received: string
  onHand: number
  uom: string
  locations: string[]
}

export interface AgeBucket {
  bucket: string
  uom: string
  lots: number
  /** Total on hand in this bucket, in `uom` — buckets are per unit, so pieces of
   *  coconut and kilograms of beetroot are never added together. */
  qty: number
}

/** Lots of the given item type still on hand, aged from harvest or receipt.
 *  Ageing is a live question, so `today` is required — the page passes the real
 *  date, tests pass a pinned one. */
export function lotAgeing(
  state: AppState,
  itemTypes: string[],
  today: string,
): { rows: LotAgeRow[]; byAge: AgeBucket[] } {
  const onHand = new Map<string, { qty: number; uom: string; locations: Set<string> }>()
  for (const l of state.ledger) {
    const item = state.items.find((i) => i.id === l.item)
    if (!item || !itemTypes.includes(item.type)) continue
    const moved = (l.qtyIn || 0) - (l.qtyOut || 0)
    if (!moved) continue
    const a = onHand.get(l.lot) || { qty: 0, uom: l.uom, locations: new Set<string>() }
    a.qty += moved
    a.locations.add(l.location)
    onHand.set(l.lot, a)
  }

  const rows: LotAgeRow[] = []
  for (const g of state.grns) {
    const held = onHand.get(g.lot)
    if (!held || held.qty <= 0) continue
    rows.push({
      lot: g.lot,
      grnId: g.id,
      from: g.harvestedOn || g.date,
      received: g.date,
      onHand: Number(held.qty.toFixed(3)),
      uom: held.uom,
      locations: [...held.locations],
    })
  }
  rows.sort((a, b) => a.from.localeCompare(b.from))

  const daysSince = (from: string) => daysBetween(from, today)
  const spans: [string, (d: number) => boolean][] = [
    ['0–3 days', (d) => d <= 3],
    ['4–7 days', (d) => d >= 4 && d <= 7],
    ['8–14 days', (d) => d >= 8 && d <= 14],
    ['15+ days', (d) => d >= 15],
  ]
  const byAge: AgeBucket[] = []
  for (const [bucket, fits] of spans) {
    for (const uom of new Set(rows.filter((r) => fits(Math.max(0, daysSince(r.from)))).map((r) => r.uom))) {
      const inSpan = rows.filter((r) => fits(Math.max(0, daysSince(r.from))) && r.uom === uom)
      byAge.push({
        bucket,
        uom,
        lots: inSpan.length,
        qty: Number(inSpan.reduce((a, r) => a + r.onHand, 0).toFixed(3)),
      })
    }
  }
  return { rows, byAge }
}

export interface FgOnHandRow {
  item: string
  name: string
  lot: string
  location: string
  locationLabel: string
  status: string
  uom: string
  qty: number
  unitCost: number
  value: number
  expiry: string
  /** Days from `today` until expiry; negative once past it. */
  daysToExpiry: number | null
  bucket: string
}

/** Finished goods on hand right now, by storage area and item, aged to each
 *  line's own expiry date. Not windowed — a position, not a movement. Folded by
 *  `stockRows`, the same fold the Inventory page shows. */
export function fgOnHand(state: AppState, today: string): FgOnHandRow[] {
  const alertDays = state.config?.expiryAlertDays ?? 2
  return stockRows(state)
    .filter((r) => r.itemType === 'Finished Goods')
    .map((r) => {
      const days = r.expiry ? daysBetween(today, r.expiry) : null
      return {
        item: r.item,
        name: state.items.find((i) => i.id === r.item)?.name || r.item,
        lot: r.lot,
        location: r.location,
        locationLabel: locationLabel(state, r.location),
        status: r.status,
        uom: r.uom,
        qty: Number(r.qty.toFixed(3)),
        unitCost: Number(r.unitCost.toFixed(2)),
        value: Number(r.value.toFixed(2)),
        expiry: r.expiry || '',
        daysToExpiry: days,
        bucket: !r.expiry
          ? 'No expiry'
          : days! < 0
            ? 'Expired'
            : days! <= alertDays
              ? `≤ ${alertDays} d`
              : days! <= 30
                ? '≤ 30 d'
                : '> 30 d',
      }
    })
    .sort(
      (a, b) =>
        a.locationLabel.localeCompare(b.locationLabel) ||
        a.name.localeCompare(b.name) ||
        a.lot.localeCompare(b.lot) ||
        a.expiry.localeCompare(b.expiry),
    )
}

/** Whole days from `from` to `to` — negative when `to` is before `from`. Both
 *  UTC midnights, so the count is of calendar days and of nothing else. */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  return Math.round(
    (Date.UTC(y2 || 1970, (m2 || 1) - 1, d2 || 1) - Date.UTC(y1 || 1970, (m1 || 1) - 1, d1 || 1)) /
      86400000,
  )
}
