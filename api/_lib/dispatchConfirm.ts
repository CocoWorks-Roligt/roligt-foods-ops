/**
 * POST /api/dispatch/confirm — the atomic carton transaction (§3.3-9,
 * contracts §5). Pouches and cartons decrement in ONE D1 batch, or neither
 * does: a BOXED line's plan (rules/cartons planDeduction) moves pouches AND
 * its cartons; a LOOSE line moves pouches only — carton stock is never
 * touched, not "zeroed", and the tests pin that on the ledger itself.
 *
 * Picks are FEFO (rules/consumption fefoOrder, strict/relaxed per
 * app_config.fefoMode) over the Released rows of the named lot — dispatch was
 * always Released-only. The challan number is reserved from the counters
 * series inside the same batch (forward-only belt), per-line dispatch ids from
 * the dispatch series, reservations written onto the order, cold-room out-time
 * stamped on every dispatch record, and the order lands Partially Dispatched
 * or Dispatched by what is now out the gate.
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
  holdsAction,
  insertOnce,
  isCasTrip,
  parseDoc,
  readMeta,
  readCounters,
  upsertDoc,
  writeBatch,
  type Stmt,
  type StoredNumbering,
} from './domain.js'
import { bodyHashOf, findReceipt, receiptStmt, replayOf, sweepStmt } from './idempotency.js'
import { canConsumeLot, fefoOrder, planDeduction } from '../../src/lib/rules.js'
import type {
  CartonSpec,
  DispatchConfirmRequest,
  DispatchConfirmResponse,
  DispatchLineInput,
  FefoMode,
  OrderExtension,
} from '../../src/lib/contracts.js'
import type { Dispatch, Order } from '../../src/types.js'

export const ROUTE = 'POST /api/dispatch/confirm'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const EPS = 1e-9

/** A Released stock row the pick may draw from, as FEFO sees it. */
interface PickRow {
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

interface Alloc {
  row: PickRow
  qty: number
}

export async function confirmDispatch(
  d1: D1Client,
  caller: Caller,
  body: unknown,
  key: string,
): Promise<{ status: number; body: DispatchConfirmResponse & { challan?: string }; replay?: boolean }> {
  if (!holdsAction(caller.permissions, 'can.confirm_dispatch')) {
    throw new DomainError(403, 'Confirming a dispatch takes can.confirm_dispatch.', 'role_allowed')
  }
  const req = validate(body)

  const replayed = await findReceipt(d1, ROUTE, key)
  if (replayed) {
    const verdict = replayOf<DispatchConfirmResponse & { challan?: string }>(replayed, bodyHashOf(key, ROUTE, body))
    return { ...verdict, replay: true }
  }

  const now = new Date().toISOString()
  const meta = await readMeta(d1)
  const appConfig = appConfigOf(meta)
  const fefoMode: FefoMode = appConfig?.fefoMode === 'strict' ? 'strict' : 'relaxed'

  const [orderRows, specRows, counterMap, dispatchRows, ledgerRows] = await Promise.all([
    d1.query<{ json: unknown; version: unknown }>(
      `SELECT json, version FROM documents WHERE collection = 'orders' AND id = ?`,
      [req.orderId],
    ),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'carton_specs'`),
    readCounters(d1),
    d1.query<{ json: unknown }>(
      `SELECT json FROM documents WHERE collection = 'dispatches' AND json_extract(json, '$.orderId') = ?`,
      [req.orderId],
    ),
    d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = 'ledger'`),
  ])

  const stored = orderRows[0]
  if (!stored) throw new DomainError(404, `No order ${req.orderId}.`, 'order_not_found')
  const observed = Number(stored.version) || 0
  if (req.expectedVersion !== observed) {
    throw new DomainError(409, 'This order changed after you read it — reload and try again.', 'cas_version')
  }
  const order = parseDoc<Order & OrderExtension>(stored.json)
  if (!order) throw new DomainError(409, 'This order cannot be read — it changed. Reload and try again.', 'cas_version')
  if (order.status !== 'Open' && order.status !== 'Partially Dispatched') {
    throw new DomainError(422, `${order.id} is ${order.status} — nothing left to dispatch on it.`, 'order_not_open')
  }

  // the stock the pick draws from — Released rows only, FEFO-ordered
  const picks: PickRow[] = []
  for (const r of ledgerRows) {
    const row = parseDoc<Record<string, unknown>>(r.json)
    if (!row) continue
    const qtyIn = Number(row.qty_in) || 0
    const qtyOut = Number(row.qty_out) || 0
    if (qtyIn - qtyOut <= EPS) continue
    picks.push({
      id: String((row as { id?: unknown }).id ?? ''),
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

  // the carton reference data: a BOXED line's carton must be one the plant
  // configured for its size (an inactive or unknown carton item is refused —
  // the master has to answer, DECISIONS #14)
  const specs: CartonSpec[] = []
  for (const r of specRows) {
    const spec = parseDoc<CartonSpec>(r.json)
    if (spec && spec.active && Number(spec.pouchesPerCarton) > 0) specs.push(spec)
  }
  const knownCartons = new Set(specs.map((s) => s.cartonItemId))

  // every line's allocation, judged before anything writes
  const allocations: Alloc[][] = []
  for (const [i, line] of req.lines.entries()) {
    let candidates = picks.filter(
      (p) => p.item === line.sku && p.lot === line.lot && canConsumeLot(p, { purpose: 'dispatch', qcGateV2: false }).ok,
    )
    if (line.location) candidates = candidates.filter((p) => p.location === line.location)
    if (line.expiry) candidates = candidates.filter((p) => p.expiry === line.expiry)
    const ordered = fefoOrder(candidates, fefoMode)
    const allocs: Alloc[] = []
    let remaining = line.qty
    for (const row of ordered) {
      if (remaining <= EPS) break
      const net = row.qtyIn - row.qtyOut
      if (net <= EPS) continue
      const take = Math.min(net, remaining)
      remaining -= take
      row.qtyOut += take
      allocs.push({ row, qty: take })
    }
    if (remaining > EPS) {
      throw new DomainError(
        422,
        `Lot ${line.lot} holds less than the ${line.qty} of ${line.sku} asked for — ${line.qty - remaining} short.`,
        'insufficient_stock',
        { [`lines.${i}`]: 'Not enough released stock on this lot.' },
      )
    }
    allocations.push(allocs)
  }

  // the carton plan — BOXED moves cartons, LOOSE never does (planDeduction)
  const cartonTotals = new Map<string, number>()
  for (const line of req.lines) {
    if (line.packaging !== 'BOXED') continue
    const plan = planDeduction('BOXED', { pouches: line.qty, cartons: line.cartons ?? 0, cartonItemId: line.cartonItemId })
    if (plan.cartons > 0) {
      if (!plan.cartonItemId) {
        throw new DomainError(422, 'A BOXED line needs the carton it packs into.', 'carton_unspecified')
      }
      if (knownCartons.size && !knownCartons.has(plan.cartonItemId)) {
        throw new DomainError(422, `${plan.cartonItemId} is not an active carton the plant packs into.`, 'carton_spec')
      }
      cartonTotals.set(plan.cartonItemId, (cartonTotals.get(plan.cartonItemId) ?? 0) + plan.cartons)
    }
  }
  const cartonStock = [...picks] // PM rows live in the same ledger pool
  for (const [cartonItemId, wanted] of cartonTotals) {
    const pool = cartonStock
      .filter((p) => p.item === cartonItemId && p.status === 'Available')
      .reduce((n, p) => n + (p.qtyIn - p.qtyOut), 0)
    if (pool + EPS < wanted) {
      throw new DomainError(422, `Only ${pool} of carton ${cartonItemId} in stock — ${wanted} asked for.`, 'carton_stock')
    }
  }

  // numbers: one challan per order dispatch, one dispatch id per line
  const numbering = Array.isArray(appConfig?.numbering)
    ? (appConfig.numbering as unknown as StoredNumbering[])
    : undefined
  const nextOf = (series: string): { n: number; code: string } => {
    const n = (counterMap.get(series) ?? 0) + 1
    counterMap.set(series, n)
    return { n, code: formatSeries(numbering, series, n) }
  }
  const challan = nextOf('challan').code
  const dispatchIds: string[] = []
  const dispatchDocs: (Dispatch & { coldRoomOutAt?: string })[] = []
  const writes: Stmt[] = []

  req.lines.forEach((line, i) => {
    const allocs = allocations[i]
    const { code: dispatchId } = nextOf('dispatch')
    dispatchIds.push(dispatchId)
    dispatchDocs.push({
      id: dispatchId,
      customerId: order.customerId,
      customerName: order.customerName,
      batchId: line.lot,
      sku: line.sku,
      qty: line.qty,
      expiry: allocs[0]?.row.expiry,
      challan,
      vehicle: req.vehicle,
      dispatchTime: now,
      status: 'Dispatched',
      pod: '',
      orderId: order.id,
      ...(req.coldRoomOutAt ? { coldRoomOutAt: req.coldRoomOutAt } : {}),
    })
    // pouches: one ledger line per pick row, the row's exact key
    for (const alloc of allocs) {
      const id = `LED:DSP:${dispatchId}:${alloc.row.id}`
      writes.push(
        insertOnce(
          'ledger',
          id,
          {
            id,
            type: 'Dispatch',
            doc: dispatchId,
            item: alloc.row.item,
            item_type: 'Finished Goods',
            lot: alloc.row.lot,
            location: alloc.row.location,
            status: 'Released',
            qty_in: 0,
            qty_out: alloc.qty,
            uom: alloc.row.uom,
            unit_cost: alloc.row.unitCost,
            at: now,
            expiry: alloc.row.expiry ?? null,
            vendor_id: null,
          },
          now,
        ),
      )
    }
  })

  // cartons: BOXED only, the same atomic batch — the pouch deduction's twin
  const cartonsIssued: { cartonItemId: string; count: number }[] = []
  for (const [cartonItemId, wanted] of cartonTotals) {
    let remaining = wanted
    for (const row of cartonStock) {
      if (remaining <= EPS) break
      if (row.item !== cartonItemId || row.status !== 'Available') continue
      const net = row.qtyIn - row.qtyOut
      if (net <= EPS) continue
      const take = Math.min(net, remaining)
      remaining -= take
      row.qtyOut += take
      const id = `LED:CARTON:${challan}:${row.id}`
      writes.push(
        insertOnce(
          'ledger',
          id,
          {
            id,
            type: 'Carton Consume',
            doc: challan,
            item: row.item,
            item_type: 'Packing Material',
            lot: row.lot,
            location: row.location,
            status: row.status,
            qty_in: 0,
            qty_out: take,
            uom: row.uom,
            unit_cost: row.unitCost,
            at: now,
            expiry: null,
            vendor_id: null,
          },
          now,
        ),
      )
    }
    cartonsIssued.push({ cartonItemId, count: wanted })
  }

  // the order: what is out the gate now, against what was asked for
  const priorRows = dispatchRows
    .map((r) => parseDoc<Dispatch>(r.json))
    .filter((d): d is Dispatch => !!d)
  const shippedBySku = new Map<string, number>()
  for (const d of [...priorRows, ...dispatchDocs]) {
    shippedBySku.set(d.sku, (shippedBySku.get(d.sku) ?? 0) + d.qty)
  }
  const complete = order.lines.every((l) => (shippedBySku.get(l.sku) ?? 0) + EPS >= l.qty)
  const orderStatus = complete ? 'Dispatched' : 'Partially Dispatched'

  const reservations = [
    ...(order.reservations ?? []),
    ...req.lines.flatMap((line, i) =>
      allocations[i].map((alloc) => ({
        sku: line.sku,
        lot: alloc.row.lot,
        location: alloc.row.location,
        qty: alloc.qty,
        version: observed + 1,
      })),
    ),
  ]
  const updatedOrder: Order & OrderExtension = {
    ...order,
    status: orderStatus,
    reservations,
    challan,
    ...(complete ? { dispatchedAt: now } : {}),
  }

  const response: DispatchConfirmResponse & { challan?: string } = {
    dispatchIds,
    orderStatus,
    cartonsIssued,
    loadedAt: req.coldRoomOutAt ?? now,
    // additive: contracts' response predates the challan return (B3 handoff gap)
    challan,
  }

  writes.unshift(
    ...dispatchDocs.map((doc) => insertOnce('dispatches', doc.id, doc, now)),
    ...upsertDoc('orders', order.id, updatedOrder, observed, now),
    counterStmt('challan', counterMap.get('challan')!),
    ...(dispatchIds.length ? [counterStmt('dispatch', counterMap.get('dispatch')!)] : []),
    auditStmt({
      id: auditId('dispatch.confirm', order.id, now),
      at: now,
      actor: caller.email,
      action: 'dispatch.confirm',
      doc: order.id,
      details: JSON.stringify({ challan, lines: req.lines.length, cartons: cartonsIssued, orderStatus }),
    }),
    receiptStmt(ROUTE, key, body, 200, response, now),
    sweepStmt(now),
  )

  try {
    await writeBatch(d1, writes)
  } catch (e) {
    if (isCasTrip(e)) {
      throw new DomainError(409, 'This order changed after you read it — reload and try again.', 'cas_version')
    }
    throw e
  }
  return { status: 200, body: response }
}

function validate(body: unknown): DispatchConfirmRequest {
  const doc = (body ?? {}) as Record<string, unknown>
  const details: Record<string, string> = {}
  if (typeof doc.orderId !== 'string' || !doc.orderId.trim()) details.orderId = 'Which order is going out?'
  if (!isNum(doc.expectedVersion) || doc.expectedVersion < 0) details.expectedVersion = 'The order version you read is required.'
  if (typeof doc.vehicle !== 'string' || !doc.vehicle.trim()) details.vehicle = 'Which vehicle is carrying it?'
  if (!Array.isArray(doc.lines) || !doc.lines.length) details.lines = 'A dispatch needs at least one line.'
  const lines: DispatchLineInput[] = []
  ;(Array.isArray(doc.lines) ? doc.lines : []).forEach((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>
    const why = (msg: string) => {
      if (!details[`lines.${i}`]) details[`lines.${i}`] = msg
    }
    if (typeof l.sku !== 'string' || !l.sku.trim()) return why('Which SKU is on this line?')
    if (typeof l.lot !== 'string' || !l.lot.trim()) return why('Which lot does it come from?')
    if (!isNum(l.qty) || l.qty <= 0) return why('Quantity must be greater than zero.')
    if (l.packaging !== 'BOXED' && l.packaging !== 'LOOSE') return why('Every line goes out BOXED or LOOSE.')
    if (l.packaging === 'BOXED' && isNum(l.cartons) && l.cartons < 0) return why('Carton count cannot be negative.')
    lines.push({
      sku: l.sku,
      lot: l.lot,
      ...(typeof l.location === 'string' && l.location ? { location: l.location } : {}),
      ...(typeof l.expiry === 'string' && l.expiry ? { expiry: l.expiry } : {}),
      qty: l.qty,
      packaging: l.packaging,
      ...(typeof l.cartonItemId === 'string' && l.cartonItemId ? { cartonItemId: l.cartonItemId } : {}),
      ...(isNum(l.cartons) ? { cartons: l.cartons } : {}),
    })
  })
  if (Object.keys(details).length) throw new DomainError(422, 'The dispatch request is not valid.', 'invalid_dispatch', details)
  return { ...doc, lines } as unknown as DispatchConfirmRequest
}
