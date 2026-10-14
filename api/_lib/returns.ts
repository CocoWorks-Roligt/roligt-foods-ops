/**
 * /api/returns — returns recorded at (or after) the door, and QC's decision
 * on them (SHIPMENT B5c, contracts v1.9).
 *
 * - POST records one: the agent whose trip it was, or the board, or the
 *   dispatch desk (a return phoned in). The submit endpoint opens returns for
 *   rejections at the door; this one covers everything after — the customer
 *   who calls the next day. One record per call, Open until QC decides.
 * - POST :id/decision is QC's verdict (the Quality page's own): coldroom puts
 *   the stock back Released in a cold room, quarantine holds it, writeoff
 *   records the terminal balance. One ledger line per return line (type
 *   'Return', qtyIn — the deduction happened at dispatch, never at delivery),
 *   walking the return machine's two arrows in one honest write.
 *
 * The landing locations are the Storage page's own masters — the first active
 * cold room / hold area by ledger name — so a plant without one refuses
 * (configure it) rather than posting to a place that does not exist.
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
  ledgerStmt,
  parseDoc,
  upsertDoc,
  writeBatch,
  isCasTrip,
  type Stmt,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import type {
  CreateReturnRequest,
  CreateReturnResponse,
  ReturnDecisionRequest,
  ReturnDecisionResponse,
  ReturnLine,
  ReturnQcDecision,
  ReturnRecord,
  Shipment,
} from '../../src/lib/contracts.js'
import type { Dispatch, StorageLocation } from '../../src/types.js'

export const ROUTE = 'POST /api/returns'
export const DECISION_ROUTE = 'POST /api/returns/:id/decision'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** The return statuses that can still move — everything but Closed. */
const OPEN_STATUSES: readonly ReturnRecord['status'][] = ['Open', 'QcDecision']

// ── POST /api/returns — record ───────────────────────────────────────────────

function validateCreate(body: unknown): CreateReturnRequest {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  const details: Record<string, string> = {}
  if (!isStr(b.shipmentId)) details.shipmentId = 'Which trip it came back on.'
  if (
    !Array.isArray(b.lines) ||
    b.lines.length === 0 ||
    !(b.lines as unknown[]).every((l) => {
      if (!l || typeof l !== 'object') return false
      const line = l as Record<string, unknown>
      return isStr(line.item) && isStr(line.lot) && isNum(line.qty) && line.qty > 0 && isStr(line.uom) && isStr(line.reason)
    })
  ) {
    details.lines = 'Rows of item, lot, qty (over zero), uom and reason.'
  }
  if (Object.keys(details).length > 0) {
    throw new DomainError(422, 'This return cannot be recorded as asked.', 'body_invalid', details)
  }
  return {
    shipmentId: (b.shipmentId as string).trim(),
    lines: b.lines as CreateReturnRequest['lines'],
  }
}

export async function createReturn(
  d1: D1Client,
  caller: Caller,
  body: unknown,
  key: string,
): Promise<{ status: number; body: CreateReturnResponse; replay?: boolean }> {
  const agent = isDeliveryAgent(caller.permissions)
  if (!agent && !holdsPage(caller.permissions, 'page.shipments') && !holdsPage(caller.permissions, 'page.dispatch')) {
    throw new DomainError(403, 'Recording a return is the trip\'s own — or the dispatch desk\'s.', 'role_allowed')
  }
  const req = validateCreate(body)

  const replayed = await findReceipt(d1, ROUTE, key)
  if (replayed) {
    const verdict = replayOf<CreateReturnResponse>(replayed, bodyHashOf(key, ROUTE, body))
    return { ...verdict, replay: true }
  }

  const shipmentRows = await d1.query<{ json: unknown }>(
    `SELECT json FROM documents WHERE collection = 'shipments' AND id = ?`,
    [req.shipmentId],
  )
  const shipment = parseDoc<Shipment>(shipmentRows[0]?.json ?? null)
  if (!shipment) {
    throw new DomainError(404, `No shipment ${req.shipmentId}.`, 'shipment_not_found')
  }
  if (agent && shipment.agentUserId !== caller.email) {
    // Never 403 — an external user must not learn that another shipment id exists.
    throw new DomainError(404, `No shipment ${req.shipmentId}.`, 'shipment_not_found')
  }
  if (shipment.status === 'Created' || shipment.status === 'Dispatched') {
    throw new DomainError(422, `This trip is ${shipment.status} — the goods have not reached the door.`, 'trip_not_out')
  }

  // Every line must name something the trip actually carried.
  const dispatchRows = await d1.query<{ json: unknown }>(
    `SELECT json FROM documents WHERE collection = 'dispatches' AND json_extract(json, '$.orderId') = ?`,
    [shipment.orderId],
  )
  const carried = new Set<string>()
  for (const r of dispatchRows) {
    const doc = parseDoc<Dispatch>(r.json)
    if (doc && shipment.dispatchIds.includes(doc.id)) carried.add(`${doc.sku}|${doc.batchId}`)
  }
  for (const line of req.lines) {
    if (!carried.has(`${line.item}|${line.lot}`)) {
      throw new DomainError(422, `${line.item} from lot ${line.lot} was not on this trip.`, 'line_not_on_trip')
    }
  }

  const now = new Date().toISOString()
  const record: ReturnRecord = {
    id: `RET-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    shipmentId: shipment.id,
    status: 'Open',
    lines: req.lines.map((l) => ({
      item: l.item,
      lot: l.lot,
      qty: l.qty,
      uom: l.uom,
      reason: l.reason,
      ...(isStr(l.photoKey) ? { photoKey: l.photoKey } : {}),
    })),
  }
  const response: CreateReturnResponse = { record }

  const writes: Stmt[] = [
    insertOnce('returns', record.id, record, now),
    auditStmt({
      id: auditId('return.recorded', record.id, now),
      at: now,
      actor: caller.email,
      action: 'return.recorded',
      doc: record.id,
      details: JSON.stringify({ shipmentId: shipment.id, lines: record.lines.length, qty: record.lines.reduce((n, l) => n + l.qty, 0) }),
    }),
    receiptStmt(ROUTE, key, body, 201, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This return changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 201, body: response }
}

// ── POST /api/returns/:id/decision — QC's verdict ────────────────────────────

function validateDecision(body: unknown): ReturnDecisionRequest {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  const decisions: readonly string[] = ['coldroom', 'quarantine', 'writeoff']
  if (!decisions.includes(String(b.decision))) {
    throw new DomainError(422, 'What QC decided happens to the stock.', 'body_invalid', {
      decision: 'One of coldroom, quarantine, writeoff.',
    })
  }
  if (b.note !== undefined && typeof b.note !== 'string') {
    throw new DomainError(422, 'A note is a line of words, or nothing.', 'body_invalid', { note: 'Optional.' })
  }
  return { decision: b.decision as ReturnQcDecision, ...(typeof b.note === 'string' ? { note: b.note } : {}) }
}

/** The ledger name of the first active location of a type — the Storage page's own master. */
async function locationOfType(d1: D1Client, type: StorageLocation['type']): Promise<string> {
  const rows = await d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'storage_locations'`)
  for (const r of rows) {
    const doc = parseDoc<StorageLocation>(r.json)
    if (doc && doc.type === type && doc.status !== 'Inactive') return doc.name
  }
  return ''
}

export async function decideReturn(
  d1: D1Client,
  caller: Caller,
  id: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: ReturnDecisionResponse; replay?: boolean }> {
  if (!holdsPage(caller.permissions, 'page.quality')) {
    throw new DomainError(403, 'Deciding a return is the Quality page\'s own.', 'role_allowed')
  }
  const req = validateDecision(body)

  const replayKey = `${DECISION_ROUTE}:${id}`
  const replayed = await findReceipt(d1, replayKey, key)
  if (replayed) {
    const verdict = replayOf<ReturnDecisionResponse>(replayed, bodyHashOf(key, replayKey, body))
    return { ...verdict, replay: true }
  }

  const rows = await d1.query<{ json: unknown; version: unknown }>(
    `SELECT json, version FROM documents WHERE collection = 'returns' AND id = ?`,
    [id],
  )
  const stored = rows[0]
  if (!stored) throw new DomainError(404, `No return ${id}.`, 'return_not_found')
  const observed = Number(stored.version) || 0
  const record = parseDoc<ReturnRecord>(stored.json)
  if (!record) throw new DomainError(409, `Return ${id} cannot be read — it changed. Reload and try again.`, 'cas_version')
  if (!OPEN_STATUSES.includes(record.status)) {
    throw new DomainError(409, `This return is ${record.status} — its decision stands.`, 'return_closed')
  }

  // Where the stock lands — the Storage page's masters, never a hardcoded place.
  const needsColdRoom = req.decision === 'coldroom'
  const location = needsColdRoom ? await locationOfType(d1, 'Cold Room') : await locationOfType(d1, 'Hold Area')
  if (!location) {
    throw new DomainError(
      422,
      needsColdRoom
        ? 'No active cold room exists — create one on the Storage page first.'
        : 'No active hold area exists — create one on the Storage page first.',
      'location_missing',
    )
  }
  const status = needsColdRoom ? 'Released' : req.decision === 'quarantine' ? 'Quarantine' : 'Written Off'

  // The trip's dispatch ledger lines carry the cost/identity truth — copy it.
  const shipmentRows = await d1.query<{ json: unknown }>(
    `SELECT json FROM documents WHERE collection = 'shipments' AND id = ?`,
    [record.shipmentId],
  )
  const shipment = parseDoc<Shipment>(shipmentRows[0]?.json ?? null)
  const dispatchLedger = shipment
    ? await d1.query<{ json: unknown }>(
        `SELECT json FROM documents WHERE collection = 'ledger' AND json_extract(json, '$.type') = 'Dispatch' AND json_extract(json, '$.doc') IN (${shipment.dispatchIds.map(() => '?').join(',') || "''"})`,
        shipment.dispatchIds,
      )
    : []
  // The stored rows are the flat wire shape (ledgerToRow): unit_cost, expiry|null.
  const truth = new Map<string, { unitCost: number; expiry?: string }>()
  for (const r of dispatchLedger) {
    const line = parseDoc<{ item?: string; lot?: string; unit_cost?: number; expiry?: string | null }>(r.json)
    if (line?.item && line.lot) {
      truth.set(`${line.item}|${line.lot}`, {
        unitCost: Number(line.unit_cost) || 0,
        ...(line.expiry ? { expiry: line.expiry } : {}),
      })
    }
  }

  const now = new Date().toISOString()
  const decided: ReturnRecord = {
    ...record,
    status: 'Closed',
    qcDecision: req.decision,
    decidedBy: caller.email,
    ledgerRef: record.id,
  }
  const response: ReturnDecisionResponse = { record: decided }

  const writes: Stmt[] = [
    ...upsertDoc('returns', id, decided, observed, now),
    // One line per return line — qtyIn: the deduction happened at dispatch.
    ...record.lines.map((line: ReturnLine) =>
      ledgerStmt(
        {
          type: 'Return',
          doc: record.id,
          item: line.item,
          itemType: 'Finished Goods',
          lot: line.lot,
          location,
          status,
          qtyIn: line.qty,
          qtyOut: 0,
          uom: line.uom,
          unitCost: truth.get(`${line.item}|${line.lot}`)?.unitCost ?? 0,
          time: now,
          ...(truth.get(`${line.item}|${line.lot}`)?.expiry ? { expiry: truth.get(`${line.item}|${line.lot}`)?.expiry } : {}),
        },
        now,
      ),
    ),
    auditStmt({
      id: auditId('return.decided', id, now),
      at: now,
      actor: caller.email,
      action: 'return.decided',
      doc: id,
      details: JSON.stringify({ decision: req.decision, status, location, lines: record.lines.length, ...(req.note ? { note: req.note } : {}) }),
    }),
    receiptStmt(replayKey, key, body, 200, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This return changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}
