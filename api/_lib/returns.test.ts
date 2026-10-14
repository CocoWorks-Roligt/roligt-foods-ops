import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { createReturn, decideReturn } from './returns.js'
import { DomainError } from './domain.js'

type Stmt = { sql: string; params?: unknown[] }

class FakeD1 {
  readonly db: Database.Database
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
  count(collection: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE collection = ?').get(collection) as { n: number }
    ).n
  }
  rows<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }
}

const client = (d1: FakeD1): D1Client => d1 as unknown as D1Client
const record = (d1: FakeD1, caller: Caller, body: unknown, key: string) =>
  createReturn(client(d1), caller, body, key)
const decide = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  decideReturn(client(d1), caller, id, body, key)

const board: Caller = { email: 'store@roligt.local', permissions: ['page.shipments'] }
const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const agent: Caller = { email: 'driver@roligt.local', permissions: ['page.my-deliveries'] }
const qc: Caller = { email: 'qc@roligt.local', permissions: ['page.quality'] }
const dispatchDesk: Caller = { email: 'desk@roligt.local', permissions: ['page.dispatch'] }
const stranger: Caller = { email: 'x@roligt.local', permissions: ['page.quality'] }

const insertDoc = (d1: FakeD1, collection: string, id: string, doc: unknown) =>
  d1.db
    .prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(collection, id, JSON.stringify(doc), 1, '2026-01-01T00:00:00Z')

/** The floor as a return needs it: a delivered trip off one dispatch, the stock's
 *  cost truth on the dispatch ledger line, and somewhere for it to land. */
const seedFloor = (d1: FakeD1) => {
  insertDoc(d1, 'shipments', 'S-1', {
    id: 'S-1',
    orderId: 'O-1',
    dispatchIds: ['D-1'],
    vehicle: 'AP-07-1234',
    agentUserId: 'driver@roligt.local',
    status: 'Delivered',
  })
  insertDoc(d1, 'dispatches', 'D-1', {
    id: 'D-1',
    customerId: 'C-1',
    customerName: 'Green Grocer',
    batchId: 'B-9',
    sku: 'FG-TCW-250',
    qty: 40,
    challan: 'DC/26/1042',
    orderId: 'O-1',
    vehicle: 'AP-07-1234',
    dispatchTime: '2026-10-15T04:00:00Z',
    status: 'Delivered',
    pod: 'Green Grocer',
  })
  // The dispatch's own ledger line — the flat wire row, cost and expiry truth.
  insertDoc(d1, 'ledger', 'LED-1', {
    id: 'LED-1',
    type: 'Dispatch',
    doc: 'D-1',
    item: 'FG-TCW-250',
    item_type: 'Finished Goods',
    lot: 'B-9',
    location: 'Cold Room A',
    status: 'Released',
    qty_in: 0,
    qty_out: 40,
    uom: 'Pack',
    unit_cost: 12.5,
    at: '2026-10-15T04:00:00Z',
    expiry: '2026-11-01',
  })
}

const seedLocation = (d1: FakeD1, name: string, type: string) =>
  insertDoc(d1, 'storage_locations', `SL-${name}`, {
    id: `SL-${name}`,
    name,
    label: name,
    holds: 'Whatever belongs here',
    type,
    status: 'Active',
  })

const createBody = (over: Record<string, unknown> = {}) => ({
  shipmentId: 'S-1',
  lines: [{ item: 'FG-TCW-250', lot: 'B-9', qty: 4, uom: 'Pack', reason: 'Damaged cartons' }],
  ...over,
})

/** A recorded, still-Open return off the delivered trip — the decision's subject. */
const openReturn = async (d1: FakeD1, caller: Caller = board, over: Record<string, unknown> = {}, key = 'r-key') => {
  const out = await record(d1, caller, createBody(over), key)
  return out.body.record.id
}

const domain = async <T>(p: Promise<T>): Promise<DomainError> => {
  try {
    await p
    throw new Error('expected a refusal')
  } catch (e) {
    if (e instanceof DomainError) return e
    throw e
  }
}

describe('POST /api/returns — recording', () => {
  it('records one for the board: Open, lines kept, audited', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    const out = await record(d1, board, createBody({ lines: [{ item: 'FG-TCW-250', lot: 'B-9', qty: 4, uom: 'Pack', reason: 'Damaged cartons', photoKey: 'returns/r1.jpg' }] }), 'k1')
    expect(out.status).toBe(201)
    expect(out.body.record.status).toBe('Open')
    expect(out.body.record.shipmentId).toBe('S-1')
    expect(out.body.record.lines[0]).toMatchObject({ item: 'FG-TCW-250', lot: 'B-9', qty: 4, photoKey: 'returns/r1.jpg' })
    const audits = d1
      .rows<{ json: string }>(`SELECT json FROM documents WHERE collection = 'audits'`)
      .map((r) => JSON.parse(r.json) as { action: string; doc: string })
    expect(audits.some((a) => a.action === 'return.recorded' && a.doc === out.body.record.id)).toBe(true)
  })

  it('the agent whose trip it was may record; the dispatch desk may; a stranger may not', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    expect((await record(d1, agent, createBody(), 'k1')).status).toBe(201)
    expect((await record(d1, dispatchDesk, createBody(), 'k2')).status).toBe(201)
    const refusal = await domain(record(d1, stranger, createBody(), 'k3'))
    expect(refusal.status).toBe(403)
    expect(refusal.code).toBe('role_allowed')
  })

  it('a foreign trip answers 404 for the agent, never 403', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    const refusal = await domain(record(d1, agent, createBody({ shipmentId: 'S-2' }), 'k1'))
    expect(refusal.status).toBe(404)
    expect(refusal.code).toBe('shipment_not_found')
  })

  it('a trip still before the door refuses', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    d1.db
      .prepare(`UPDATE documents SET json = json_set(json, '$.status', 'Created') WHERE collection = 'shipments' AND id = 'S-1'`)
      .run()
    const refusal = await domain(record(d1, board, createBody(), 'k1'))
    expect(refusal.status).toBe(422)
    expect(refusal.code).toBe('trip_not_out')
  })

  it('a line the trip never carried refuses', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    const refusal = await domain(
      record(d1, board, createBody({ lines: [{ item: 'FG-TCW-250', lot: 'B-9', qty: 4, uom: 'Pack', reason: 'x' }, { item: 'FG-NOPE', lot: 'B-9', qty: 1, uom: 'Pack', reason: 'x' }] }), 'k1'),
    )
    expect(refusal.status).toBe(422)
    expect(refusal.code).toBe('line_not_on_trip')
  })

  it('a malformed body refuses per-field', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    const refusal = await domain(record(d1, board, { shipmentId: 'S-1', lines: [{ item: 'FG-TCW-250', lot: 'B-9', qty: 0, uom: 'Pack', reason: 'x' }] }, 'k1'))
    expect(refusal.status).toBe(422)
    expect(refusal.code).toBe('body_invalid')
  })

  it('replays the stored response; a reused key with a new body refuses', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    const first = await record(d1, board, createBody(), 'k1')
    const again = await record(d1, board, createBody(), 'k1')
    expect(again.replay).toBe(true)
    expect(again.body.record.id).toBe(first.body.record.id)
    expect(d1.count('returns')).toBe(1)
    const refusal = await domain(record(d1, board, createBody({ lines: [{ item: 'FG-TCW-250', lot: 'B-9', qty: 5, uom: 'Pack', reason: 'Damaged cartons' }] }), 'k1'))
    expect(refusal.status).toBe(422)
    expect(refusal.code).toBe('idempotency_key')
  })
})

describe('POST /api/returns/:id/decision — QC', () => {
  it('coldroom closes the record and posts the stock back Released, cost copied off the dispatch line', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    seedLocation(d1, 'Cold Room A', 'Cold Room')
    const id = await openReturn(d1)
    const out = await decide(d1, qc, id, { decision: 'coldroom', note: 'Seals intact' }, 'd1-key')
    expect(out.status).toBe(200)
    expect(out.body.record.status).toBe('Closed')
    expect(out.body.record.qcDecision).toBe('coldroom')
    expect(out.body.record.decidedBy).toBe('qc@roligt.local')
    expect(out.body.record.ledgerRef).toBe(id)
    const lines = d1.rows<{ json: string }>(`SELECT json FROM documents WHERE collection = 'ledger' AND json_extract(json, '$.type') = 'Return'`).map((r) => JSON.parse(String(r.json)))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      doc: id,
      item: 'FG-TCW-250',
      item_type: 'Finished Goods',
      lot: 'B-9',
      location: 'Cold Room A',
      status: 'Released',
      qty_in: 4,
      qty_out: 0,
      uom: 'Pack',
      unit_cost: 12.5,
      expiry: '2026-11-01',
    })
  })

  it('quarantine holds at the hold area; writeoff lands the terminal balance there', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    seedLocation(d1, 'Hold Cage', 'Hold Area')
    const q = await decide(d1, qc, await openReturn(d1), { decision: 'quarantine' }, 'q-key')
    expect(q.body.record.qcDecision).toBe('quarantine')
    const qLine = JSON.parse(String(d1.rows<{ json: string }>(`SELECT json FROM documents WHERE collection = 'ledger' AND json_extract(json, '$.doc') = ?`, [q.body.record.id])[0].json))
    expect(qLine).toMatchObject({ status: 'Quarantine', location: 'Hold Cage', qty_in: 4 })

    const w = await decide(d1, qc, await openReturn(d1, board, { lines: [{ item: 'FG-TCW-250', lot: 'B-9', qty: 6, uom: 'Pack', reason: 'Spoilt' }] }, 'r2-key'), { decision: 'writeoff' }, 'w-key')
    expect(w.body.record.qcDecision).toBe('writeoff')
    const wLine = JSON.parse(String(d1.rows<{ json: string }>(`SELECT json FROM documents WHERE collection = 'ledger' AND json_extract(json, '$.doc') = ?`, [w.body.record.id])[0].json))
    expect(wLine).toMatchObject({ status: 'Written Off', location: 'Hold Cage', qty_in: 6 })
  })

  it('no cold room (or hold area) configured is an honest 422, nothing written', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    const id = await openReturn(d1)
    const refusal = await domain(decide(d1, qc, id, { decision: 'coldroom' }, 'k1'))
    expect(refusal.status).toBe(422)
    expect(refusal.code).toBe('location_missing')
    expect(d1.count('ledger')).toBe(1) // the seeded dispatch line only
  })

  it('the decision is the Quality page\'s alone', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    seedLocation(d1, 'Cold Room A', 'Cold Room')
    const id = await openReturn(d1)
    for (const who of [agent, board]) {
      const refusal = await domain(decide(d1, who, id, { decision: 'coldroom' }, `k-${who.email}`))
      expect(refusal.status).toBe(403)
      expect(refusal.code).toBe('role_allowed')
    }
    expect((await decide(d1, admin, id, { decision: 'coldroom' }, 'admin-key')).body.record.status).toBe('Closed')
  })

  it('a decided return refuses a second verdict; a stale version does not clobber', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    seedLocation(d1, 'Cold Room A', 'Cold Room')
    const id = await openReturn(d1)
    await decide(d1, qc, id, { decision: 'coldroom' }, 'k1')
    const refusal = await domain(decide(d1, qc, id, { decision: 'writeoff' }, 'k2'))
    expect(refusal.status).toBe(409)
    expect(refusal.code).toBe('return_closed')
  })

  it('replays the stored verdict; a reused key with a new verdict refuses', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    seedLocation(d1, 'Cold Room A', 'Cold Room')
    const id = await openReturn(d1)
    const first = await decide(d1, qc, id, { decision: 'coldroom' }, 'k1')
    const again = await decide(d1, qc, id, { decision: 'coldroom' }, 'k1')
    expect(again.replay).toBe(true)
    expect(again.body.record.id).toBe(first.body.record.id)
    expect(d1.count('ledger')).toBe(2) // dispatch line + one Return line
    const refusal = await domain(decide(d1, qc, id, { decision: 'writeoff' }, 'k1'))
    expect(refusal.status).toBe(422)
    expect(refusal.code).toBe('idempotency_key')
  })

  it('an unknown decision value or unknown return refuses', async () => {
    const d1 = new FakeD1()
    seedFloor(d1)
    seedLocation(d1, 'Cold Room A', 'Cold Room')
    const id = await openReturn(d1)
    const bad = await domain(decide(d1, qc, id, { decision: 'keep-it' }, 'k1'))
    expect(bad.status).toBe(422)
    expect(bad.code).toBe('body_invalid')
    const gone = await domain(decide(d1, qc, 'RET-nope', { decision: 'coldroom' }, 'k2'))
    expect(gone.status).toBe(404)
    expect(gone.code).toBe('return_not_found')
  })
})
