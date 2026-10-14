/**
 * /api/challans — the challan register and its corrections (SHIPMENT B5b,
 * contracts v1.9). A challan is IMMUTABLE: it is minted by the submit
 * endpoint and never edited — a correction supersedes it (fresh DC number,
 * supersedesId, reason, one version up), and the PDF for each number is its
 * own object under `challans/<number>.pdf`.
 *
 * - GET lists the register (an agent's own challans only, by agentId).
 * - GET :id/file answers a 302 to a short-lived presigned GET, rendering and
 *   uploading the PDF first when the object is missing (the lazy render).
 * - POST :id/correct supersedes: old → Superseded, new linked version issued.
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
import { presignR2Get, presignR2Put, r2Configured } from './r2.js'
import { renderChallanPdf } from './challanPdf.js'
import type {
  Challan,
  ChallanCorrectRequest,
  ChallanCorrectResponse,
  ChallanLine,
  ChallanListResponse,
  Shipment,
} from '../../src/lib/contracts.js'
import type { Customer } from '../../src/types.js'

export const CORRECT_ROUTE = 'POST /api/challans/:id/correct'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

async function readChallan(d1: D1Client, id: string): Promise<{ challan: Challan; version: number }> {
  const rows = await d1.query<{ json: unknown; version: unknown }>(
    `SELECT json, version FROM documents WHERE collection = 'challans' AND id = ?`,
    [id],
  )
  const stored = rows[0]
  if (!stored) throw new DomainError(404, `No challan ${id}.`, 'challan_not_found')
  const challan = parseDoc<Challan>(stored.json)
  if (!challan) {
    throw new DomainError(409, `Challan ${id} cannot be read — it changed. Reload and try again.`, 'cas_version')
  }
  return { challan, version: Number(stored.version) || 0 }
}

// ── GET /api/challans ────────────────────────────────────────────────────────

export async function listChallans(d1: D1Client, caller: Caller): Promise<ChallanListResponse> {
  const rows = await d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'challans'`)
  const all: Challan[] = []
  for (const r of rows) {
    const doc = parseDoc<Challan>(r.json)
    if (doc) all.push(doc)
  }
  const mine = isDeliveryAgent(caller.permissions)
    ? all.filter((c) => c.agentId === caller.email)
    : all
  mine.sort((a, b) => b.number.localeCompare(a.number))
  return { challans: mine }
}

// ── GET /api/challans/:id/file — the lazy render, then the redirect ─────────

/** The buyer map a render needs — one read, three collections. */
async function renderContext(
  d1: D1Client,
  challan: Challan,
): Promise<{ shipment: Shipment; customers: Map<string, Customer> }> {
  const [shipmentRows, customerRows] = await Promise.all([
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'shipments' AND id = ?`, [
      challan.shipmentId,
    ]),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'customers'`),
  ])
  const shipment = parseDoc<Shipment>(shipmentRows[0]?.json ?? null)
  if (!shipment) {
    throw new DomainError(409, `The challan's trip is missing — it cannot be rendered.`, 'shipment_not_found')
  }
  const customers = new Map<string, Customer>()
  for (const r of customerRows) {
    const doc = parseDoc<Customer>(r.json)
    if (doc) customers.set(doc.id, doc)
  }
  return { shipment, customers }
}

/**
 * The presigned GET the route redirects to — rendering and uploading first
 * when the object is missing (the submit's eager upload may have failed, or
 * R2 was not yet configured when the delivery landed).
 */
export async function challanFileUrl(d1: D1Client, caller: Caller, id: string): Promise<string> {
  const { challan } = await readChallan(d1, id)
  const agent = isDeliveryAgent(caller.permissions)
  if (agent) {
    if (challan.agentId !== caller.email) {
      // Never 403 — an external user must not learn that another challan exists.
      throw new DomainError(404, `No challan ${id}.`, 'challan_not_found')
    }
  } else if (!holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'The register is the Shipment Tracking board\'s own.', 'role_allowed')
  }
  if (!r2Configured()) {
    throw new DomainError(503, 'Challan storage is not configured (R2 env missing).', 'r2_not_configured')
  }

  const probe = await fetch(presignR2Get(challan.pdfKey, { expiresInSec: 60 }))
  if (probe.status !== 200) {
    const { shipment, customers } = await renderContext(d1, challan)
    const bytes = await renderChallanPdf(challan, shipment, customers)
    const put = await fetch(presignR2Put(challan.pdfKey, 'application/pdf'), {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    })
    if (!put.ok) {
      throw new DomainError(502, 'The challan PDF could not be stored — try again in a moment.', 'challan_pdf_failed')
    }
  }
  return presignR2Get(challan.pdfKey, { expiresInSec: 120, downloadName: `${challan.number.replace(/[^A-Za-z0-9/_-]/g, '_')}.pdf` })
}

// ── POST /api/challans/:id/correct — supersede ───────────────────────────────

function validateCorrect(body: unknown): ChallanCorrectRequest & { lines?: ChallanLine[] } {
  if (!body || typeof body !== 'object') {
    throw new DomainError(400, 'The request body must be a JSON object.', 'body_invalid')
  }
  const b = body as Record<string, unknown>
  const details: Record<string, string> = {}
  if (!isStr(b.reason)) details.reason = 'Why the challan is being corrected.'
  if (!isNum(b.expectedVersion)) details.expectedVersion = 'The version the register showed.'
  if (Object.keys(details).length > 0) {
    throw new DomainError(422, 'This correction cannot be made as asked.', 'body_invalid', details)
  }
  const req: ChallanCorrectRequest & { lines?: ChallanLine[] } = {
    reason: (b.reason as string).trim(),
    expectedVersion: b.expectedVersion as number,
  }
  if (b.lines !== undefined) {
    const linesOk =
      Array.isArray(b.lines) &&
      (b.lines as unknown[]).every(
        (l) =>
          l &&
          typeof l === 'object' &&
          isStr((l as Record<string, unknown>).sku) &&
          isStr((l as Record<string, unknown>).skuName) &&
          isStr((l as Record<string, unknown>).lot) &&
          isNum((l as Record<string, unknown>).qty),
      )
    if (!linesOk) {
      throw new DomainError(422, 'Corrected lines are sku/skuName/lot/qty rows.', 'body_invalid', {
        lines: 'ChallanLine rows, or leave them out to stand as issued.',
      })
    }
    req.lines = b.lines as ChallanLine[]
  }
  return req
}

export async function correctChallan(
  d1: D1Client,
  caller: Caller,
  id: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: ChallanCorrectResponse; replay?: boolean }> {
  if (isDeliveryAgent(caller.permissions) || !holdsPage(caller.permissions, 'page.shipments')) {
    throw new DomainError(403, 'Correcting a challan is the board\'s own.', 'role_allowed')
  }
  const req = validateCorrect(body)

  const replayKey = `${CORRECT_ROUTE}:${id}`
  const replayed = await findReceipt(d1, replayKey, key)
  if (replayed) {
    const verdict = replayOf<ChallanCorrectResponse>(replayed, bodyHashOf(key, replayKey, body))
    return { ...verdict, replay: true }
  }

  const { challan: old, version: observed } = await readChallan(d1, id)
  if (req.expectedVersion !== observed) {
    throw new DomainError(409, 'This challan changed after you read it — reload and try again.', 'cas_version')
  }
  if (old.status !== 'Issued') {
    throw new DomainError(422, `This challan is ${old.status} — only an issued challan can be corrected.`, 'illegal_transition')
  }

  // The fresh DC number — the 'challan' numbering series, the same belt the
  // client's dispatchOrder pre-mints from. The counter only ever moves forward.
  const [counterRows, meta] = await Promise.all([
    d1.query<{ next?: unknown }>(`SELECT next FROM counters WHERE series = 'challan'`),
    readMeta(d1),
  ])
  const n = (Number(counterRows[0]?.next) || 0) + 1
  const numbering = Array.isArray(appConfigOf(meta)?.numbering)
    ? ((appConfigOf(meta)!.numbering as unknown) as StoredNumbering[])
    : undefined
  const number = formatSeries(numbering, 'challan', n)

  const now = new Date().toISOString()
  const corrected: Challan = {
    id: number,
    number,
    shipmentId: old.shipmentId,
    orderId: old.orderId,
    status: 'Issued',
    version: old.version + 1,
    supersedesId: old.id,
    reason: req.reason,
    pdfKey: `challans/${number}.pdf`,
    taxFields: old.taxFields,
    lines: req.lines ?? old.lines,
    agentId: old.agentId,
    vehicle: old.vehicle,
    deliveredAt: old.deliveredAt,
  }
  const response: ChallanCorrectResponse = { challan: corrected }

  const writes: Stmt[] = [
    ...upsertDoc('challans', old.id, { ...old, status: 'Superseded' }, observed, now),
    insertOnce('challans', corrected.id, corrected, now),
    counterStmt('challan', n),
    auditStmt({
      id: auditId('challan.corrected', old.id, now),
      at: now,
      actor: caller.email,
      action: 'challan.corrected',
      doc: old.id,
      details: JSON.stringify({ supersededBy: corrected.id, reason: req.reason }),
    }),
    receiptStmt(replayKey, key, body, 201, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This challan changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 201, body: response }
}
