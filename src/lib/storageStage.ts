/**
 * The Storage put-away form's pure folds (WORKFLOW W13). Every booking already
 * chooses an area on its own write (the Receipt and Packing forms do), so what
 * is left for put-away is stock ALREADY on hand sitting somewhere it should not
 * or would not usually be: an area whose rules no longer take it, a room the
 * plant has deactivated, or merely an unusual home.
 *
 * Nothing is re-derived — the predicates are the app's own. `areaRefusal` and
 * `roomSuits` are the same folds every area picker and the move dialog flag
 * with, and the write is `moveStock`, the same path the Inventory page's Move
 * button posts. A move changes where stock sits and never its QC status, so
 * the pipeline Stock tile's held lots are NOT this queue: a Quarantine lot
 * owes a verdict (the QC bench) and a Rejected lot parked in a hold area owes
 * a write-off (Stock Issues) — each is already where it belongs.
 */
import {
  areaRefusal,
  itemTypeLabel,
  roomSuits,
  stockRowKey,
  stockRows,
  storageTypeLabel,
} from './stock.ts'
import { stockIdOfRow } from './stockIds.ts'
import { QTY_EPSILON } from './utils.ts'
import type { AppState, StockRow, StorageLocation } from '../types.ts'

/** Why a row is in the put-away queue — the flag ladder's own severity order. */
export type PutAwayReason = 'refused' | 'inactive' | 'unusual'

/** The one-word tag the queue select shows after each option. */
export const PUT_AWAY_TAG: Record<PutAwayReason, string> = {
  refused: 'area refuses it',
  inactive: 'area inactive',
  unusual: 'unusual home',
}

export interface PutAwayRow {
  /** The row's own identity (stockRowKey) — what the queue select keys on. */
  key: string
  /** The stock row itself — its identity is what moveStock wants, verbatim. */
  row: StockRow
  /** The area it sits in, if the Storage page still has it. */
  area: StorageLocation | undefined
  /** The stock ID printed on it — what a scan reads. */
  stockId: string
  reason: PutAwayReason
  /** The app's own words for why it is here. */
  why: string
}

/**
 * The put-away queue: every stock row on hand the app's own rules would flag
 * where it sits — rule-broken first (an area that refuses it, or a room that
 * no longer exists), then stock in a deactivated room, then the merely
 * unusual. Within a band, what expires soonest goes first: perishable stock
 * in the wrong room is the urgent pallet.
 */
export function putAwayRows(state: AppState): PutAwayRow[] {
  const out: PutAwayRow[] = []
  for (const row of stockRows(state)) {
    // Only stock on hand can be carried anywhere; an over-drawn negative row
    // is the reconciliation banner's business, not a pallet on a floor.
    if (row.qty <= QTY_EPSILON) continue
    const area = state.storageLocations.find((s) => s.name === row.location)
    const kind = itemTypeLabel(row.itemType).toLowerCase()
    let reason: PutAwayReason | undefined
    let why = ''
    if (!area) {
      // areaDeleteBlocker refuses to delete an area the ledger has ever named,
      // so this is drift (a master lost around the stock) — the most broken
      // seat of all, and every destination fixes it.
      reason = 'refused'
      why = `${row.location} is not on the Storage page any more — move this stock into an area that exists.`
    } else if (area.status !== 'Active') {
      reason = 'inactive'
      why = `${area.label} is inactive — this stock should live in an area still in use.`
    } else {
      const refusal = areaRefusal(area, row.itemType, row.status)
      if (refusal) {
        reason = 'refused'
        why = refusal
      } else if (!roomSuits(row.itemType, area.type, row.status)) {
        reason = 'unusual'
        why = `${kind} is not usually kept in a ${storageTypeLabel(area.type).toLowerCase()} — check this is where it was meant to sit.`
      }
    }
    if (!reason) continue
    out.push({ key: stockRowKey(row), row, area, stockId: stockIdOfRow(state, row), reason, why })
  }
  const band = { refused: 0, inactive: 1, unusual: 2 } as const
  return out.sort(
    (a, b) =>
      band[a.reason] - band[b.reason] ||
      (a.row.expiry || '9999').localeCompare(b.row.expiry || '9999') ||
      a.stockId.localeCompare(b.stockId),
  )
}
