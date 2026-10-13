/**
 * /api/purchase-orders — the purchase-order endpoints (WORKFLOW W3, contracts
 * v1.3). POs are a server-endpoint-only collection (ARCHITECTURE §5: never
 * changeset-writable, so no dual-write divergence), and the funnel/supplier
 * KPIs fold them (KPI.md Procurement).
 *
 * - POST creates one: a number out of the `po` counter series, draft unless
 *   the caller says sent. The vendor and lines are validated against the
 *   masters the plant already holds — a PO for an unknown vendor or with no
 *   lines is refused, not stored broken.
 * - PATCH moves a status the purchaseOrder machine allows (src/lib/rules, the
 *   same table the client pre-checks with); `closed` additionally waits for
 *   its fully_received guard — at least one receipt linked to the PO.
 * - GET lists, newest first, for the Procurement page's PO form.
 *
 * Not flag-gated: a collection nothing Classic reads is inert by construction.
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
  readMeta,
  holdsPage,
  insertOnce,
  parseDoc,
  upsertDoc,
  writeBatch,
  isCasTrip,
  type Stmt,
  type StoredNumbering,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import { canTransition, guardsRequired, explainGuard } from '../../src/lib/rules.js'
import {
  isPurchaseOrderStatus,
  type PurchaseOrder,
  type PurchaseOrderCreateRequest,
  type PurchaseOrderListResponse,
  type PurchaseOrderPatchRequest,
  type PurchaseOrderResponse,
  type PurchaseOrderVersionExtension,
} from '../../src/lib/contracts.js'
import type { Vendor } from '../../src/types.js'

export const ROUTE = 'POST /api/purchase-orders'
export const PATCH_ROUTE = 'PATCH /api/purchase-orders/:id'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const EPS = 1e-9

/** POST — create a PO. One idempotent, atomic write: PO + counter + audit + receipt. */
export async function createPurchaseOrder(
  d1: D1Client,
  caller: Caller,
  body: unknown,
  key: string,
): Promise<{ status: number; body: PurchaseOrderResponse; replay?: boolean }> {
  if (!holdsPage(caller.permissions, 'page.procurement')) {
    throw new DomainError(403, 'Purchase orders are the Procurement page\'s own.', 'role_allowed')
  }
  const req = validateCreate(body)

  const replayed = await findReceipt(d1, ROUTE, key)
  if (replayed) {
    const verdict = replayOf<PurchaseOrderResponse>(replayed, bodyHashOf(key, ROUTE, body))
    return { ...verdict, replay: true }
  }

  const now = new Date().toISOString()
  const [vendorRows, meta, counters] = await Promise.all([
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'vendors'`),
    readMeta(d1),
    d1.query<{ next?: unknown }>(`SELECT next FROM counters WHERE series = 'po'`),
  ])
  if (!parseDoc<Vendor & { id?: string }>(vendorRows.find((r) => parseDoc<{ id?: string }>(r.json)?.id === req.vendorId)?.json ?? null)) {
    throw new DomainError(422, `No supplier ${req.vendorId}.`, 'vendor_not_found')
  }

  const n = (Number(counters[0]?.next) || 0) + 1
  const numbering = Array.isArray(appConfigOf(meta)?.numbering)
    ? ((appConfigOf(meta)!.numbering as unknown) as StoredNumbering[])
    : undefined
  const number = formatSeries(numbering, 'po', n)
  const po: PurchaseOrder = {
    id: number,
    number,
    vendorId: req.vendorId,
    lines: req.lines,
    status: req.status ?? 'draft',
    ...(req.expectedOn ? { expectedOn: req.expectedOn } : {}),
    receivedGrnIds: [],
  }
  const response: PurchaseOrderResponse = { po: { ...po, version: 1 } }

  const writes: Stmt[] = [
    insertOnce('purchase_orders', po.id, po, now),
    counterStmt('po', n),
    auditStmt({
      id: auditId('po.created', po.id, now),
      at: now,
      actor: caller.email,
      action: 'po.created',
      doc: po.id,
      details: JSON.stringify({ vendorId: po.vendorId, lines: po.lines.length, status: po.status }),
    }),
    receiptStmt(ROUTE, key, body, 200, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This purchase order changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 201, body: response }
}

/** PATCH — move a PO through the machine. */
export async function patchPurchaseOrder(
  d1: D1Client,
  caller: Caller,
  id: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: PurchaseOrderResponse; replay?: boolean }> {
  if (!holdsPage(caller.permissions, 'page.procurement')) {
    throw new DomainError(403, 'Purchase orders are the Procurement page\'s own.', 'role_allowed')
  }
  const req = validatePatch(body)

  const replayKey = `${PATCH_ROUTE}:${id}`
  const replayed = await findReceipt(d1, replayKey, key)
  if (replayed) {
    const verdict = replayOf<PurchaseOrderResponse>(replayed, bodyHashOf(key, replayKey, body))
    return { ...verdict, replay: true }
  }

  const rows = await d1.query<{ json: unknown; version: unknown }>(
    `SELECT json, version FROM documents WHERE collection = 'purchase_orders' AND id = ?`,
    [id],
  )
  const stored = rows[0]
  if (!stored) throw new DomainError(404, `No purchase order ${id}.`, 'po_not_found')
  const observed = Number(stored.version) || 0
  if (req.expectedVersion !== observed) {
    throw new DomainError(409, 'This purchase order changed after you read it — reload and try again.', 'cas_version')
  }
  const po = parseDoc<PurchaseOrder>(stored.json)
  if (!po) throw new DomainError(409, 'This purchase order cannot be read — it changed. Reload and try again.', 'cas_version')

  if (!canTransition('purchaseOrder', po.status, req.status)) {
    throw new DomainError(
      422,
      `A purchase order cannot move from ${po.status} to ${req.status}.`,
      'illegal_transition',
    )
  }
  const guards = guardsRequired('purchaseOrder', po.status, req.status)
  if (guards.includes('fully_received') && po.receivedGrnIds.length === 0) {
    throw new DomainError(422, explainGuard('fully_received') ?? 'Everything ordered has to be received first.', 'fully_received')
  }

  const now = new Date().toISOString()
  const next: PurchaseOrder = { ...po, status: req.status }
  // upsertDoc writes observed+1 — the response carries the new version so the
  // form's next move starts from what this one produced.
  const response: PurchaseOrderResponse = { po: { ...next, version: observed + 1 } }

  const writes: Stmt[] = [
    ...upsertDoc('purchase_orders', po.id, next, observed, now),
    auditStmt({
      id: auditId('po.status', po.id, now),
      at: now,
      actor: caller.email,
      action: 'po.status',
      doc: po.id,
      details: JSON.stringify({ from: po.status, to: req.status }),
    }),
    receiptStmt(replayKey, key, body, 200, response, now),
    sweepStmt(now),
  ]
  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This purchase order changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}

/** GET — the list, newest first (newest = highest number the series has minted). */
export async function listPurchaseOrders(d1: D1Client, caller: Caller): Promise<PurchaseOrderListResponse> {
  if (!holdsPage(caller.permissions, 'page.procurement')) {
    throw new DomainError(403, 'Purchase orders are the Procurement page\'s own.', 'role_allowed')
  }
  // Documents' version rides every row (v1.4): the form CAS-protects its moves.
  const rows = await d1.query<{ json: unknown; version: unknown }>(
    `SELECT json, version FROM documents WHERE collection = 'purchase_orders'`,
  )
  return {
    pos: rows
      .map((r) => {
        const po = parseDoc<PurchaseOrder>(r.json)
        return po && isPurchaseOrderStatus(po.status)
          ? { ...po, version: Number(r.version) || 0 }
          : undefined
      })
      .filter((po): po is PurchaseOrder & PurchaseOrderVersionExtension => !!po)
      .sort((a, b) => b.number.localeCompare(a.number)),
  }
}

function validateCreate(body: unknown): PurchaseOrderCreateRequest {
  const doc = (body ?? {}) as Record<string, unknown>
  const details: Record<string, string> = {}
  if (typeof doc.vendorId !== 'string' || !doc.vendorId.trim()) details.vendorId = 'Which supplier is this order for?'
  if (doc.status !== undefined && doc.status !== 'draft' && doc.status !== 'sent') {
    details.status = 'A new order starts as draft or sent.'
  }
  if (doc.expectedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(doc.expectedOn))) {
    details.expectedOn = 'Expected-on is a day (yyyy-mm-dd).'
  }
  if (!Array.isArray(doc.lines) || doc.lines.length === 0) details.lines = 'An order needs at least one line.'
  else {
    doc.lines.forEach((l, i) => {
      const line = (l ?? {}) as Record<string, unknown>
      if (typeof line.item !== 'string' || !line.item.trim()) details[`lines.${i}.item`] = 'Name the material.'
      if (!isNum(line.qty) || line.qty <= EPS) details[`lines.${i}.qty`] = 'Quantity must be greater than zero.'
      if (typeof line.uom !== 'string' || !line.uom.trim()) details[`lines.${i}.uom`] = 'Name the unit.'
      if (!isNum(line.rate) || line.rate < 0) details[`lines.${i}.rate`] = 'Rate must be zero or more.'
    })
  }
  if (Object.keys(details).length) throw new DomainError(422, 'The purchase order is not valid.', 'invalid_po', details)
  return doc as unknown as PurchaseOrderCreateRequest
}

function validatePatch(body: unknown): PurchaseOrderPatchRequest {
  const doc = (body ?? {}) as Record<string, unknown>
  const details: Record<string, string> = {}
  if (!isPurchaseOrderStatus(doc.status)) details.status = 'That is not a purchase-order status.'
  if (!isNum(doc.expectedVersion) || doc.expectedVersion < 0) details.expectedVersion = 'The version you read is required.'
  if (Object.keys(details).length) throw new DomainError(422, 'The purchase order change is not valid.', 'invalid_po', details)
  return doc as unknown as PurchaseOrderPatchRequest
}
