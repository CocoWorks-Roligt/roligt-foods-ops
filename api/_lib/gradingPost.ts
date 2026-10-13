/**
 * POST /api/grading — the staged grading endpoint (contracts §5, §3.1). Under
 * the `pipeline` flag a coconut lot is received ungraded and sorted later:
 * this endpoint is where the grades land. The GRN carries the grades and their
 * costs (priceGrn, the same arithmetic the receipt form runs), and the ledger
 * tells the truth per grade — the whole load leaves the bucket it was received
 * in, accepted lands as Available, rejected as Rejected, in the paired-line
 * shape QC Status Transfer already uses (same row key either side, so no
 * phantom rows and no negative balances).
 *
 * Flag OFF → 421 (staged mode arrives with the pipeline; the plant's receipts
 * keep grading at the gate). Non-coconut (an item that does not require
 * grading, or a load not counted by the piece) → 422: grading a beetroot lot
 * is not a thing, and the receipt already booked it whole.
 */
import type { D1Client } from './d1.js'
import type { Caller } from './auth.js'
import { flagsOfDocs } from './rulesGate.js'
import {
  DomainError,
  auditId,
  auditStmt,
  gradeMath,
  insertOnce,
  isCasTrip,
  isGradedUnit,
  holdsPage,
  parseDoc,
  upsertDoc,
  writeBatch,
  type Stmt,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import { QTY_EPSILON } from '../../src/lib/utils.js'
import type { GrnExtension, StagedGradingRequest, StagedGradingResponse } from '../../src/lib/contracts.js'
import type { Grn } from '../../src/types.js'

export const ROUTE = 'POST /api/grading'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The whole staged-grading write: GRN + ledger + audit + receipt, ONE batch. */
export async function stagedGrading(
  d1: D1Client,
  caller: Caller,
  body: unknown,
  key: string,
): Promise<{ status: number; body: StagedGradingResponse; replay?: boolean }> {
  if (!holdsPage(caller.permissions, 'page.procurement')) {
    throw new DomainError(403, 'Staged grading is the Procurement page\'s own.', 'role_allowed')
  }
  const req = validate(body)

  const replayed = await findReceipt(d1, ROUTE, key)
  if (replayed) {
    const verdict = replayOf<StagedGradingResponse>(replayed, bodyHashOf(key, ROUTE, body))
    return { ...verdict, replay: true }
  }

  const now = new Date().toISOString()
  const [grnRows, flagsRows] = await Promise.all([
    d1.query<{ json: unknown; version: unknown }>(
      `SELECT json, version FROM documents WHERE collection = 'grns' AND id = ?`,
      [req.grnId],
    ),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'flags'`),
  ])

  const flags = flagsOfDocs(flagsRows.map((r) => String(r.json ?? '')))
  if (!flags.pipeline) {
    throw new DomainError(421, 'Staged grading is not enabled on this plant yet.', 'pipeline_off')
  }

  const stored = grnRows[0]
  if (!stored) throw new DomainError(404, `No receipt ${req.grnId}.`, 'grn_not_found')
  const observed = Number(stored.version) || 0
  if (req.expectedVersion !== observed) {
    throw new DomainError(409, 'This receipt changed after you read it — reload and try again.', 'cas_version')
  }
  const grn = parseDoc<Grn & GrnExtension>(stored.json)
  if (!grn) throw new DomainError(409, 'This receipt cannot be read — it changed. Reload and try again.', 'cas_version')
  if (grn.gradingMode !== 'staged') {
    throw new DomainError(422, `${grn.id} was graded at the gate — its grades are already in.`, 'not_staged')
  }
  if ((grn.a || 0) + (grn.b || 0) + (grn.c || 0) + (grn.reject || 0) > QTY_EPSILON) {
    throw new DomainError(422, `${grn.id} was already graded — its grades are already in.`, 'already_graded')
  }

  // coconuts only: the single graded intake (§3.1) — a piece-counted raw
  // material whose master says it requires grading
  if (!isGradedUnit(grn.uom)) {
    throw new DomainError(422, `${grn.lot} is counted by ${grn.uom} — it grades at the gate, not later.`, 'not_gradable')
  }
  const itemRows = grn.itemId
    ? await d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'items' AND id = ?`, [grn.itemId])
    : []
  const item = itemRows.length ? parseDoc<{ requiresGrading?: unknown }>(itemRows[0].json) : null
  if (!item?.requiresGrading) {
    throw new DomainError(422, `${grn.lot} is not a graded lot — only coconut lots are staged for grading.`, 'not_gradable')
  }

  // the grades must sort exactly the load the gate counted
  const graded = req.a + req.b + req.c + req.reject
  if (Math.abs(graded - grn.total) > QTY_EPSILON) {
    throw new DomainError(422, `Grade mismatch: grade total is ${graded}, but received is ${grn.total}.`, 'grade_mismatch')
  }

  // the same cost arithmetic the receipt form runs — never the client's numbers
  const free = req.free ?? grn.free ?? 0
  if (req.a + req.b + req.c <= QTY_EPSILON) {
    throw new DomainError(422, 'Accepted quantity must be greater than zero.', 'invalid_grades')
  }
  if (free > grn.total + QTY_EPSILON) {
    throw new DomainError(422, `Free quantity must be between 0 and the ${grn.total} received.`, 'invalid_grades')
  }
  if (!(grn.rate > 0)) {
    throw new DomainError(422, `Enter the agreed rate per ${grn.uom ?? 'Piece'}.`, 'invalid_grades')
  }
  const math = gradeMath({
    total: grn.total,
    free,
    a: req.a,
    b: req.b,
    c: req.c,
    rate: grn.rate,
    transport: grn.transport,
  })

  const gradedGrn: Grn & GrnExtension = {
    ...grn,
    a: req.a,
    b: req.b,
    c: req.c,
    reject: req.reject,
    free,
    accepted: math.accepted,
    materialValue: math.material,
    landed: math.landed,
    grossCost: math.grossCost,
    usableCost: math.usableCost,
    // gradingMode stays 'staged' (contracts GRADING_MODES): the mode names how
    // the grades ARRIVED, and the grades-on-document is the graded state
    gradingMode: 'staged',
  }
  const response: StagedGradingResponse = { grnId: grn.id, lot: grn.lot, accepted: math.accepted }

  // the receipt's own stock row — grading moves the load out of the bucket it
  // was received in, into Available and Rejected per grade, in the paired-line
  // shape QC Status Transfer already uses (same row key either side)
  const receiptRow = await d1.query<{ id: unknown; json: unknown; version: unknown }>(
    `SELECT id, json, version FROM documents WHERE collection = 'ledger' AND json_extract(json, '$.doc') = ? AND json_extract(json, '$.type') = 'Receipt'`,
    [grn.id],
  )
  const writes: Stmt[] = []
  const receipt = receiptRow[0] ? parseDoc<Record<string, unknown>>(receiptRow[0].json) : null
  if (receipt) {
    const line = (status: string, qtyIn: number, qtyOut: number) => {
      const id = `LED:GRD:${grn.id}:${status}:${qtyIn > 0 ? 'in' : 'out'}`
      return insertOnce(
        'ledger',
        id,
        {
          id,
          type: 'Grading',
          doc: grn.id,
          item: String(receipt.item ?? ''),
          item_type: String(receipt.item_type ?? 'Raw Material'),
          lot: String(receipt.lot ?? grn.lot),
          location: String(receipt.location ?? ''),
          status,
          qty_in: qtyIn,
          qty_out: qtyOut,
          uom: String(receipt.uom ?? grn.uom ?? 'Piece'),
          unit_cost: Number(receipt.unit_cost) || 0,
          at: now,
          expiry: null,
          vendor_id: null,
        },
        now,
      )
    }
    const bucket = String(receipt.status ?? 'Quarantine')
    const held = Number(receipt.qty_in) || 0
    if (held + QTY_EPSILON >= grn.total) {
      // whole-load booking: the load leaves its bucket, sorted by grade
      if (bucket === 'Available') {
        if (req.reject > 0) {
          writes.push(line('Available', 0, req.reject))
          writes.push(line('Rejected', req.reject, 0))
        }
      } else {
        writes.push(line(bucket, 0, grn.total))
        if (math.accepted > 0) writes.push(line('Available', math.accepted, 0))
        if (req.reject > 0) writes.push(line('Rejected', req.reject, 0))
      }
    } else {
      // netted booking (reject never entered stock): only a reject over what
      // the row still holds would overdraw it
      const net = held - (Number(receipt.qty_out) || 0)
      if (req.reject > net + QTY_EPSILON) {
        throw new DomainError(422, `Lot ${grn.lot} holds less than the ${req.reject} rejected.`, 'grade_overdraws')
      }
      if (req.reject > 0) {
        writes.push(line(bucket, 0, req.reject))
        writes.push(line('Rejected', req.reject, 0))
      }
    }
  }

  writes.unshift(
    ...upsertDoc('grns', grn.id, gradedGrn, observed, now),
    auditStmt({
      id: auditId('grading.staged', grn.id, now),
      at: now,
      actor: caller.email,
      action: 'grading.staged',
      doc: grn.id,
      details: JSON.stringify({ lot: grn.lot, a: req.a, b: req.b, c: req.c, reject: req.reject, accepted: math.accepted }),
    }),
    receiptStmt(ROUTE, key, body, 200, response, now),
    sweepStmt(now),
  )

  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This receipt changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}

function validate(body: unknown): StagedGradingRequest & { grnId: string } {
  const doc = (body ?? {}) as Record<string, unknown>
  const details: Record<string, string> = {}
  if (typeof doc.grnId !== 'string' || !doc.grnId.trim()) details.grnId = 'Which receipt is being graded?'
  if (!isNum(doc.expectedVersion) || doc.expectedVersion < 0) details.expectedVersion = 'The receipt version you read is required.'
  for (const k of ['a', 'b', 'c', 'reject'] as const) {
    if (!isNum(doc[k]) || doc[k] < 0) details[k] = 'Grade quantities must be zero or more.'
  }
  if (doc.free !== undefined && (!isNum(doc.free) || doc.free < 0)) details.free = 'Free quantity must be zero or more.'
  if (Object.keys(details).length) throw new DomainError(422, 'The grading request is not valid.', 'invalid_grades', details)
  return doc as unknown as StagedGradingRequest & { grnId: string }
}
