/**
 * The shipments module-level store (SHIPMENT S1).
 *
 * Shipments are NOT an AppState key: Classic's client state never carries
 * them, so the board (and the delivery PWA beside it) fetch their own list
 * off /api/shipments and park it here. Two reasons it is a store and not
 * page state: the sidebar badge counts active trips even when the board is
 * unmounted (Layout subscribes), and both screens refetch on the same SSE
 * revision tick without racing each other into different truths. Nothing
 * here persists — it is a cache of the server's answer, replaced whole.
 */
import type { ShipmentDetail, ShipmentStatus } from './contracts.ts'
import { isTripActive } from './shipmentView.ts'

type Listener = () => void

let details: ShipmentDetail[] = []
const listeners = new Set<Listener>()

/** Replace the cache whole — the server's list IS the truth. */
export function setShipments(next: ShipmentDetail[]): void {
  details = next
  for (const l of listeners) l()
}

export const shipmentsSnapshot = (): ShipmentDetail[] => details

export function subscribeShipments(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The sidebar badge: trips still owed to somebody — the active statuses. */
export const activeTripCount = (
  list: readonly ShipmentDetail[] = details,
  active: (s: ShipmentStatus) => boolean = isTripActive,
): number => list.filter((d) => active(d.shipment.status)).length
