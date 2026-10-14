/**
 * POST /api/shipments/:id/submit — the delivery's outcome (SHIPMENT B5b,
 * contracts v1.9). One idempotent, atomic write that closes the loop:
 *
 * - the shipment lands in one of the machine's four outcomes (Delivered,
 *   Partially Delivered, Returned — Failed is the PWA's event, not a submit),
 *   stamps the signature and the clock, and completes every stop;
 * - the member dispatch rows are stamped the same truth Classic's own delivery
 *   modal would write (status, pod, deliveredTime kept-not-restamped), so the
 *   mirror the board reads never disagrees with the trip;
 * - the challan is MINTED: the DC number the Classic dispatch already shared
 *   across its rows is adopted when exactly one exists and no challan holds it
 *   yet, and a fresh DC is minted otherwise — the counter never rewinds;
 * - rejected quantities open ONE Return record for the trip, Open until QC
 *   decides (the decision's ledger lines are B5c's, not this write);
 * - a `signature` delivery event records the submit in the trip's history.
 *
 * The PDF is rendered and uploaded lazily (api/_lib/challans.ts) — the key is
 * honest from the moment the challan exists, and a render that fails costs a
 * retry, never the delivery.
 */
import type { D1Client } from './d1.js'
import type { Caller } from './auth.js'
import {
  DomainError,
  appConfigOf,
  auditId,
  auditStmt,
  counterStmt,
  formatSeries,
  holdsPage,
  insertOnce,
  isDeliveryAgent,
  parseDoc,
  readMeta,
  upsertDoc,
  writeBatch,
  isCasTrip,
  type Stmt,
  type StoredNumbering,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import type {
  Challan,
  ChallanLine,
  ChallanTaxFields,
  DeliveryLineConfirmation,
  ReturnRecord,
  Shipment,
  SubmitDeliveryResponse,
} from '../../src/lib/contracts.js'
import type { Dispatch, Item } from '../../src/types.js'

export const SUBMIT_ROUTE = 'POST /api/shipments/:id/submit'

const EPS = 1e-9
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** The statuses a submit can walk to its outcome from. */
const SUBMITTABLE: readonly Shipment['status'][] = ['Dispatched', 'Rescheduled', 'Out for Delivery']

// ── validation ───────────────────────────────────────────────────────────────

interface ParsedSubmit {
  lines: (DeliveryLineConfirmation & { dispatchId: string })[]
  signature: { signatureKey: string; printedName: string; phone: string; otp?: string }
}

function validateSubmit(body: unknown): ParsedSubmit {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  const sig = b.signature as Record<string, unknown> | undefined
  if (!sig || typeof sig !== 'object') {
    throw new DomainError(422, 'The customer\'s signature.', 'body_invalid', { signature: 'signatureKey, printedName, phone.' })
  }
  const sigDetails: Record<string, string> = {}
  if (!isStr(sig.signatureKey)) sigDetails.signatureKey = 'The stored signature image\'s key.'
  if (!isStr(sig.printedName)) sigDetails.printedName = 'Who signed.'
  if (!isStr(sig.phone)) sigDetails.phone = 'The number to reach them on.'
  if (sig.otp !== undefined && typeof sig.otp !== 'string') sigDetails.otp = 'The code they read out, or leave it out.'
  if (Object.keys(sigDetails).length > 0) {
    throw new DomainError(422, 'The signature is incomplete.', 'body_invalid', sigDetails)
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    throw new DomainError(422, 'Every line\'s outcome at the door.', 'body_invalid', {
      lines: 'One confirmation per dispatch on the trip.',
    })
  }
  const lineDetails: Record<string, string> = {}
  const lines: ParsedSubmit['lines'] = []
  ;(b.lines as unknown[]).forEach((raw, i) => {
    const l = raw as Record<string, unknown>
    const where = `lines.${i}`
    if (!l || typeof l !== 'object') {
      lineDetails[where] = 'One line\'s outcome.'
      return
    }
    if (!isStr(l.dispatchId)) lineDetails[where] = 'Which dispatch this line settles.'
    if (!isStr(l.sku)) lineDetails[`${where}.sku`] = 'Which item.'
    if (!isStr(l.lot)) lineDetails[`${where}.lot`] = 'Which lot.'
    if (!isNum(l.qtyDelivered) || l.qtyDelivered < 0) lineDetails[`${where}.qtyDelivered`] = 'How many were left.'
    if (!isNum(l.qtyRejected) || l.qtyRejected < 0) lineDetails[`${where}.qtyRejected`] = 'How many came back.'
    if (l.reason !== undefined && typeof l.reason !== 'string') lineDetails[`${where}.reason`] = 'Why, if anything came back.'
    lines.push({
      dispatchId: l.dispatchId as string,
      sku: l.sku as string,
      lot: l.lot as string,
      qtyDelivered: l.qtyDelivered as number,
      qtyRejected: l.qtyRejected as number,
      ...(typeof l.reason === 'string' ? { reason: l.reason } : {}),
      ...(isStr(l.photoKey) ? { photoKey: l.photoKey } : {}),
    })
  })
  if (Object.keys(lineDetails).length > 0) {
    throw new DomainError(422, 'These lines cannot be settled as asked.', 'body_invalid', lineDetails)
  }
  return {
    lines,
    signature: {
      signatureKey: (sig.signatureKey as string).trim(),
      printedName: (sig.printedName as string).trim(),
      phone: (sig.phone as string).trim(),
      ...(typeof sig.otp === 'string' ? { otp: sig.otp } : {}),
    },
  }
}

// ── the submit ───────────────────────────────────────────────────────────────

export async function submitShipment(
  d1: D1Client,
  caller: Caller,
  id: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: SubmitDeliveryResponse; replay?: boolean }> {
  const agent = isDeliveryAgent(caller.permissions)
  if (!agent && !holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'Submitting a delivery is the trip\'s own.', 'role_allowed')
  }
  const req = validateSubmit(body)

  const replayKey = `${SUBMIT_ROUTE}:${id}`
  const replayed = await findReceipt(d1, replayKey, key)
  if (replayed) {
    const verdict = replayOf<SubmitDeliveryResponse>(replayed, bodyHashOf(key, replayKey, body))
    return { ...verdict, replay: true }
  }

  // The trip, its dispatch rows (with versions), the items master, the config.
  const shipmentRows = await d1.query<{ json: unknown; version: unknown }>(
    `SELECT json, version FROM documents WHERE collection = 'shipments' AND id = ?`,
    [id],
  )
  const stored = shipmentRows[0]
  if (!stored) throw new DomainError(404, `No shipment ${id}.`, 'shipment_not_found')
  const shipment = parseDoc<Shipment>(stored.json)
  if (!shipment) throw new DomainError(409, `Shipment ${id} cannot be read — it changed. Reload and try again.`, 'cas_version')
  if (agent && shipment.agentUserId !== caller.email) {
    // Never 403 — an external user must not learn that another shipment id exists.
    throw new DomainError(404, `No shipment ${id}.`, 'shipment_not_found')
  }
  const observed = Number(stored.version) || 0

  const dispatchRows = await d1.query<{ json: unknown; version: unknown }>(
    `SELECT json, version FROM documents WHERE collection = 'dispatches'`,
  )
  const dispatches = new Map<string, { dispatch: Dispatch; version: number }>()
  for (const r of dispatchRows) {
    const doc = parseDoc<Dispatch>(r.json)
    if (doc) dispatches.set(doc.id, { dispatch: doc, version: Number(r.version) || 0 })
  }
  const itemRows = await d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'items'`)
  const items = new Map<string, Item>()
  for (const r of itemRows) {
    const doc = parseDoc<Item>(r.json)
    if (doc) items.set(doc.id, doc)
  }

  // Every dispatch settled exactly once, and the line says what the dispatch says.
  const byDispatch = new Map(req.lines.map((l) => [l.dispatchId, l]))
  const missing = shipment.dispatchIds.filter((did) => !byDispatch.has(did))
  if (missing.length > 0) {
    throw new DomainError(422, `Dispatch ${missing[0]} has no line settling it.`, 'line_dispatch_missing')
  }
  const foreign = [...byDispatch.keys()].filter((did) => !shipment.dispatchIds.includes(did))
  if (foreign.length > 0) {
    throw new DomainError(422, `Dispatch ${foreign[0]} is not on this shipment.`, 'line_dispatch_foreign')
  }
  for (const l of req.lines) {
    const dispatch = dispatches.get(l.dispatchId)?.dispatch
    if (!dispatch) throw new DomainError(422, `No dispatch ${l.dispatchId}.`, 'dispatch_not_found')
    if (dispatch.sku !== l.sku || dispatch.batchId !== l.lot) {
      throw new DomainError(
        422,
        `Line ${l.dispatchId} says ${l.sku}/${l.lot} — the dispatch says ${dispatch.sku}/${dispatch.batchId}.`,
        'line_dispatch_mismatch',
      )
    }
    if (Math.abs(l.qtyDelivered + l.qtyRejected - dispatch.qty) > EPS) {
      throw new DomainError(
        422,
        `Line ${l.dispatchId} settles ${l.qtyDelivered + l.qtyRejected} of ${dispatch.qty} — delivered and rejected must cover the dispatch.`,
        'line_qty_mismatch',
      )
    }
  }

  if (shipment.signature) {
    throw new DomainError(409, 'This delivery is already submitted — its challan stands.', 'already_submitted')
  }
  if (!SUBMITTABLE.includes(shipment.status)) {
    throw new DomainError(
      422,
      shipment.status === 'Created'
        ? 'This trip has not been marked out — dispatch it first.'
        : `This trip is ${shipment.status} and cannot be submitted.`,
      'trip_not_out',
    )
  }

  // The outcome, off the numbers themselves.
  const totalDelivered = req.lines.reduce((sum, l) => sum + l.qtyDelivered, 0)
  const totalRejected = req.lines.reduce((sum, l) => sum + l.qtyRejected, 0)
  const outcome: Shipment['status'] =
    totalRejected <= EPS ? 'Delivered' : totalDelivered <= EPS ? 'Returned' : 'Partially Delivered'

  const now = new Date().toISOString()
  const otpVerified = req.signature.otp !== undefined ? true : undefined
  const next: Shipment = {
    ...shipment,
    status: outcome,
    times: {
      ...shipment.times,
      ...(shipment.status !== 'Out for Delivery' ? { outForDelivery: shipment.times.outForDelivery ?? now } : {}),
      delivered: now,
    },
    stops: shipment.stops.map((s) => ({ ...s, completedAt: s.completedAt ?? now })),
    signature: {
      signatureKey: req.signature.signatureKey,
      printedName: req.signature.printedName,
      phone: req.signature.phone,
      ...(otpVerified !== undefined ? { otpVerified } : {}),
    },
  }

  // ── the challan ────────────────────────────────────────────────────────────
  // The DC number the Classic dispatch already minted and shared across its
  // rows is adopted when exactly one exists and no challan holds it yet (two
  // trips off one dispatch wave would otherwise collide); otherwise a fresh DC
  // is minted — the counter only ever moves forward.
  const meta = await readMeta(d1)
  const memberNumbers = [
    ...new Set(shipment.dispatchIds.map((did) => dispatches.get(did)?.dispatch.challan ?? '')),
  ].filter(Boolean)
  const challanRows = await d1.query<{ id?: unknown }>(`SELECT id FROM documents WHERE collection = 'challans'`)
  const taken = new Set(challanRows.map((r) => String(r.id ?? '')))
  const adoptable = memberNumbers.length === 1 && !taken.has(memberNumbers[0]) ? memberNumbers[0] : ''
  let number = adoptable
  let minted = false
  let mintedNext = 0
  if (!number) {
    // The 'challan' numbering series (prefix DC) — the same forward-only belt
    // the client's dispatchOrder pre-mints from, so one sequence serves both.
    const counterRows = await d1.query<{ next?: unknown }>(`SELECT next FROM counters WHERE series = 'challan'`)
    mintedNext = (Number(counterRows[0]?.next) || 0) + 1
    const numbering = Array.isArray(appConfigOf(meta)?.numbering)
      ? ((appConfigOf(meta)!.numbering as unknown) as StoredNumbering[])
      : undefined
    number = formatSeries(numbering, 'challan', mintedNext, new Date(now))
    if (taken.has(number)) {
      throw new DomainError(409, `Challan number ${number} already exists — the DC counter is behind.`, 'challan_number_taken')
    }
    minted = true
  }

  const taxRaw = appConfigOf(meta)?.challanTax
  const taxFields: ChallanTaxFields =
    taxRaw && typeof taxRaw === 'object' ? (taxRaw as ChallanTaxFields) : {}

  const challanLines: ChallanLine[] = req.lines.map((l) => {
    const item = items.get(l.sku)
    return {
      sku: l.sku,
      skuName: item?.name ?? l.sku,
      lot: l.lot,
      qty: l.qtyDelivered,
      uom: item?.uom ?? 'Pack',
      ...(dispatches.get(l.dispatchId)?.dispatch.expiry ? { expiry: dispatches.get(l.dispatchId)!.dispatch.expiry } : {}),
      packaging: 'LOOSE',
    }
  })
  const challan: Challan = {
    id: number,
    number,
    shipmentId: shipment.id,
    orderId: shipment.orderId,
    status: 'Issued',
    version: 1,
    pdfKey: `challans/${number}.pdf`,
    taxFields,
    lines: challanLines,
    agentId: shipment.agentUserId ?? '',
    vehicle: shipment.vehicle,
    deliveredAt: now,
  }

  // ── the return, one record for the trip ────────────────────────────────────
  const rejected = req.lines.filter((l) => l.qtyRejected > EPS)
  const returnRecord: ReturnRecord | null =
    rejected.length > 0
      ? {
          id: `RET-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
          shipmentId: shipment.id,
          status: 'Open',
          lines: rejected.map((l) => ({
            item: l.sku,
            lot: l.lot,
            qty: l.qtyRejected,
            uom: items.get(l.sku)?.uom ?? 'Pack',
            reason: l.reason ?? 'Rejected at the door',
            ...(l.photoKey ? { photoKey: l.photoKey } : {}),
          })),
        }
      : null

  // ── the dispatch stamps — Classic's own words ─────────────────────────────
  const response: SubmitDeliveryResponse = {
    shipment: { ...next, version: observed + 1 },
    challan,
    returns: returnRecord ? [returnRecord] : [],
  }
  const eventId = `DEV-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const writes: Stmt[] = []
  for (const did of shipment.dispatchIds) {
    const entry = dispatches.get(did)
    if (!entry) continue // a reversed dispatch: the trip still settles without it
    const line = byDispatch.get(did)!
    const rowStatus: string =
      line.qtyRejected <= EPS ? 'Delivered' : line.qtyDelivered <= EPS ? 'Returned' : 'Partially Delivered'
    const stamped: Dispatch = {
      ...entry.dispatch,
      status: rowStatus,
      pod: req.signature.printedName,
      // Kept, not restamped — the Classic rule verbatim: attaching proof later
      // must not move the time the delivery actually happened.
      deliveredTime: entry.dispatch.deliveredTime || now,
      ...(line.qtyRejected > EPS
        ? { deliveryNote: [line.reason ?? 'Rejected at the door', `Return ${returnRecord!.id}`].join(' · ') }
        : {}),
    }
    writes.push(...upsertDoc('dispatches', did, stamped, entry.version, now))
  }

  writes.push(
    ...upsertDoc('shipments', id, next, observed, now),
    insertOnce('challans', challan.id, challan, now),
    ...(minted ? [counterStmt('challan', mintedNext)] : []),
    ...(returnRecord ? [insertOnce('returns', returnRecord.id, returnRecord, now)] : []),
    insertOnce(
      'delivery_events',
      eventId,
      {
        id: eventId,
        shipmentId: id,
        type: 'signature',
        at: now,
        payload: { printedName: req.signature.printedName, outcome, challan: number },
      },
      now,
    ),
    auditStmt({
      id: auditId('shipment.submitted', id, now),
      at: now,
      actor: caller.email,
      action: 'shipment.submitted',
      doc: id,
      details: JSON.stringify({
        outcome,
        challan: number,
        ...(minted ? { minted: true } : { adopted: true }),
        ...(returnRecord ? { returnId: returnRecord.id, rejectedLines: rejected.length } : {}),
      }),
    }),
    receiptStmt(replayKey, key, body, 200, response, now),
    sweepStmt(now),
  )

  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This trip or one of its dispatches just moved under you — reload and submit again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}
