/**
 * /api/shipments — the SHIPMENT endpoints (P4 B5, contracts v1.9). Shipments,
 * their delivery events, challans and returns are server-endpoint-only
 * collections (ARCHITECTURE §5): the board and the delivery PWA read them here,
 * never through the snapshot mirror, so there is no dual-write divergence to
 * reconcile and the PWA's offline outbox replays through the same doors.
 *
 * - POST creates one trip: the dispatches are validated against the masters the
 *   plant already holds — every dispatch must belong to the order, none may
 *   already be on an active shipment, and multi-customer dispatches need the
 *   stops spelled out.
 * - GET lists (newest first) and reads one — an agent's own trips only, and a
 *   foreign trip answers 404, not 403: an external user must not learn that
 *   another shipment id exists.
 * - PATCH is the board's word — reassign the agent, fix the vehicle, move the
 *   ETA, or walk the machine's two board-owned arrows.
 * - POST :id/events is the PWA's append-only history; `started` walks the agent
 *   out for delivery, `failed` and `rescheduled` record the trip's bad day.
 *
 * Not flag-gated: a collection nothing Classic reads is inert by construction.
 */
import type { D1Client } from './d1.js'
import type { Caller } from './auth.js'
import {
  DomainError,
  auditId,
  auditStmt,
  holdsPage,
  insertOnce,
  isDeliveryAgent,
  parseDoc,
  upsertDoc,
  writeBatch,
  isCasTrip,
  type Stmt,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import { canTransition } from '../../src/lib/rules.js'
import {
  DELIVERY_EVENT_TYPES,
  isDeliveryEventType,
  type DeliveryEvent,
  type DeliveryEventRequest,
  type DeliveryEventResponse,
  type CreateShipmentRequest,
  type CreateShipmentResponse,
  type PatchShipmentRequest,
  type PatchShipmentResponse,
  type Shipment,
  type ShipmentChallanLink,
  type ShipmentDetail,
  type ShipmentEventsResponse,
  type ShipmentLine,
  type ShipmentListResponse,
  type ShipmentStatus,
  type ShipmentStop,
} from '../../src/lib/contracts.js'
import type { Customer, Dispatch } from '../../src/types.js'

export const ROUTE = 'POST /api/shipments'
export const PATCH_ROUTE = 'PATCH /api/shipments/:id'
export const EVENTS_ROUTE = 'POST /api/shipments/:id/events'

/** The statuses a trip can still move from — everything but the machine's terminals. */
const ACTIVE_STATUSES: readonly ShipmentStatus[] = [
  'Created',
  'Dispatched',
  'Out for Delivery',
  'Failed',
  'Rescheduled',
]

/** The board's own arrows — the only status moves PATCH will make. */
const PATCHABLE_MOVES: readonly (`${string}→${string}`)[] = ['Created→Dispatched', 'Failed→Rescheduled']

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** An internal id in the ledger's grammar — timestamped, so detail sorts readably. */
const shipmentId = (now: string) =>
  `SHP-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`

// ── reads ────────────────────────────────────────────────────────────────────

interface StoredDoc {
  json: unknown
  version: unknown
}

async function readShipment(d1: D1Client, id: string): Promise<{ shipment: Shipment; version: number }> {
  const rows = await d1.query<StoredDoc>(
    `SELECT json, version FROM documents WHERE collection = 'shipments' AND id = ?`,
    [id],
  )
  const stored = rows[0]
  if (!stored) throw new DomainError(404, `No shipment ${id}.`, 'shipment_not_found')
  const shipment = parseDoc<Shipment>(stored.json)
  if (!shipment) {
    throw new DomainError(409, `Shipment ${id} cannot be read — it changed. Reload and try again.`, 'cas_version')
  }
  return { shipment, version: Number(stored.version) || 0 }
}

/** The dispatch rows a trip carries, in the shipment's own dispatchIds order. */
async function readDispatches(d1: D1Client, ids: readonly string[]): Promise<Map<string, Dispatch>> {
  if (ids.length === 0) return new Map()
  const marks = ids.map(() => '?').join(', ')
  const rows = await d1.query<{ json: unknown }>(
    `SELECT json FROM documents WHERE collection = 'dispatches' AND id IN (${marks})`,
    [...ids],
  )
  const out = new Map<string, Dispatch>()
  for (const r of rows) {
    const doc = parseDoc<Dispatch>(r.json)
    if (doc) out.set(doc.id, doc)
  }
  return out
}

/** A shipment detail — the trip, its dispatch lines, its challan links. */
async function detailOf(
  d1: D1Client,
  shipment: Shipment,
  version: number,
): Promise<ShipmentDetail> {
  const [dispatches, challanRows] = await Promise.all([
    readDispatches(d1, shipment.dispatchIds),
    d1.query<{ id?: unknown; json: unknown; version: unknown }>(
      `SELECT id, json, version FROM documents WHERE collection = 'challans'`,
    ),
  ])
  const lines: ShipmentLine[] = []
  for (const id of shipment.dispatchIds) {
    const dispatch = dispatches.get(id)
    if (!dispatch) continue // a reversed dispatch the board still shows its trip without
    lines.push({
      dispatchId: dispatch.id,
      sku: dispatch.sku,
      lot: dispatch.batchId,
      qty: dispatch.qty,
      ...(dispatch.expiry ? { expiry: dispatch.expiry } : {}),
      customerId: dispatch.customerId,
      customerName: dispatch.customerName,
      challan: dispatch.challan,
    })
  }
  const challans: ShipmentChallanLink[] = []
  for (const row of challanRows) {
    const doc = parseDoc<{ shipmentId?: string; number?: string; status?: ShipmentChallanLink['status'] }>(row.json)
    if (doc?.shipmentId !== shipment.id) continue
    challans.push({
      id: String(row.id ?? ''),
      number: String(doc.number ?? ''),
      status: doc.status ?? 'Issued',
      version: Number(row.version) || 1,
    })
  }
  challans.sort((a, b) => a.number.localeCompare(b.number))
  return {
    shipment: { ...shipment, version },
    lines,
    challans,
  }
}

/** The agent gate: their own trips, and a foreign trip is absent (404). */
function agentOwnsOr404(caller: Caller, shipment: Shipment): void {
  if (shipment.agentUserId !== caller.email) {
    throw new DomainError(404, `No shipment ${shipment.id}.`, 'shipment_not_found')
  }
}

// ── POST /api/shipments — create ─────────────────────────────────────────────

function validateCreate(body: unknown): CreateShipmentRequest {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  const details: Record<string, string> = {}
  if (!isStr(b.orderId)) details.orderId = 'Which order this trip carries.'
  if (!Array.isArray(b.dispatchIds) || b.dispatchIds.length === 0 || !b.dispatchIds.every(isStr)) {
    details.dispatchIds = 'At least one dispatch from the order.'
  }
  if (!isStr(b.vehicle)) details.vehicle = 'Which vehicle carries it.'
  if (b.eta !== undefined && typeof b.eta !== 'string') details.eta = 'A date-time string, or leave it out.'
  if (b.agentUserId !== undefined && typeof b.agentUserId !== 'string') {
    details.agentUserId = 'A user email, or leave it out.'
  }
  if (b.stops !== undefined) {
    const stopsOk =
      Array.isArray(b.stops) &&
      b.stops.length > 0 &&
      (b.stops as unknown[]).every(
        (s) =>
          s &&
          typeof s === 'object' &&
          isStr((s as Record<string, unknown>).customerId) &&
          Array.isArray((s as Record<string, unknown>).dispatchIds) &&
          ((s as Record<string, unknown>).dispatchIds as unknown[]).every(isStr) &&
          ((s as Record<string, unknown>).dispatchIds as unknown[]).length > 0,
      )
    if (!stopsOk) details.stops = 'Stops are objects: customerId, dispatchIds, address optional.'
  }
  if (Object.keys(details).length > 0) {
    throw new DomainError(422, 'This shipment cannot be created as asked.', 'body_invalid', details)
  }
  return {
    orderId: (b.orderId as string).trim(),
    dispatchIds: (b.dispatchIds as string[]).map((s) => s.trim()),
    vehicle: (b.vehicle as string).trim(),
    ...(b.agentUserId !== undefined ? { agentUserId: (b.agentUserId as string).trim() || undefined } : {}),
    ...(b.eta !== undefined ? { eta: b.eta as string } : {}),
    ...(Array.isArray(b.stops) ? { stops: b.stops as CreateShipmentRequest['stops'] } : {}),
  }
}

/** Stops: the caller's own spelling, or the one-customer default. */
function buildStops(
  req: CreateShipmentRequest,
  dispatches: Map<string, Dispatch>,
  customers: Map<string, Customer>,
): ShipmentStop[] {
  const covered = new Set<string>()
  if (req.stops) {
    const stops: ShipmentStop[] = []
    for (const stop of req.stops) {
      const unknown = stop.dispatchIds.filter((id) => !dispatches.has(id))
      if (unknown.length > 0) {
        throw new DomainError(422, `Dispatch ${unknown[0]} is not on this shipment.`, 'stop_dispatch_foreign')
      }
      for (const id of stop.dispatchIds) {
        if (covered.has(id)) {
          throw new DomainError(422, `Dispatch ${id} is named at two stops.`, 'stop_dispatch_twice')
        }
        covered.add(id)
      }
      const customer = customers.get(stop.customerId)
      stops.push({
        customerId: stop.customerId,
        customerName: customer?.name ?? stop.customerId,
        address: stop.address?.trim() || customer?.shipTo || '',
        dispatchIds: [...stop.dispatchIds],
      })
    }
    const missing = req.dispatchIds.filter((id) => !covered.has(id))
    if (missing.length > 0) {
      throw new DomainError(422, `Dispatch ${missing[0]} is at no stop.`, 'stop_dispatch_missing')
    }
    return stops
  }
  // The default: every dispatch on one customer's stop. Two customers spelled
  // no stops — the multi-stop view is exactly what they must spell out.
  const customerIds = [...new Set(req.dispatchIds.map((id) => dispatches.get(id)?.customerId).filter(isStr))]
  if (customerIds.length !== 1) {
    throw new DomainError(
      422,
      'This trip calls on more than one customer — spell the stops out.',
      'stops_required',
    )
  }
  const customerId = customerIds[0]
  return [
    {
      customerId,
      customerName: customers.get(customerId)?.name ?? customerId,
      address: customers.get(customerId)?.shipTo ?? '',
      dispatchIds: [...req.dispatchIds],
    },
  ]
}

export async function createShipment(
  d1: D1Client,
  caller: Caller,
  body: unknown,
  key: string,
): Promise<{ status: number; body: CreateShipmentResponse; replay?: boolean }> {
  if (!holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'Building a trip is the Shipment Tracking board\'s own.', 'role_allowed')
  }
  const req = validateCreate(body)

  const replayed = await findReceipt(d1, ROUTE, key)
  if (replayed) {
    const verdict = replayOf<CreateShipmentResponse>(replayed, bodyHashOf(key, ROUTE, body))
    return { ...verdict, replay: true }
  }

  const [dispatchRows, shipmentRows, customerRows] = await Promise.all([
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'dispatches'`),
    d1.query<{ id?: unknown; json: unknown }>(
      `SELECT id, json FROM documents WHERE collection = 'shipments'`,
    ),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'customers'`),
  ])
  const dispatches = new Map<string, Dispatch>()
  for (const r of dispatchRows) {
    const doc = parseDoc<Dispatch>(r.json)
    if (doc) dispatches.set(doc.id, doc)
  }
  const customers = new Map<string, Customer>()
  for (const r of customerRows) {
    const doc = parseDoc<Customer>(r.json)
    if (doc) customers.set(doc.id, doc)
  }

  // Every dispatch must belong to the order — the trip is one order's leaving.
  for (const id of [...new Set(req.dispatchIds)]) {
    const dispatch = dispatches.get(id)
    if (!dispatch) throw new DomainError(422, `No dispatch ${id}.`, 'dispatch_not_found')
    if (dispatch.orderId !== req.orderId) {
      throw new DomainError(422, `Dispatch ${id} is not on order ${req.orderId}.`, 'dispatch_not_on_order')
    }
    if (dispatch.status === 'Delivered') {
      throw new DomainError(422, `Dispatch ${id} is already delivered.`, 'dispatch_already_delivered')
    }
  }
  // And none of them may be on a trip that has not landed yet.
  for (const r of shipmentRows) {
    const other = parseDoc<Shipment>(r.json)
    if (!other || !ACTIVE_STATUSES.includes(other.status)) continue
    const clash = other.dispatchIds.find((id) => req.dispatchIds.includes(id))
    if (clash) {
      throw new DomainError(
        409,
        `Dispatch ${clash} is already on shipment ${other.id}, which is ${other.status}.`,
        'shipment_dispatch_busy',
      )
    }
  }

  const now = new Date().toISOString()
  const shipment: Shipment = {
    id: shipmentId(now),
    orderId: req.orderId,
    dispatchIds: [...new Set(req.dispatchIds)],
    ...(req.agentUserId ? { agentUserId: req.agentUserId } : {}),
    vehicle: req.vehicle,
    status: 'Created',
    ...(req.eta ? { eta: req.eta } : {}),
    stops: buildStops(req, dispatches, customers),
    times: { created: now },
    // Classic dispatches carry no per-line packaging decision (dispatch_v2's
    // carton math, deferred); the roll-up reads LOOSE until they do.
    packaging: 'LOOSE',
  }
  const response: CreateShipmentResponse = { shipment: { ...shipment, version: 1 } }

  const writes: Stmt[] = [
    ...upsertDoc('shipments', shipment.id, shipment, 0, now),
    auditStmt({
      id: auditId('shipment.created', shipment.id, now),
      at: now,
      actor: caller.email,
      action: 'shipment.created',
      doc: shipment.id,
      details: JSON.stringify({
        orderId: shipment.orderId,
        dispatchIds: shipment.dispatchIds.length,
        stops: shipment.stops.length,
        agentUserId: shipment.agentUserId ?? null,
        vehicle: shipment.vehicle,
      }),
    }),
    receiptStmt(ROUTE, key, body, 201, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This shipment changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 201, body: response }
}

// ── GET /api/shipments, /api/shipments/:id ───────────────────────────────────

export async function listShipments(d1: D1Client, caller: Caller): Promise<ShipmentListResponse> {
  // An agent's whole view is their own trips (RBAC.md §a) — the slug they hold
  // is not the board's, so the gate reads the agent first, not the page.
  const rows = await d1.query<StoredDoc>(
    `SELECT json, version FROM documents WHERE collection = 'shipments'`,
  )
  const all: { shipment: Shipment; version: number }[] = []
  for (const r of rows) {
    const shipment = parseDoc<Shipment>(r.json)
    if (shipment) all.push({ shipment, version: Number(r.version) || 0 })
  }
  const mine = isDeliveryAgent(caller.permissions)
    ? all.filter((s) => s.shipment.agentUserId === caller.email)
    : all // the board sees every trip
  if (mine.length === 0) return { shipments: [] }
  const details = await Promise.all(mine.map((s) => detailOf(d1, s.shipment, s.version)))
  details.sort((a, b) => b.shipment.times.created.localeCompare(a.shipment.times.created))
  return { shipments: details }
}

export async function getShipment(
  d1: D1Client,
  caller: Caller,
  id: string,
): Promise<ShipmentEventsResponse> {
  const { shipment, version } = await readShipment(d1, id)
  const agent = isDeliveryAgent(caller.permissions)
  if (agent) {
    agentOwnsOr404(caller, shipment)
  } else if (!holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'The board is the Shipment Tracking page\'s own.', 'role_allowed')
  }
  const [detail, eventRows] = await Promise.all([
    detailOf(d1, shipment, version),
    d1.query<{ json: unknown }>(
      `SELECT json FROM documents WHERE collection = 'delivery_events' AND json_extract(json, '$.shipmentId') = ?`,
      [id],
    ),
  ])
  const events: DeliveryEvent[] = []
  for (const r of eventRows) {
    const doc = parseDoc<DeliveryEvent>(r.json)
    if (doc) events.push(doc)
  }
  events.sort((a, b) => a.at.localeCompare(b.at))
  return { ...detail, events }
}

// ── PATCH /api/shipments/:id — the board's word ──────────────────────────────

function validatePatch(body: unknown): PatchShipmentRequest {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  if (!isNum(b.expectedVersion)) {
    throw new DomainError(422, 'Which shipment version you read.', 'body_invalid', {
      expectedVersion: 'The version the GET answered.',
    })
  }
  const details: Record<string, string> = {}
  if (b.agentUserId !== undefined && typeof b.agentUserId !== 'string') details.agentUserId = 'A user email.'
  if (b.vehicle !== undefined && !isStr(b.vehicle)) details.vehicle = 'Which vehicle carries it.'
  if (b.eta !== undefined && typeof b.eta !== 'string') details.eta = 'A date-time string, or leave it out.'
  if (Object.keys(details).length > 0) {
    throw new DomainError(422, 'This shipment cannot be changed as asked.', 'body_invalid', details)
  }
  return {
    expectedVersion: b.expectedVersion as number,
    ...(b.agentUserId !== undefined ? { agentUserId: (b.agentUserId as string).trim() || undefined } : {}),
    ...(b.vehicle !== undefined ? { vehicle: (b.vehicle as string).trim() } : {}),
    ...(b.eta !== undefined ? { eta: b.eta as string } : {}),
    ...(b.status !== undefined ? { status: b.status as ShipmentStatus } : {}),
  }
}

export async function patchShipment(
  d1: D1Client,
  caller: Caller,
  id: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: PatchShipmentResponse; replay?: boolean }> {
  if (isDeliveryAgent(caller.permissions) || !holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'Re-planning a trip is the Shipment Tracking board\'s own.', 'role_allowed')
  }
  const req = validatePatch(body)

  const replayKey = `${PATCH_ROUTE}:${id}`
  const replayed = await findReceipt(d1, replayKey, key)
  if (replayed) {
    const verdict = replayOf<PatchShipmentResponse>(replayed, bodyHashOf(key, replayKey, body))
    return { ...verdict, replay: true }
  }

  const { shipment: before, version: observed } = await readShipment(d1, id)
  if (req.expectedVersion !== observed) {
    throw new DomainError(409, 'This shipment changed after you read it — reload and try again.', 'cas_version')
  }

  let next: Shipment = { ...before }
  const changed: Record<string, unknown> = {}

  if (req.status !== undefined) {
    if (req.status !== before.status) {
      const move = `${before.status}→${req.status}` as (typeof PATCHABLE_MOVES)[number]
      if (!PATCHABLE_MOVES.includes(move)) {
        throw new DomainError(
          422,
          `${before.status} → ${req.status} is not the board's move — the PWA's events and the submit endpoint own the rest of the machine.`,
          'status_not_patchable',
        )
      }
      if (!canTransition('shipment', before.status, req.status)) {
        throw new DomainError(
          422,
          `A shipment cannot move from ${before.status} to ${req.status}.`,
          'illegal_transition',
        )
      }
      next = { ...next, status: req.status }
      if (req.status === 'Dispatched' && !next.times.dispatched) {
        next = { ...next, times: { ...next.times, dispatched: new Date().toISOString() } }
      }
      changed.status = { from: before.status, to: req.status }
    }
  }
  if (req.agentUserId !== undefined && req.agentUserId !== before.agentUserId) {
    next = { ...next, agentUserId: req.agentUserId }
    changed.agentUserId = req.agentUserId
  }
  if (req.vehicle !== undefined && req.vehicle !== before.vehicle) {
    next = { ...next, vehicle: req.vehicle }
    changed.vehicle = req.vehicle
  }
  if (req.eta !== undefined && req.eta !== before.eta) {
    next = { ...next, eta: req.eta }
    changed.eta = req.eta
  }
  if (Object.keys(changed).length === 0) {
    throw new DomainError(422, 'Nothing to change — name an agent, a vehicle, an ETA or a status.', 'body_invalid')
  }
  if (!ACTIVE_STATUSES.includes(next.status)) {
    throw new DomainError(422, `This trip is ${next.status} — it cannot be re-planned.`, 'shipment_terminal')
  }

  const now = new Date().toISOString()
  const response: PatchShipmentResponse = { shipment: { ...next, version: observed + 1 } }
  const writes: Stmt[] = [
    ...upsertDoc('shipments', id, next, observed, now),
    auditStmt({
      id: auditId('shipment.patched', id, now),
      at: now,
      actor: caller.email,
      action: 'shipment.patched',
      doc: id,
      details: JSON.stringify(changed),
    }),
    receiptStmt(replayKey, key, body, 200, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This shipment changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}

// ── POST /api/shipments/:id/events — the PWA's append-only history ───────────

function validateEvent(body: unknown): DeliveryEventRequest {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  if (!isDeliveryEventType(b.type)) {
    throw new DomainError(422, 'Which kind of delivery event this is.', 'body_invalid', {
      type: `One of ${DELIVERY_EVENT_TYPES.join(', ')}.`,
    })
  }
  if (b.at !== undefined && typeof b.at !== 'string') {
    throw new DomainError(422, 'When it happened, as a date-time string.', 'body_invalid', { at: 'ISO string.' })
  }
  return {
    type: b.type,
    ...(b.at !== undefined ? { at: b.at as string } : {}),
    ...(b.gps !== undefined && b.gps && typeof b.gps === 'object' ? { gps: b.gps as { lat: number; lon: number } } : {}),
    ...(b.payload !== undefined && b.payload && typeof b.payload === 'object'
      ? { payload: b.payload as Record<string, unknown> }
      : {}),
  }
}

/** The event's own status side-effect, walked on the shipment doc. */
function applyEvent(
  shipment: Shipment,
  req: DeliveryEventRequest,
  now: string,
): { shipment: Shipment; moved: boolean } {
  let next = shipment
  let moved = false
  const stamp = (patch: Partial<Shipment>) => {
    next = { ...next, ...patch }
    moved = true
  }
  switch (req.type) {
    case 'started': {
      // The board may never have marked the trip dispatched — the agent's
      // start walks both arrows rather than stranding them at Created.
      if (next.status === 'Created') {
        if (!canTransition('shipment', 'Created', 'Dispatched')) break
        stamp({ status: 'Dispatched', times: { ...next.times, dispatched: next.times.dispatched ?? now } })
      }
      // Dispatched is the first trip out; Rescheduled is the second — both
      // start the same way, the machine's own arrow.
      if (next.status !== 'Dispatched' && next.status !== 'Rescheduled') {
        throw new DomainError(
          422,
          `This trip is ${next.status} — it cannot start out for delivery.`,
          'illegal_transition',
        )
      }
      if (!canTransition('shipment', next.status, 'Out for Delivery')) break
      stamp({ status: 'Out for Delivery', times: { ...next.times, outForDelivery: now } })
      break
    }
    case 'failed': {
      if (next.status !== 'Out for Delivery' || !canTransition('shipment', next.status, 'Failed')) {
        throw new DomainError(
          422,
          `This trip is ${next.status} — a delivery can only fail once it is out.`,
          'illegal_transition',
        )
      }
      stamp({ status: 'Failed' })
      break
    }
    case 'rescheduled': {
      if (next.status !== 'Failed' || !canTransition('shipment', next.status, 'Rescheduled')) {
        throw new DomainError(
          422,
          `This trip is ${next.status} — only a failed trip reschedules.`,
          'illegal_transition',
        )
      }
      const eta = typeof req.payload?.eta === 'string' ? req.payload.eta : undefined
      stamp({ status: 'Rescheduled', ...(eta ? { eta } : {}) })
      break
    }
    case 'arrived': {
      // Stamps the stop's arrival — payload.stopIndex, else the first unstamped.
      const rawIndex = req.payload?.stopIndex
      const idx =
        typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < next.stops.length
          ? rawIndex
          : next.stops.findIndex((s) => !s.arrivedAt)
      if (idx < 0) break // every stop already stamped — the event still records
      if (next.stops[idx].arrivedAt) {
        throw new DomainError(422, `Stop ${idx} is already marked arrived.`, 'stop_already_arrived')
      }
      const stops = next.stops.map((s, i) => (i === idx ? { ...s, arrivedAt: now } : s))
      stamp({ stops })
      break
    }
    case 'otp': {
      break // recorded in the events collection alone — the trip doc does not move
    }
    default:
      break // line_confirm and signature record without touching the trip
  }
  return { shipment: next, moved }
}

export async function postDeliveryEvent(
  d1: D1Client,
  caller: Caller,
  id: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: DeliveryEventResponse; replay?: boolean }> {
  const req = validateEvent(body)

  const replayKey = `${EVENTS_ROUTE}:${id}`
  const replayed = await findReceipt(d1, replayKey, key)
  if (replayed) {
    const verdict = replayOf<DeliveryEventResponse>(replayed, bodyHashOf(key, replayKey, body))
    return { ...verdict, replay: true }
  }

  // The PWA posts its own trips; the board may post for any (a dead phone's
  // `failed` or `rescheduled` still has to be recordable).
  const agent = isDeliveryAgent(caller.permissions)
  if (!agent && !holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'Delivery events are the trip\'s own.', 'role_allowed')
  }
  const { shipment: before, version: observed } = await readShipment(d1, id)
  if (agent) agentOwnsOr404(caller, before)

  const now = new Date().toISOString()
  const { shipment: next, moved } = applyEvent(before, req, now)
  const event: DeliveryEvent = {
    id: `DEV-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    shipmentId: id,
    type: req.type,
    at: req.at ?? now,
    ...(req.gps ? { gps: req.gps } : {}),
    ...(req.payload ? { payload: req.payload } : {}),
  }
  const response: DeliveryEventResponse = { event, shipmentStatus: next.status }

  const writes: Stmt[] = [
    insertOnce('delivery_events', event.id, event, now),
    // The trip doc only rewrites when the event moved it — an append-only
    // confirmation leaves the version (and every reader's CAS token) alone.
    ...(moved ? upsertDoc('shipments', id, next, observed, now) : []),
    auditStmt({
      id: auditId(`shipment.event.${req.type}`, id, event.at),
      at: now,
      actor: caller.email,
      action: `shipment.event.${req.type}`,
      doc: id,
      details: JSON.stringify({ eventId: event.id, ...(moved ? { status: next.status } : {}) }),
    }),
    receiptStmt(replayKey, key, body, 201, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This trip just moved under you — reload it and post again.', 'cas_version')
    }
    throw e
  }
  return { status: 201, body: response }
}
