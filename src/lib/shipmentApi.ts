/**
 * Fetch client for the shipment wire (SHIPMENT S1) — the board's whole server
 * surface. Rides poApi's shared session plumbing (same-origin cookie, one 401
 * is final, an Idempotency-Key per mutating intent) exactly like gradingApi
 * does; the error class is shape-generic (message + the guard's code/details).
 *
 * The delivery PWA (S2) adds the submit/events/returns calls beside these
 * rather than growing a second copy of the session semantics.
 */
import { call, read, newIdempotencyKey, PoApiError } from './poApi'
import type {
  Challan,
  ChallanCorrectRequest,
  ChallanCorrectResponse,
  ChallanListResponse,
  CreateShipmentRequest,
  CreateShipmentResponse,
  DeliveryEventRequest,
  DeliveryEventResponse,
  PatchShipmentRequest,
  PatchShipmentResponse,
  ShipmentDetail,
  ShipmentEventsResponse,
  ShipmentListResponse,
  ShipmentVersionExtension,
} from './contracts'
import type { Shipment } from './contracts'

export { PoApiError, newIdempotencyKey }

/** The board's row doc — the trip plus its CAS token (documents.version). */
export type ShipmentRow = Shipment & ShipmentVersionExtension

export async function fetchShipments(): Promise<ShipmentDetail[]> {
  const res = await call('/api/shipments')
  const j = await read<ShipmentListResponse>(res)
  return j.shipments
}

/** The trip with its lines, challans and append-only event history. */
export async function fetchShipment(id: string): Promise<ShipmentEventsResponse> {
  const res = await call(`/api/shipments/${encodeURIComponent(id)}`)
  return read<ShipmentEventsResponse>(res)
}

export async function createShipmentCall(
  body: CreateShipmentRequest,
  key = newIdempotencyKey(),
): Promise<CreateShipmentResponse['shipment']> {
  const res = await call('/api/shipments', { method: 'POST', body: JSON.stringify(body), idempotencyKey: key })
  const j = await read<CreateShipmentResponse>(res)
  return j.shipment
}

export async function patchShipmentCall(
  id: string,
  body: PatchShipmentRequest,
  key = newIdempotencyKey(),
): Promise<PatchShipmentResponse['shipment']> {
  const res = await call(`/api/shipments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  const j = await read<PatchShipmentResponse>(res)
  return j.shipment
}

/** The PWA's event post — passive breadcrumbs and the status-walking ones. */
export async function postDeliveryEventCall(
  id: string,
  body: DeliveryEventRequest,
  key = newIdempotencyKey(),
): Promise<DeliveryEventResponse> {
  const res = await call(`/api/shipments/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  return read<DeliveryEventResponse>(res)
}

export async function fetchChallans(): Promise<Challan[]> {
  const res = await call('/api/challans')
  const j = await read<ChallanListResponse>(res)
  return j.challans
}

export async function correctChallanCall(
  id: string,
  body: ChallanCorrectRequest,
  key = newIdempotencyKey(),
): Promise<ChallanCorrectResponse['challan']> {
  const res = await call(`/api/challans/${encodeURIComponent(id)}/correct`, {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  const j = await read<ChallanCorrectResponse>(res)
  return j.challan
}

/** The rendered PDF answers here — a redirect, so a plain link target works. */
export const challanFileUrl = (id: string): string => `/api/challans/${encodeURIComponent(id)}/file`
