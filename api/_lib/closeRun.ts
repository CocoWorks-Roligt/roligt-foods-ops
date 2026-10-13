/**
 * POST /api/transformations/close — the run-close endpoint (contracts §5,
 * ARCHITECTURE §5). One atomic D1 batch posts the close: the spoilage records,
 * the batch document (status Closed, stageTimes.closed stamped, output stock
 * IDs minted), the spoilage ledger lines, the audit row and the idempotency
 * receipt, with the revision bump last. The B2 rules are the AUTHORITY here —
 * closeRunGuards and the server-recomputed mass balance, never the client's —
 * and are enforced whenever batch_v2 is on; a flag-off base closes legacy-style
 * (records still written, guards skipped, ARCHITECTURE §7's rollback position).
 *
 * The spoilage ledger line draws from the batch's OWN output stock: a loss
 * recorded at close hit bulk that was already booked, so the draw targets the
 * output row whose uom matches the record's, with the row's exact key (item,
 * lot, location, status, expiry — uom is not in the stock row key, so a
 * mismatched line would corrupt balances). A record whose uom matches no output
 * row (extraction-stage coconuts: the loss already reduced yield at posting, it
 * never became output stock) is the reason-coded record alone — documented in
 * the B3 handoff, and the mass balance still counts its qty.
 */
import type { D1Client } from './d1.js'
import type { Caller } from './auth.js'
import { flagsOfDocs, batchLines } from './rulesGate.js'
import {
  DomainError,
  appConfigOf,
  auditId,
  auditStmt,
  insertOnce,
  isCasTrip,
  mayCloseRun,
  parseDoc,
  readMeta,
  stockIdFor,
  upsertDoc,
  writeBatch,
  type Stmt,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import { massBalanceConfigOf, computeMassBalance, MassBalanceError, type MassBalanceItems } from '../../src/lib/rules/massBalance.js'
import { closeRunGuards, failedRunGuards } from '../../src/lib/rules/spoilage.js'
import { RUN_STATUSES, type BatchExtension, type CloseTransformationResponse, type MassBalanceResult, type SpoilageInput, type SpoilageRecord, type SpoilageStage } from '../../src/lib/contracts.js'
import type { Batch, BulkOutputLine } from '../../src/types.js'

export const ROUTE = 'POST /api/transformations/close'

const STAGES: readonly SpoilageStage[] = ['extraction', 'blend', 'fill']
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Request shape — contracts CloseTransformationRequest, judged server-side. */
function validate(body: unknown): { batchId: string; expectedVersion: number; spoilage: SpoilageInput[] } {
  const doc = (body ?? {}) as Record<string, unknown>
  const details: Record<string, string> = {}
  if (typeof doc.batchId !== 'string' || !doc.batchId.trim()) details.batchId = 'Which batch is closing?'
  const expectedVersion = isNum(doc.expectedVersion) ? doc.expectedVersion : Number.NaN
  if (!(expectedVersion >= 0)) details.expectedVersion = 'The batch version you read is required.'
  const raw = Array.isArray(doc.spoilage) ? doc.spoilage : []
  if (!raw.length) details.spoilage = 'Record spoilage first — zero is fine, but it must be said.'
  const spoilage: SpoilageInput[] = []
  raw.forEach((line, i) => {
    const l = (line ?? {}) as Record<string, unknown>
    const why = (msg: string) => {
      if (!details[`spoilage.${i}`]) details[`spoilage.${i}`] = msg
    }
    if (!STAGES.includes(l.stage as SpoilageStage)) return why('Pick the stage this loss belongs to.')
    if (!isNum(l.qty) || l.qty < 0) return why('Quantity must be zero or more.')
    if (typeof l.uom !== 'string' || !l.uom.trim()) return why('The unit this loss is counted in is required.')
    if (typeof l.reasonCode !== 'string' || !l.reasonCode.trim()) return why('Pick a reason code.')
    spoilage.push({
      stage: l.stage as SpoilageStage,
      qty: l.qty,
      uom: l.uom,
      reasonCode: l.reasonCode,
      ...(typeof l.photoKey === 'string' && l.photoKey ? { photoKey: l.photoKey } : {}),
    })
  })
  if (Object.keys(details).length) throw new DomainError(422, 'The close request is not valid.', 'invalid_close', details)
  return { batchId: String(doc.batchId).trim(), expectedVersion, spoilage }
}

/** One output row as the spoilage draw sees it — net stock still on the row. */
interface StockRow {
  id: string
  item: string
  lot: string
  location: string
  status: string
  uom: string
  expiry?: string
  unitCost: number
  qtyIn: number
  qtyOut: number
}

/** The service: reads evidence, judges, writes ONE batch. Returns the response. */
export async function closeTransformation(
  d1: D1Client,
  caller: Caller,
  body: unknown,
  key: string,
): Promise<{ status: number; body: CloseTransformationResponse; replay?: boolean }> {
  if (!mayCloseRun(caller.permissions)) {
    throw new DomainError(403, 'Closing a run takes can.close_run and a production or packing page.', 'role_allowed')
  }
  const req = validate(body)

  const replayed = await findReceipt(d1, ROUTE, key)
  if (replayed) {
    const verdict = replayOf<CloseTransformationResponse>(replayed, bodyHashOf(key, ROUTE, body))
    return { ...verdict, replay: true }
  }

  const now = new Date().toISOString()
  const [batchRows, flagsRows, reasonsRows, meta, allSpoilage, ledgerRows, itemRows] = await Promise.all([
    d1.query<{ json: unknown; version: unknown }>(
      `SELECT json, version FROM documents WHERE collection = 'batches' AND id = ?`,
      [req.batchId],
    ),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'flags'`),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'spoilage_reasons'`),
    readMeta(d1),
    d1.query<{ json: unknown; id: unknown }>(
      `SELECT id, json FROM documents WHERE collection = 'spoilage_records' AND json_extract(json, '$.batchId') = ?`,
      [req.batchId],
    ),
    d1.query<{ id: unknown; json: unknown }>(
      `SELECT id, json FROM documents WHERE collection = 'ledger' AND json_extract(json, '$.lot') = ?`,
      [req.batchId],
    ),
    d1.query<{ id: unknown; json: unknown }>(`SELECT id, json FROM documents WHERE collection = 'items'`),
  ])

  const stored = batchRows[0]
  if (!stored) throw new DomainError(404, `No batch ${req.batchId}.`, 'batch_not_found')
  const observed = Number(stored.version) || 0
  if (req.expectedVersion !== observed) {
    throw new DomainError(409, 'This batch changed after you read it — reload and try again.', 'cas_version')
  }
  const batch = parseDoc<Batch & BatchExtension>(stored.json)
  if (!batch) throw new DomainError(409, 'This batch cannot be read — it changed. Reload and try again.', 'cas_version')

  if (batch.status === 'Closed') {
    throw new DomainError(422, `${batch.id} is already closed.`, 'already_closed')
  }
  if ((RUN_STATUSES as readonly string[]).includes(batch.status)) {
    // the run machine's own statuses must arrive at Closed legally
    const legal = ['In Progress', 'Awaiting QC'].includes(batch.status)
    if (!legal) {
      throw new DomainError(422, `A ${batch.status} run cannot close — move it along its lifecycle first.`, 'illegal_transition')
    }
  }

  // the reason codes this base knows — an unknown code is refused, not filed
  const reasons = new Set<string>()
  for (const r of reasonsRows) {
    const doc = parseDoc<{ code?: unknown; stage?: unknown; active?: unknown }>(r.json)
    if (doc?.active === true && typeof doc.code === 'string') reasons.add(`${doc.stage}:${doc.code}`)
  }
  for (const [i, line] of req.spoilage.entries()) {
    const known = reasons.has(`${line.stage}:${line.reasonCode}`) || reasons.has(`any:${line.reasonCode}`)
    if (!known) {
      throw new DomainError(422, `Unknown reason code ${line.reasonCode} for the ${line.stage} stage.`, 'invalid_close', {
        [`spoilage.${i}`]: 'Pick a reason code the plant knows.',
      })
    }
  }

  const flags = flagsOfDocs(flagsRows.map((r) => String(r.json ?? '')))
  const appConfig = appConfigOf(meta)
  const config = massBalanceConfigOf(appConfig)
  const items: MassBalanceItems = {}
  for (const r of itemRows) {
    const doc = parseDoc<{ uom?: unknown; avgUnitWeight?: unknown; densityKgPerL?: unknown }>(r.json)
    if (!doc) continue
    items[String(r.id ?? '')] = {
      ...(typeof doc.uom === 'string' ? { uom: doc.uom } : {}),
      ...(Number(doc.avgUnitWeight) > 0 ? { avgUnitWeight: Number(doc.avgUnitWeight) } : {}),
      ...(Number(doc.densityKgPerL) > 0 ? { densityKgPerL: Number(doc.densityKgPerL) } : {}),
    }
  }

  // the spoilage documents this close files — deterministic ids, insert-only
  const existingCount = allSpoilage.length
  const records: SpoilageRecord[] = req.spoilage.map((line, i) => ({
    id: `SPG:${req.batchId}:${existingCount + i + 1}`,
    batchId: req.batchId,
    stage: line.stage,
    qty: line.qty,
    uom: line.uom,
    reasonCode: line.reasonCode,
    ...(line.photoKey ? { photoKey: line.photoKey } : {}),
    at: now,
    actor: caller.email,
  }))

  // the mass balance — recomputed HERE from the batch + this close's records
  const { inputs, outputs } = batchLines(batch as unknown as Record<string, unknown>, items)
  const spillageLines = records.map((r) => ({ item: '', qty: r.qty, uom: r.uom }))
  let massBalance: MassBalanceResult
  try {
    massBalance = computeMassBalance(inputs, outputs, spillageLines, items, config)
  } catch (e) {
    if (flags.batch_v2 && e instanceof MassBalanceError) {
      throw new DomainError(422, `Inputs and outputs do not balance: ${e.message}`, 'mass_balance_ok')
    }
    massBalance = { inputBaseUnits: 0, outputBaseUnits: 0, variancePct: 0, withinTolerance: true }
  }

  // batch_v2: the B2 guards as the authority — spoilage + tolerance
  if (flags.batch_v2) {
    const failed = failedRunGuards(closeRunGuards({ id: req.batchId }, records, massBalance))
    if (failed.length) {
      const guard = failed[0]
      const detail =
        guard === 'mass_balance_ok'
          ? ` Variance is ${massBalance.variancePct.toFixed(2)}% against a ${config.massBalanceTolerancePct}% tolerance.`
          : ''
      throw new DomainError(
        422,
        `${guard === 'spoilage_required' ? 'Record spoilage first — zero is fine, but it must be said.' : 'Inputs and outputs do not balance within tolerance.'}${detail}`,
        guard,
      )
    }
  }

  // the output rows this batch's lot holds — spoilage draws target these
  const stock: StockRow[] = []
  for (const r of ledgerRows) {
    const row = parseDoc<Record<string, unknown>>(r.json)
    if (!row) continue
    const qtyIn = Number(row.qty_in) || 0
    const qtyOut = Number(row.qty_out) || 0
    if (qtyIn - qtyOut <= 0) continue
    stock.push({
      id: String(r.id ?? ''),
      item: String(row.item ?? ''),
      lot: String(row.lot ?? ''),
      location: String(row.location ?? ''),
      status: String(row.status ?? ''),
      uom: String(row.uom ?? ''),
      expiry: row.expiry ? String(row.expiry) : undefined,
      unitCost: Number(row.unit_cost) || 0,
      qtyIn,
      qtyOut,
    })
  }

  // the ledger lines: a record whose uom matches an output row draws from it.
  // The rows are mutated as each record claims its share, so the next record
  // with the same unit sees the reduced pool — no double-count.
  const writes: Stmt[] = []
  for (const record of records) {
    if (!(record.qty > 0)) continue
    const candidates = stock.filter((s) => s.uom.toLowerCase() === record.uom.trim().toLowerCase())
    if (!candidates.length) continue // never output stock — the record stands alone
    const pool = candidates.reduce((n, s) => n + (s.qtyIn - s.qtyOut), 0)
    if (pool < record.qty - 1e-9) {
      throw new DomainError(
        422,
        `The ${record.uom} spoilage on ${req.batchId} is more than the ${pool} it holds.`,
        'spoilage_exceeds_stock',
      )
    }
    let remaining = record.qty
    for (const row of candidates) {
      if (remaining <= 0) break
      const net = row.qtyIn - row.qtyOut
      if (net <= 0) continue
      const take = Math.min(net, remaining)
      remaining -= take
      writes.push({
        sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('ledger', ?, ?, 1, ?)
          ON CONFLICT(collection, id) DO NOTHING`,
        params: [
          `LED:${record.id}:${row.id}`,
          JSON.stringify({
            id: `LED:${record.id}:${row.id}`,
            type: 'Spoilage',
            doc: record.id,
            item: row.item,
            item_type: 'Semi Finished',
            lot: row.lot,
            location: row.location,
            status: row.status,
            qty_in: 0,
            qty_out: take,
            uom: row.uom,
            unit_cost: row.unitCost,
            at: now,
            expiry: row.expiry ?? null,
            vendor_id: null,
          }),
          now,
        ],
      })
      row.qtyOut += take
    }
  }

  // the batch document: Closed, stage clock stamped, output stock IDs minted
  // (an id a line already carries stays — a sticker on a tub must not change
  // because the run closed; a line without one takes the next number up)
  const outputLines: BulkOutputLine[] = Array.isArray(batch.outputLines) ? batch.outputLines : []
  let highest = outputLines.reduce(
    (n, l) => Math.max(n, l.stockId ? Number(l.stockId.split('/')[1]) || 0 : 0),
    0,
  )
  const stamped = outputLines.map((line) => {
    if (line.stockId) return line
    highest += 1
    return { ...line, stockId: stockIdFor(batch.id, highest) }
  })
  const closedBatch: Batch & BatchExtension = {
    ...batch,
    status: 'Closed',
    outputLines: stamped,
    stageTimes: { ...(batch.stageTimes ?? {}), closed: now },
  }
  const response: CloseTransformationResponse = {
    batchId: req.batchId,
    status: 'Closed',
    massBalance,
    spoilage: records,
  }

  writes.unshift(
    ...records.map((r) => insertOnce('spoilage_records', r.id, r, now)),
    ...upsertDoc('batches', req.batchId, closedBatch, observed, now),
    auditStmt({
      id: auditId('run.close', req.batchId, now),
      at: now,
      actor: caller.email,
      action: 'run.close',
      doc: req.batchId,
      details: JSON.stringify({
        from: batch.status,
        spoilage: records.length,
        variancePct: Number(massBalance.variancePct.toFixed(3)),
        batchV2: flags.batch_v2,
      }),
    }),
    receiptStmt(ROUTE, key, body, 200, response, now),
    sweepStmt(now),
  )

  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This batch changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}
