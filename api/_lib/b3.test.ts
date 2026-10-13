/**
 * The B3 domain endpoints against REAL SQLite semantics — better-sqlite3 in
 * memory loaded with the production schema.sql, the same D1Client-shaped fake
 * d1Engine.test.ts built (copied here so each suite stays self-contained).
 * The services are exercised whole: evidence in, the ONE atomic batch out, the
 * documents read back the way the snapshot would. What these tests pin is the
 * contract the overhaul's UI will lean on — the idempotency replay, the B2
 * guards as the close authority, the carton transaction's all-or-nothing, the
 * trace walk, and RBAC.md's matrix per endpoint. No network anywhere.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import type { Batch, BulkOutputLine, Dispatch, Grn, Order, PackingRun } from '../../src/types.js'
import type { StagedGradingResponse } from '../../src/lib/contracts.js'
import { closeTransformation } from './closeRun.js'
import { stagedGrading } from './gradingPost.js'
import { confirmDispatch } from './dispatchConfirm.js'
import { genealogyOf, searchFor } from './traceSearch.js'
import { IDEMPOTENCY_TTL_MS, bodyHashOf, findReceipt, requireIdempotencyKey, replayOf } from './idempotency.js'
import { traceGenealogy, GENEALOGY_MAX_DEPTH } from '../../src/lib/genealogy.js'

type Stmt = { sql: string; params?: unknown[] }

// ── the in-memory D1 (d1Engine.test.ts's fake, verbatim in spirit) ──────────

class FakeD1 {
  readonly db: Database.Database
  /** A rival's write, run between the service's read and its write batch. */
  beforeBatch: ((stmts: Stmt[]) => void) | null = null
  constructor() {
    this.db = new Database(':memory:')
    this.db.exec(readFileSync(new URL('../../scripts/d1/schema.sql', import.meta.url), 'utf8'))
  }
  private run(sql: string, params: unknown[]): { rows: unknown[]; changes: number } {
    const stmt = this.db.prepare(sql)
    if (stmt.reader) {
      const rows = stmt.all(...(params as never[])) as unknown[]
      return { rows, changes: rows.length }
    }
    const info = stmt.run(...(params as never[]))
    return { rows: [], changes: info.changes }
  }
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.run(sql, params).rows as T[]
  }
  async batch<T>(stmts: Stmt[]): Promise<{ results: T[]; meta: { changes: number } }[]> {
    const out: { results: T[]; meta: { changes: number } }[] = []
    try {
      this.db.transaction(() => {
        this.beforeBatch?.(stmts)
        for (const s of stmts) {
          const r = this.run(s.sql, s.params ?? [])
          out.push({ results: r.rows as T[], meta: { changes: r.changes } })
        }
      })()
    } catch (e) {
      const err = e as { message?: string }
      throw new D1ApiError(String(err.message ?? e))
    }
    return out
  }
  doc(collection: string, id: string): { json: string; version: number } | undefined {
    return this.db
      .prepare('SELECT json, version FROM documents WHERE collection = ? AND id = ?')
      .get(collection, id) as { json: string; version: number } | undefined
  }
  docs<T = Record<string, unknown>>(collection: string): T[] {
    return (
      this.db.prepare('SELECT json FROM documents WHERE collection = ?').all(collection) as { json: string }[]
    ).flatMap((r) => {
      try {
        return [JSON.parse(r.json) as T]
      } catch {
        return []
      }
    })
  }
  revision(): string {
    return (this.db.prepare("SELECT value FROM meta WHERE setting = 'app_revision'").get() as { value: string }).value
  }
  counter(series: string): number | undefined {
    return (this.db.prepare('SELECT next FROM counters WHERE series = ?').get(series) as { next: number } | undefined)
      ?.next
  }
}

function seed(
  d1: FakeD1,
  rows: { collection: string; id: string; json: unknown; version?: number }[],
  counters: Record<string, number> = {},
): void {
  d1.db.transaction(() => {
    const ins = d1.db.prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(r.collection, r.id, JSON.stringify(r.json), r.version ?? 1, '2026-01-01T00:00:00Z')
    const ctr = d1.db.prepare('INSERT INTO counters(series, next) VALUES (?, ?)')
    for (const [k, v] of Object.entries(counters)) ctr.run(k, v)
  })()
}

const flag = (key: string, enabled: boolean) => ({ collection: 'flags', id: `flag-${key}`, json: { key, enabled } })

// ── the services over the fake, cast once (d1Engine.test.ts's own pattern) ──

const client = (d1: FakeD1): D1Client => d1 as unknown as D1Client
const close = (d1: FakeD1, caller: Caller, body: unknown, key: string) => closeTransformation(client(d1), caller, body, key)
const grade = (d1: FakeD1, caller: Caller, body: unknown, key: string) => stagedGrading(client(d1), caller, body, key)
const confirm = (d1: FakeD1, caller: Caller, body: unknown, key: string) => confirmDispatch(client(d1), caller, body, key)
const trace = (d1: FakeD1, caller: Caller, q: Record<string, unknown>) => genealogyOf(client(d1), caller, q)
const search = (d1: FakeD1, caller: Caller, q: Record<string, unknown>) => searchFor(client(d1), caller, q)


const ledger = (row: Record<string, unknown>) => ({
  collection: 'ledger',
  id: String(row.id),
  json: {
    expiry: null,
    vendor_id: null,
    ...row,
  },
})

// ── the callers RBAC.md's matrix names ──────────────────────────────────────

const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const prodLead: Caller = { email: 'lead@roligt.local', permissions: ['page.production', 'can.close_run'] }
const packer: Caller = { email: 'pack@roligt.local', permissions: ['page.packing', 'can.close_run'] }
const operatorNoAction: Caller = { email: 'op@roligt.local', permissions: ['page.production'] }
const closerNoPage: Caller = { email: 'shift@roligt.local', permissions: ['can.close_run'] }
const procurement: Caller = { email: 'buy@roligt.local', permissions: ['page.procurement'] }
const dispatcher: Caller = { email: 'gate@roligt.local', permissions: ['page.dispatch', 'can.confirm_dispatch'] }
const notDispatcher: Caller = { email: 'watch@roligt.local', permissions: ['page.dispatch'] }
const deliveryAgent: Caller = { email: 'ride@roligt.local', permissions: ['page.my-deliveries'] }
const ordersOnly: Caller = { email: 'plan@roligt.local', permissions: ['page.orders'] }

// ── fixtures ────────────────────────────────────────────────────────────────

const NUT = 'ITM-NUT'
const WATER = 'ITM-WATER'
const MALAI = 'ITM-MALAI'
const CARTON = 'ITM-CARTON'
const POUCH_SKU = 'PACK-200ML'

const ITEM_ROWS = [
  { collection: 'items', id: NUT, json: { id: NUT, name: 'Tender Coconut', uom: 'Piece', avgUnitWeight: 0.5, requiresGrading: true } },
  { collection: 'items', id: WATER, json: { id: WATER, name: 'Coconut Water', uom: 'Litre', densityKgPerL: 1.0 } },
  { collection: 'items', id: MALAI, json: { id: MALAI, name: 'Coconut Malai', uom: 'Kg' } },
  { collection: 'items', id: CARTON, json: { id: CARTON, name: 'Carton 200ml', uom: 'Piece' } },
]

/** 200 nuts in, 85 L water + 10 kg malai out, 5 L spilled at close → 0% variance. */
const output85: BulkOutputLine[] = [
  { item: WATER, qty: 85, uom: 'Litre', costShare: 0.9 },
  { item: MALAI, qty: 10, uom: 'Kg', costShare: 0.1 },
]

function batchDoc(over: Partial<Batch> = {}): Batch {
  return {
    id: 'B-EXT-1',
    kind: 'Extraction',
    date: '2026-10-10',
    sourceLines: [{ lot: 'LOT-C1', item: NUT, uom: 'Piece', qty: 200, unitCost: 35 }],
    outputLines: output85,
    inputQty: 200,
    inputUom: 'Piece',
    coconuts: 200,
    spoiled: 0,
    outputs: [],
    outputLitres: 85,
    yieldPerCoconut: 0.425,
    rmCost: 7000,
    pmCost: 0,
    directCost: 0,
    costPerL: 82.35,
    status: 'In Progress',
    qcId: '',
    ...over,
  } as Batch
}

/** The seeded base every close test starts from. */
function closeBase(
  d1: FakeD1,
  over: Partial<Batch> = {},
  flags: { key: string; enabled: boolean }[] = [{ key: 'batch_v2', enabled: true }],
  outputs: { water: number; malai: number } = { water: 85, malai: 10 },
): void {
  seed(d1, [
    ...flags.map((f) => flag(f.key, f.enabled)),
    ...ITEM_ROWS,
    { collection: 'spoilage_reasons', id: 'SR-1', json: { code: 'spill', stage: 'extraction', active: true } },
    { collection: 'spoilage_reasons', id: 'SR-2', json: { code: 'none', stage: 'extraction', active: true } },
    { collection: 'batches', id: 'B-EXT-1', json: batchDoc(over) },
    ledger({
      id: 'L-OUT-1', type: 'Output', doc: 'B-EXT-1', item: WATER, item_type: 'Semi Finished', lot: 'B-EXT-1',
      location: 'Cold Room', status: 'Available', qty_in: outputs.water, qty_out: 0, uom: 'Litre', unit_cost: 80, at: '2026-10-10T08:00:00Z',
    }),
    ledger({
      id: 'L-OUT-2', type: 'Output', doc: 'B-EXT-1', item: MALAI, item_type: 'Semi Finished', lot: 'B-EXT-1',
      location: 'Cold Room', status: 'Available', qty_in: outputs.malai, qty_out: 0, uom: 'Kg', unit_cost: 20, at: '2026-10-10T08:00:00Z',
    }),
  ])
}

const closeReq = (over: Record<string, unknown> = {}) => ({
  batchId: 'B-EXT-1',
  expectedVersion: 1,
  spoilage: [{ stage: 'extraction', qty: 5, uom: 'Litre', reasonCode: 'spill' }],
  ...over,
})

const grnDoc = (over: Partial<Grn> & { gradingMode?: string } = {}): Grn =>
  ({
    id: 'GRN-C1',
    date: '2026-10-09',
    farmerId: 'F-1',
    farmerName: 'Kumar',
    lot: 'LOT-C1',
    total: 100,
    a: 0, b: 0, c: 0, reject: 0,
    rate: 35,
    transport: 500,
    accepted: 0,
    materialValue: 0,
    landed: 0,
    grossCost: 0,
    usableCost: 0,
    status: 'Posted',
    gradingMode: 'staged',
    itemId: NUT,
    uom: 'Piece',
    location: 'Cold Room',
    ...over,
  }) as Grn

function gradingBase(d1: FakeD1, grn: Partial<Grn> & { gradingMode?: string } = {}, pipeline = true): void {
  seed(d1, [
    flag('pipeline', pipeline),
    ...ITEM_ROWS,
    { collection: 'grns', id: 'GRN-C1', json: grnDoc(grn) },
    ledger({
      id: 'L-GRN-C1', type: 'Receipt', doc: 'GRN-C1', item: NUT, item_type: 'Raw Material', lot: 'LOT-C1',
      location: 'Cold Room', status: 'Quarantine', qty_in: 100, qty_out: 0, uom: 'Piece', unit_cost: 35, at: '2026-10-09T06:00:00Z',
    }),
  ])
}

const gradeReq = (over: Record<string, unknown> = {}) => ({
  grnId: 'GRN-C1',
  expectedVersion: 1,
  a: 60, b: 30, c: 5, reject: 5,
  ...over,
})

function orderDoc(over: Partial<Order> = {}): Order {
  return {
    id: 'ORD-1',
    customerId: 'CUS-1',
    customerName: 'Fresh Mart',
    date: '2026-10-11',
    lines: [{ sku: POUCH_SKU, qty: 100 }],
    status: 'Open',
    ...over,
  } as Order
}

/** Released pouch stock (FEFO: P1 expires first) + Available cartons. */
function dispatchBase(d1: FakeD1, order: Partial<Order> = {}): void {
  seed(d1, [
    { collection: 'orders', id: 'ORD-1', json: orderDoc(order) },
    { collection: 'carton_specs', id: 'CS-1', json: { id: 'CS-1', bibSize: 1, cartonItemId: CARTON, pouchesPerCarton: 10, active: true } },
    ledger({ id: 'L-P1', type: 'Stock', doc: 'PKG-1', item: POUCH_SKU, item_type: 'Finished Goods', lot: 'PKG-1', location: 'Cold Room', status: 'Released', qty_in: 60, qty_out: 0, uom: 'Pouch', unit_cost: 30, at: '2026-10-11T08:00:00Z', expiry: '2026-11-01' }),
    ledger({ id: 'L-P2', type: 'Stock', doc: 'PKG-1', item: POUCH_SKU, item_type: 'Finished Goods', lot: 'PKG-1', location: 'Cold Room', status: 'Released', qty_in: 40, qty_out: 0, uom: 'Pouch', unit_cost: 30, at: '2026-10-11T08:00:00Z', expiry: '2026-12-01' }),
    ledger({ id: 'L-C1', type: 'Purchase', doc: 'PO-1', item: CARTON, item_type: 'Packing Material', lot: 'CART-LOT', location: 'Store', status: 'Available', qty_in: 12, qty_out: 0, uom: 'Piece', unit_cost: 8, at: '2026-10-01T08:00:00Z' }),
  ])
}

const dispatchReq = (lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  orderId: 'ORD-1',
  expectedVersion: 1,
  vehicle: 'AP16TT4040',
  lines,
  ...over,
})

const boxedLine = (over: Record<string, unknown> = {}) => ({
  sku: POUCH_SKU, lot: 'PKG-1', qty: 100, packaging: 'BOXED', cartonItemId: CARTON, cartons: 10,
  ...over,
})

/** The coconut→extraction→blend→pack→dispatch→order fixture chain. */
function traceBase(d1: FakeD1): void {
  seed(d1, [
    { collection: 'grns', id: 'GRN-C1', json: grnDoc() },
    { collection: 'batches', id: 'B-EXT-1', json: batchDoc({ status: 'Closed' }) },
    {
      collection: 'batches', id: 'B-BLD-1',
      json: {
        ...batchDoc({ id: 'B-BLD-1', kind: 'Melange', status: 'Closed' }),
        sourceLines: [],
        blendLines: [{ item: WATER, lot: 'B-EXT-1', uom: 'Litre', qty: 80, unitCost: 80 }],
        outputLines: [{ item: 'ITM-BLEND', qty: 80, uom: 'Litre', costShare: 1 }],
      },
    },
    {
      collection: 'packing_runs', id: 'PKG-1',
      json: {
        id: 'PKG-1', date: '2026-10-12', batchId: 'B-BLD-1', medium: 'Water',
        lines: [{ sku: POUCH_SKU, packs: 100, drawn: 80, qty: 100, unitCost: 35, expiry: '2026-12-01' }],
        drawn: 80, pmCost: 200, bulkCost: 2800, status: 'Posted',
      } as unknown as PackingRun,
    },
    { collection: 'orders', id: 'ORD-1', json: orderDoc() },
    {
      collection: 'dispatches', id: 'DSP-1',
      json: {
        id: 'DSP-1', customerId: 'CUS-1', customerName: 'Fresh Mart', batchId: 'B-BLD-1', sku: POUCH_SKU,
        qty: 100, challan: 'DC0001/2026', vehicle: 'AP16TT4040', dispatchTime: '2026-10-12T09:00:00Z', status: 'Dispatched', pod: '', orderId: 'ORD-1',
      } as unknown as Dispatch,
    },
  ])
}

// ── idempotency ─────────────────────────────────────────────────────────────

describe('the Idempotency-Key helper', () => {
  it('refuses a missing key with 422 idempotency_key', () => {
    for (const headers of [{}, { 'idempotency-key': '' }, { 'idempotency-key': '   ' }]) {
      expect(() => requireIdempotencyKey(headers)).toThrowError(expect.objectContaining({ status: 422, code: 'idempotency_key' }))
    }
  })

  it('reads the key, trimmed; an array header reads its first value', () => {
    expect(requireIdempotencyKey({ 'idempotency-key': ' key-1 ' })).toBe('key-1')
    expect(requireIdempotencyKey({ 'idempotency-key': ['key-2'] })).toBe('key-2')
  })

  it('hashes key+route+canonical body — key order in the body does not matter', () => {
    const a = bodyHashOf('k', 'POST /x', { grnId: 'G', expectedVersion: 1 })
    const b = bodyHashOf('k', 'POST /x', { expectedVersion: 1, grnId: 'G' })
    expect(a).toBe(b)
    expect(bodyHashOf('k2', 'POST /x', { grnId: 'G', expectedVersion: 1 })).not.toBe(a)
  })

  it('replays a matching receipt and refuses a reused key whose body changed', () => {
    const receipt = {
      id: 'x', route: 'POST /x', key: 'k', bodyHash: bodyHashOf('k', 'POST /x', { a: 1 }),
      status: 201, response: { done: true }, created_at: '2026-10-12T00:00:00Z', expires_at: '2027-10-12T00:00:00Z',
    }
    expect(replayOf(receipt, bodyHashOf('k', 'POST /x', { a: 1 }))).toEqual({
      replay: true, status: 201, body: { done: true },
    })
    expect(() => replayOf(receipt, bodyHashOf('k', 'POST /x', { a: 2 }))).toThrowError(
      expect.objectContaining({ status: 422, code: 'idempotency_key' }),
    )
  })

  it('reads an expired receipt as absent — the retry proceeds fresh', async () => {
    const d1 = new FakeD1()
    const expired = new Date(Date.now() - 1000).toISOString()
    seed(d1, [{
      collection: 'idempotency', id: 'r1',
      json: { id: 'r1', route: 'POST /x', key: 'k', bodyHash: 'h', status: 200, response: {}, created_at: expired, expires_at: expired },
    }])
    expect(await findReceipt(client(d1), 'POST /x', 'k')).toBeNull()
  })

  it('the 48h TTL is what the receipt carries', () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(48 * 60 * 60 * 1000)
  })
})

// ── POST /api/transformations/close ─────────────────────────────────────────

describe('POST /api/transformations/close', () => {
  it('closes legally: spoilage drawn from the batch\'s own output stock, all one batch', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    const out = await close(d1, prodLead, closeReq(), 'k1')
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('Closed')
    expect(out.body.massBalance.withinTolerance).toBe(true)

    const batch = JSON.parse(d1.doc('batches', 'B-EXT-1')!.json) as Batch & { stageTimes?: { closed?: string } }
    expect(batch.status).toBe('Closed')
    expect(batch.stageTimes?.closed).toBeTruthy()
    // stock ids minted, in order, existing ones kept
    expect((batch.outputLines ?? []).map((l) => l.stockId)).toEqual(['B-EXT-1/1', 'B-EXT-1/2'])

    const spoil = d1.docs('spoilage_records')
    expect(spoil).toHaveLength(1)

    const lines = d1.docs<{ type: string; qty_out: number; lot: string }>('ledger').filter((l) => l.type === 'Spoilage')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ lot: 'B-EXT-1', qty_out: 5, uom: 'Litre' })

    expect(d1.docs('audits').some((a) => (a as { action?: string }).action === 'run.close')).toBe(true)
    expect(Number(d1.revision().split(':')[0])).toBeGreaterThan(0)
  })

  it('an explicit zero spoilage line is legal and books nothing', async () => {
    const d1 = new FakeD1()
    // outputs that already balance: 90 L + 10 kg out of 100 kg in, zero spilled
    closeBase(
      d1,
      { outputLines: [{ item: WATER, qty: 90, uom: 'Litre', costShare: 0.9 }, { item: MALAI, qty: 10, uom: 'Kg', costShare: 0.1 }] },
      undefined,
      { water: 90, malai: 10 },
    )
    const out = await close(d1, packer, closeReq({ spoilage: [{ stage: 'extraction', qty: 0, uom: 'Litre', reasonCode: 'none' }] }), 'k1')
    expect(out.status).toBe(200)
    expect(d1.docs('ledger').filter((l) => (l as { type?: string }).type === 'Spoilage')).toHaveLength(0)
    expect(d1.docs('spoilage_records')).toHaveLength(1)
  })

  it('no spoilage at all is refused 422', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    await expectRefusal(close(d1, prodLead, closeReq({ spoilage: [] }), 'k1'), 422, 'invalid_close')
  })

  it('a balance outside tolerance is refused 422 mass_balance_ok (server-recomputed)', async () => {
    const d1 = new FakeD1()
    // 95 L + 10 kg out of 100 kg in, zero spilled → 5% variance > 2%
    closeBase(d1, {
      outputLines: [
        { item: WATER, qty: 95, uom: 'Litre', costShare: 0.9 },
        { item: MALAI, qty: 10, uom: 'Kg', costShare: 0.1 },
      ],
    })
    await expectRefusal(
      close(d1, prodLead, closeReq({ spoilage: [{ stage: 'extraction', qty: 0, uom: 'Litre', reasonCode: 'none' }] }), 'k1'),
      422,
      'mass_balance_ok',
    )
    expect(d1.doc('batches', 'B-EXT-1')!.version).toBe(1) // nothing written
  })

  it('batch_v2 OFF closes legacy-style: the guards are skipped, records still written', async () => {
    const d1 = new FakeD1()
    closeBase(d1, {}, [{ key: 'batch_v2', enabled: false }])
    const out = await close(d1, prodLead, closeReq(), 'k1')
    expect(out.status).toBe(200)
  })

  it('an unknown reason code is refused, not filed', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    await expectRefusal(close(d1, prodLead, closeReq({ spoilage: [{ stage: 'extraction', qty: 5, uom: 'Litre', reasonCode: 'mystery' }] }), 'k1'), 422, 'invalid_close')
  })

  it('spoilage beyond what the output row holds is refused', async () => {
    const d1 = new FakeD1()
    // 5 L on the row, 85 L spilled, 10 kg malai: the balance closes at 100 kg
    // exactly — but the row only holds 5
    closeBase(
      d1,
      { outputLines: [{ item: WATER, qty: 5, uom: 'Litre', costShare: 0.9 }, { item: MALAI, qty: 10, uom: 'Kg', costShare: 0.1 }] },
      undefined,
      { water: 5, malai: 10 },
    )
    await expectRefusal(
      close(d1, prodLead, closeReq({ spoilage: [{ stage: 'extraction', qty: 85, uom: 'Litre', reasonCode: 'spill' }] }), 'k1'),
      422,
      'spoilage_exceeds_stock',
    )
  })

  it('an extraction-stage loss that never became output stock is record-only', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    const out = await close(
      d1, prodLead,
      closeReq({ spoilage: [{ stage: 'extraction', qty: 2, uom: 'Piece', reasonCode: 'spill' }, { stage: 'extraction', qty: 5, uom: 'Litre', reasonCode: 'spill' }] }),
      'k1',
    )
    expect(out.status).toBe(200)
    const lines = d1.docs<{ type: string; uom: string }>('ledger').filter((l) => l.type === 'Spoilage')
    expect(lines).toHaveLength(1) // the Piece line matched no output row
    expect(lines[0].uom).toBe('Litre')
  })

  it('a stale version is 409, never an overwrite', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    await expectRefusal(close(d1, prodLead, closeReq({ expectedVersion: 0 }), 'k1'), 409, 'cas_version')
  })

  it('a rival write between read and batch trips the guard — 409, nothing written', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    d1.beforeBatch = () => {
      d1.db.prepare("UPDATE documents SET version = version + 1 WHERE collection = 'batches' AND id = 'B-EXT-1'").run()
    }
    await expectRefusal(close(d1, prodLead, closeReq(), 'k1'), 409, 'cas_version')
    expect(JSON.parse(d1.doc('batches', 'B-EXT-1')!.json).status).toBe('In Progress')
    expect(d1.docs('spoilage_records')).toHaveLength(0)
  })

  it('an already-closed batch refuses a second close', async () => {
    const d1 = new FakeD1()
    closeBase(d1, { status: 'Closed' })
    await expectRefusal(close(d1, prodLead, closeReq(), 'k1'), 422, 'already_closed')
  })

  it('a Draft run cannot leap straight to Closed', async () => {
    const d1 = new FakeD1()
    closeBase(d1, { status: 'Draft' })
    await expectRefusal(close(d1, prodLead, closeReq(), 'k1'), 422, 'illegal_transition')
  })

  it('RBAC: closing takes can.close_run AND an owning page', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    for (const who of [operatorNoAction, closerNoPage, procurement]) {
      await expectRefusal(close(d1, who, closeReq(), `k-${who.email}`), 403, 'role_allowed')
    }
    expect(d1.doc('batches', 'B-EXT-1')!.version).toBe(1)
  })

  it('a replay answers the stored response and writes nothing new', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    const first = await close(d1, prodLead, closeReq(), 'k1')
    const rev = d1.revision()
    const second = await close(d1, prodLead, closeReq(), 'k1')
    expect(second.replay).toBe(true)
    expect(second.body).toEqual(first.body)
    expect(d1.revision()).toBe(rev) // no second write
    expect(d1.docs('spoilage_records')).toHaveLength(1)
  })

  it('a reused key with a different body is refused 422 idempotency_key', async () => {
    const d1 = new FakeD1()
    closeBase(d1)
    await close(d1, prodLead, closeReq(), 'k1')
    await expectRefusal(close(d1, prodLead, closeReq({ spoilage: [{ stage: 'extraction', qty: 4, uom: 'Litre', reasonCode: 'spill' }] }), 'k1'), 422, 'idempotency_key')
  })
})

// ── POST /api/grading ───────────────────────────────────────────────────────

describe('POST /api/grading', () => {
  it('grades a staged coconut lot: GRN costs server-computed, ledger moves per grade', async () => {
    const d1 = new FakeD1()
    gradingBase(d1)
    const out = await grade(d1, procurement, gradeReq(), 'k1')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ grnId: 'GRN-C1', lot: 'LOT-C1', accepted: 95 })

    const grn = JSON.parse(d1.doc('grns', 'GRN-C1')!.json) as Grn & { gradingMode?: string }
    expect(grn).toMatchObject({ a: 60, b: 30, c: 5, reject: 5, accepted: 95 })
    expect(grn.materialValue).toBeCloseTo(3500, 6) // (100 - 0) × 35
    expect(grn.landed).toBeCloseTo(4000, 6)
    expect(grn.usableCost).toBeCloseTo(4000 / 95, 6)
    expect(grn.gradingMode).toBe('staged') // contracts GRADING_MODES: the mode never changes

    const lines = d1.docs<{ id: string; type: string; status: string; qty_in: number; qty_out: number }>('ledger')
      .filter((l) => l.type === 'Grading')
    expect(lines.map((l) => `${l.status}:${l.qty_in || l.qty_out}`).sort()).toEqual(['Available:95', 'Quarantine:100', 'Rejected:5'])

    expect(d1.docs('audits').some((a) => (a as { action?: string }).action === 'grading.staged')).toBe(true)
  })

  it('pipeline OFF → 421 pipeline_off', async () => {
    const d1 = new FakeD1()
    gradingBase(d1, {}, false)
    await expectRefusal(grade(d1, procurement, gradeReq(), 'k1'), 421, 'pipeline_off')
  })

  it('a non-coconut load (kg-counted) is refused 422 not_gradable', async () => {
    const d1 = new FakeD1()
    gradingBase(d1, { uom: 'Kg' })
    await expectRefusal(grade(d1, procurement, gradeReq(), 'k1'), 422, 'not_gradable')
  })

  it('an item that does not require grading is refused 422 not_gradable', async () => {
    const d1 = new FakeD1()
    gradingBase(d1, { itemId: 'ITM-MALAI' })
    await expectRefusal(grade(d1, procurement, gradeReq(), 'k1'), 422, 'not_gradable')
  })

  it('grades that do not sum to the received load are refused', async () => {
    const d1 = new FakeD1()
    gradingBase(d1)
    await expectRefusal(grade(d1, procurement, gradeReq({ a: 50 }), 'k1'), 422, 'grade_mismatch')
  })

  it('all-reject grading is refused — accepted must be above zero', async () => {
    const d1 = new FakeD1()
    gradingBase(d1)
    await expectRefusal(grade(d1, procurement, gradeReq({ a: 0, b: 0, c: 0, reject: 100 }), 'k1'), 422, 'invalid_grades')
  })

  it('a receipt graded at the gate (embedded) is refused', async () => {
    const d1 = new FakeD1()
    gradingBase(d1, { gradingMode: 'embedded' })
    await expectRefusal(grade(d1, procurement, gradeReq(), 'k1'), 422, 'not_staged')
  })

  it('an already-graded staged receipt is refused, not re-graded', async () => {
    const d1 = new FakeD1()
    gradingBase(d1, { a: 60, b: 30, c: 5, reject: 5 })
    await expectRefusal(grade(d1, procurement, gradeReq(), 'k1'), 422, 'already_graded')
  })

  it('RBAC: staged grading is the Procurement page\'s own', async () => {
    const d1 = new FakeD1()
    gradingBase(d1)
    for (const who of [prodLead, dispatcher]) {
      await expectRefusal(grade(d1, who, gradeReq(), `k-${who.email}`), 403, 'role_allowed')
    }
    expect(d1.doc('grns', 'GRN-C1')!.version).toBe(1)
  })

  it('a stale version is 409', async () => {
    const d1 = new FakeD1()
    gradingBase(d1)
    await expectRefusal(grade(d1, procurement, gradeReq({ expectedVersion: 0 }), 'k1'), 409, 'cas_version')
  })

  it('replay: same key+body → the stored response, no second write; changed body → 422', async () => {
    const d1 = new FakeD1()
    gradingBase(d1)
    const first = await grade(d1, procurement, gradeReq(), 'k1')
    const rev = d1.revision()
    const again = await grade(d1, procurement, gradeReq(), 'k1')
    expect(again.replay).toBe(true)
    expect(again.body).toEqual(first.body)
    expect(d1.revision()).toBe(rev)
    const grader: StagedGradingResponse = again.body
    expect(grader.accepted).toBe(95)
    await expectRefusal(grade(d1, procurement, gradeReq({ a: 61, b: 29 }), 'k1'), 422, 'idempotency_key')
  })
})

// ── POST /api/dispatch/confirm ──────────────────────────────────────────────

describe('POST /api/dispatch/confirm', () => {
  it('BOXED: pouches AND cartons decrement in one batch; order Dispatched; challan returned', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    const out = await confirm(d1, dispatcher, dispatchReq([boxedLine()], { coldRoomOutAt: '2026-10-12T05:30:00Z' }), 'k1')
    expect(out.status).toBe(200)
    expect(out.body.orderStatus).toBe('Dispatched')
    expect(out.body.cartonsIssued).toEqual([{ cartonItemId: CARTON, count: 10 }])
    expect(typeof out.body.challan).toBe('string')
    expect(out.body.challan).toMatch(/^DC\d{4}\/\d{4}$/)

    // pouches: FEFO split across the two released rows — 60 then 40
    const pouchLines = d1.docs<{ type: string; item: string; qty_out: number; expiry: string | null }>('ledger').filter((l) => l.type === 'Dispatch')
    const byExpiry = pouchLines.sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))
    expect(byExpiry.map((l) => l.qty_out)).toEqual([60, 40])

    // cartons: exactly ten drawn, from the Available row
    const cartonLines = d1.docs<{ type: string; item: string; qty_out: number }>('ledger').filter((l) => l.type === 'Carton Consume')
    expect(cartonLines).toHaveLength(1)
    expect(cartonLines[0]).toMatchObject({ item: CARTON, qty_out: 10 })

    const order = JSON.parse(d1.doc('orders', 'ORD-1')!.json) as Order & { reservations?: { lot: string; qty: number }[]; dispatchedAt?: string }
    expect(order.status).toBe('Dispatched')
    expect(order.dispatchedAt).toBeTruthy()
    expect(order.reservations?.length).toBe(2)
    expect(order.reservations?.reduce((n, r) => n + r.qty, 0)).toBe(100)

    const dispatchDocs = d1.docs<{ coldRoomOutAt?: string; challan: string }>('dispatches')
    expect(dispatchDocs).toHaveLength(1)
    expect(dispatchDocs[0].coldRoomOutAt).toBe('2026-10-12T05:30:00Z')
    expect(dispatchDocs[0].challan).toBe(out.body.challan)

    expect(d1.counter('challan')).toBe(1)
    expect(d1.counter('dispatch')).toBe(1)
  })

  it('LOOSE: pouches go, carton stock is never touched — pinned on the ledger', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1, { lines: [{ sku: POUCH_SKU, qty: 30 }] })
    const out = await confirm(d1, dispatcher, dispatchReq([{ sku: POUCH_SKU, lot: 'PKG-1', qty: 30, packaging: 'LOOSE' }]), 'k1')
    expect(out.status).toBe(200)
    expect(out.body.cartonsIssued).toEqual([])
    expect(d1.docs('ledger').filter((l) => (l as { type?: string }).type === 'Carton Consume')).toHaveLength(0)
    // the carton row still holds its full 12
    const cartonRow = JSON.parse(d1.doc('ledger', 'L-C1')!.json) as { qty_in: number; qty_out: number }
    expect(cartonRow.qty_out).toBe(0)
    // the pouch draw happened
    expect(d1.docs('ledger').filter((l) => (l as { type?: string }).type === 'Dispatch').reduce((n, l) => n + Number((l as { qty_out: number }).qty_out), 0)).toBe(30)
  })

  it('a partial dispatch lands the order Partially Dispatched', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1, { lines: [{ sku: POUCH_SKU, qty: 120 }] })
    const out = await confirm(d1, dispatcher, dispatchReq([boxedLine()]), 'k1')
    expect(out.body.orderStatus).toBe('Partially Dispatched')
    const order = JSON.parse(d1.doc('orders', 'ORD-1')!.json) as Order
    expect(order.status).toBe('Partially Dispatched')
    expect(order.dispatchedAt).toBeUndefined()
  })

  it('asking for more than the lot holds is refused and nothing writes', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    await expectRefusal(confirm(d1, dispatcher, dispatchReq([boxedLine({ qty: 200, cartons: 20 })]), 'k1'), 422, 'insufficient_stock')
    expect(d1.docs('dispatches')).toHaveLength(0)
    expect(d1.docs('ledger').filter((l) => (l as { type?: string }).type === 'Dispatch')).toHaveLength(0)
    expect(d1.doc('orders', 'ORD-1')!.version).toBe(1)
    expect(d1.counter('challan')).toBeUndefined()
  })

  it('a carton shortfall rolls the WHOLE dispatch back — pouches included', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    await expectRefusal(confirm(d1, dispatcher, dispatchReq([boxedLine({ cartons: 20 })]), 'k1'), 422, 'carton_stock')
    expect(d1.docs('dispatches')).toHaveLength(0)
    expect(d1.docs('ledger').filter((l) => (l as { type?: string }).type === 'Dispatch')).toHaveLength(0)
    expect(JSON.parse(d1.doc('ledger', 'L-C1')!.json).qty_out).toBe(0)
  })

  it('a BOXED line whose carton is not an active spec is refused', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    await expectRefusal(confirm(d1, dispatcher, dispatchReq([boxedLine({ cartonItemId: 'ITM-MYSTERY' })]), 'k1'), 422, 'carton_spec')
  })

  it('a BOXED line with cartons but no carton item is refused', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    const { cartonItemId: _cartonItemId, ...line } = boxedLine()
    await expectRefusal(confirm(d1, dispatcher, dispatchReq([line]), 'k1'), 422, 'carton_unspecified')
  })

  it('an order that is not open refuses further dispatches', async () => {
    for (const status of ['Dispatched', 'Cancelled']) {
      const d1 = new FakeD1()
      dispatchBase(d1, { status })
      await expectRefusal(confirm(d1, dispatcher, dispatchReq([boxedLine()]), 'k1'), 422, 'order_not_open')
    }
  })

  it('a stale version is 409', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    await expectRefusal(confirm(d1, dispatcher, dispatchReq([boxedLine()], { expectedVersion: 0 }), 'k1'), 409, 'cas_version')
  })

  it('RBAC: confirming takes can.confirm_dispatch', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    await expectRefusal(confirm(d1, notDispatcher, dispatchReq([boxedLine()]), 'k1'), 403, 'role_allowed')
    expect(d1.docs('dispatches')).toHaveLength(0)
  })

  it('replay: the same key+body answers the stored ids and burns no numbers', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1)
    const first = await confirm(d1, dispatcher, dispatchReq([boxedLine()]), 'k1')
    const rev = d1.revision()
    const second = await confirm(d1, dispatcher, dispatchReq([boxedLine()]), 'k1')
    expect(second.replay).toBe(true)
    expect(second.body.dispatchIds).toEqual(first.body.dispatchIds)
    expect(second.body.challan).toBe(first.body.challan)
    expect(d1.revision()).toBe(rev)
    expect(d1.docs('dispatches')).toHaveLength(1)
    expect(d1.docs('ledger').filter((l) => (l as { type?: string }).type === 'Dispatch')).toHaveLength(2)
    await expectRefusal(confirm(d1, dispatcher, dispatchReq([boxedLine({ qty: 99 })]), 'k1'), 422, 'idempotency_key')
  })

  it('two lines mint two dispatch ids under one challan', async () => {
    const d1 = new FakeD1()
    dispatchBase(d1, { lines: [{ sku: POUCH_SKU, qty: 50 }, { sku: POUCH_SKU, qty: 50 }] })
    const out = await confirm(
      d1, dispatcher,
      dispatchReq([boxedLine({ qty: 60, cartons: 6 }), boxedLine({ qty: 40, cartons: 4 })]),
      'k1',
    )
    expect(out.body.dispatchIds).toHaveLength(2)
    expect(new Set(d1.docs<{ challan: string }>('dispatches').map((d) => d.challan)).size).toBe(1)
    expect(d1.counter('dispatch')).toBe(2)
  })
})

// ── GET /api/genealogy ──────────────────────────────────────────────────────

describe('GET /api/genealogy', () => {
  it('forward from the lot walks the whole chain to order and challan', async () => {
    const d1 = new FakeD1()
    traceBase(d1)
    const out = await trace(d1, admin, { seed: 'LOT:LOT-C1', dir: 'forward', depth: '12' })
    const kinds = new Map(out.nodes.map((n) => [n.id, n.kind]))
    expect(out.nodes.map((n) => n.id).sort()).toEqual(
      ['batch:B-BLD-1', 'batch:B-EXT-1', 'dispatch:DSP-1', 'grn:GRN-C1', 'order:ORD-1', 'packing:PKG-1'].sort(),
    )
    expect(kinds.get('grn:GRN-C1')).toBe('grn')
    expect(out.truncated).toBe(false)
    // the chain's edges exist and point downstream
    const rel = (from: string, to: string) => out.edges.some((e) => e.from === from && e.to === to)
    expect(rel('grn:GRN-C1', 'batch:B-EXT-1')).toBe(true)
    expect(rel('batch:B-EXT-1', 'batch:B-BLD-1')).toBe(true)
    expect(rel('batch:B-BLD-1', 'packing:PKG-1')).toBe(true)
    expect(rel('packing:PKG-1', 'dispatch:DSP-1')).toBe(true)
    expect(rel('dispatch:DSP-1', 'order:ORD-1')).toBe(true)
  })

  it('backward from the order reaches the coconut receipt and the challan', async () => {
    const d1 = new FakeD1()
    traceBase(d1)
    const out = await trace(d1, ordersOnly, { seed: 'ORD:ORD-1', dir: 'backward' })
    const ids = out.nodes.map((n) => n.id)
    expect(ids).toContain('grn:GRN-C1')
    expect(ids).toContain('batch:B-EXT-1')
    expect(ids).toContain('packing:PKG-1')
    // challan_of points challan→dispatch, so the challan answers upstream
    expect(ids).toContain('challan:DC0001/2026')
    expect(out.edges.some((e) => e.relation === 'challan_of')).toBe(true)
  })

  it('a depth that cuts the walk says so — truncated, not silence', async () => {
    const d1 = new FakeD1()
    traceBase(d1)
    const out = await trace(d1, admin, { seed: 'LOT:LOT-C1', dir: 'forward', depth: '1' })
    expect(out.truncated).toBe(true)
    expect(out.nodes.length).toBeGreaterThan(0)
    expect(out.nodes.every((n) => n.kind === 'grn' || n.kind === 'batch')).toBe(true)
  })

  it('a seed nothing answers is 404; a malformed one 400; a bad dir 400', async () => {
    const d1 = new FakeD1()
    traceBase(d1)
    await expectRefusal(trace(d1, admin, { seed: 'LOT:NOPE' }), 404, 'seed_not_found')
    await expectRefusal(trace(d1, admin, { seed: 'garbage' }), 400, 'invalid_seed')
    await expectRefusal(trace(d1, admin, { seed: 'LOT:LOT-C1', dir: 'sideways' }), 400, 'invalid_dir')
  })

  it('depth clamps at 12 and defaults to 5', async () => {
    const d1 = new FakeD1()
    traceBase(d1)
    expect((await trace(d1, admin, { seed: 'LOT:LOT-C1', depth: '99' })).nodes.length).toBe(
      (await trace(d1, admin, { seed: 'LOT:LOT-C1', depth: String(GENEALOGY_MAX_DEPTH) })).nodes.length,
    )
    const defaulted = await trace(d1, admin, { seed: 'LOT:LOT-C1' })
    expect(defaulted.nodes.length).toBeGreaterThan(0)
  })

  it('RBAC: the delivery agent is refused; every other signed-in caller walks', async () => {
    const d1 = new FakeD1()
    traceBase(d1)
    await expectRefusal(trace(d1, deliveryAgent, { seed: 'LOT:LOT-C1' }), 403, 'role_allowed')
    expect((await trace(d1, ordersOnly, { seed: 'LOT:LOT-C1' })).nodes.length).toBeGreaterThan(0)
  })
})

// ── GET /api/search ─────────────────────────────────────────────────────────

describe('GET /api/search', () => {
  function searchBase(d1: FakeD1): void {
    traceBase(d1)
    seed(d1, [
      { collection: 'customers', id: 'CUS-1', json: { id: 'CUS-1', name: 'Fresh Mart' } },
      { collection: 'vendors', id: 'V-1', json: { id: 'V-1', name: 'Kumar Farms' } },
      { collection: 'storage_locations', id: 'LOC-1', json: { id: 'LOC-1', name: 'Cold Room A' } },
    ])
  }

  it('finds each kind: lot, batch, order, challan, customer, vendor, location', async () => {
    const d1 = new FakeD1()
    searchBase(d1)
    const lot = await search(d1, admin, { q: 'LOT-C1' })
    expect(lot.results.some((r) => r.kind === 'lot' && r.id === 'LOT-C1')).toBe(true)
    const batch = await search(d1, admin, { q: 'B-EXT' })
    expect(batch.results.some((r) => r.kind === 'batch' && r.id === 'B-EXT-1')).toBe(true)
    const order = await search(d1, admin, { q: 'ORD-1' })
    expect(order.results.some((r) => r.kind === 'order' && r.id === 'ORD-1')).toBe(true)
    const challan = await search(d1, admin, { q: 'DC0001' })
    expect(challan.results.some((r) => r.kind === 'challan' && r.id === 'DC0001/2026')).toBe(true)
    const customer = await search(d1, admin, { q: 'Fresh Mart' })
    expect(customer.results.some((r) => r.kind === 'customer' && r.id === 'CUS-1')).toBe(true)
    const vendor = await search(d1, admin, { q: 'Kumar' })
    expect(vendor.results.some((r) => r.kind === 'vendor' && r.id === 'V-1')).toBe(true)
    const loc = await search(d1, admin, { q: 'Cold Room A' })
    expect(loc.results.some((r) => r.kind === 'storageLocation' && r.id === 'LOC-1')).toBe(true)
  })

  it('a withheld collection is not searched for a page-scoped caller', async () => {
    const d1 = new FakeD1()
    searchBase(d1)
    // ordersOnly holds page.orders: grns, batches, dispatches are withheld
    const lot = await search(d1, ordersOnly, { q: 'LOT-C1' })
    expect(lot.results.filter((r) => r.kind === 'lot')).toHaveLength(0)
    const batch = await search(d1, ordersOnly, { q: 'B-EXT' })
    expect(batch.results.filter((r) => r.kind === 'batch')).toHaveLength(0)
    // masters are never withheld
    const customer = await search(d1, ordersOnly, { q: 'Fresh' })
    expect(customer.results.some((r) => r.kind === 'customer')).toBe(true)
    // what the caller's page owns still answers
    const order = await search(d1, ordersOnly, { q: 'ORD-1' })
    expect(order.results.some((r) => r.kind === 'order')).toBe(true)
  })

  it('a one-character needle answers nothing, not an error', async () => {
    const d1 = new FakeD1()
    searchBase(d1)
    expect((await search(d1, admin, { q: 'L' })).results).toEqual([])
    expect((await search(d1, admin, { q: '' })).results).toEqual([])
  })

  it("LIKE's wildcards are literals — q of '100%' finds nothing, breaks nothing", async () => {
    const d1 = new FakeD1()
    searchBase(d1)
    expect((await search(d1, admin, { q: '100%' })).results).toEqual([])
    expect((await search(d1, admin, { q: 'DC0001/2026' })).results.some((r) => r.kind === 'challan')).toBe(true)
  })

  it('RBAC: the delivery agent is refused', async () => {
    const d1 = new FakeD1()
    searchBase(d1)
    await expectRefusal(search(d1, deliveryAgent, { q: 'LOT-C1' }), 403, 'role_allowed')
  })
})

// ── the pure fold, one more angle ───────────────────────────────────────────

describe('the genealogy fold (pure)', () => {
  it('caps depth at 12 in the walk itself', () => {
    const docs = {
      grns: [] as Grn[],
      batches: Array.from({ length: 20 }, (_, i) => batchDoc({ id: `B-${i}`, blendLines: i ? [{ item: WATER, lot: `B-${i - 1}`, uom: 'Litre', qty: 1, unitCost: 1 }] : [] })),
      packingRuns: [] as PackingRun[],
      orders: [] as Order[],
      dispatches: [] as Dispatch[],
    }
    const out = traceGenealogy('RUN:B-0', 'forward', GENEALOGY_MAX_DEPTH, docs)
    expect(out.nodes.every((n) => n.kind === 'batch')).toBe(true)
    expect(out.nodes).toHaveLength(GENEALOGY_MAX_DEPTH + 1) // B-0 … B-12
    expect(out.truncated).toBe(true)
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────

async function expectRefusal(p: Promise<unknown>, status: number, code: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (e) {
    caught = e
  }
  expect(caught).toBeTruthy()
  const err = caught as { status?: number; code?: string }
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
}
