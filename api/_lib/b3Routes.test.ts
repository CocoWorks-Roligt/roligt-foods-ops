/**
 * The B3 route adapters at the handler level: the POST contract (method,
 * content-type, parsable body, the Idempotency-Key header) and the replay
 * header, with _lib/auth and _lib/shared mocked so no WorkOS and no D1
 * provider are touched — the store is the same in-memory SQLite fake
 * b3.test.ts drives the services with, so the routes are exercised end to
 * end against real SQLite semantics.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { D1ApiError } from './d1.js'

const world = vi.hoisted(() => ({
  caller: { email: 'buy@roligt.local', permissions: ['page.procurement'] } as { email: string; permissions: string[] },
  authError: null as string | null,
  d1: null as unknown,
}))

vi.mock('./auth.ts', () => {
  class AuthError extends Error {}
  return {
    authenticate: vi.fn(async () => {
      if (world.authError) throw new AuthError(world.authError)
      return { caller: world.caller }
    }),
    AuthError,
  }
})

vi.mock('./shared.ts', () => ({ get d1() { return world.d1 } }))

vi.mock('./vercel.ts', () => ({ toWebRequest: (req: unknown) => req as unknown as Request }))

const grading = (await import('../grading.ts')).default
const close = (await import('../transformations/close.ts')).default
const genealogy = (await import('../genealogy.ts')).default
const search = (await import('../search.ts')).default

// ── the in-memory D1 (b3.test.ts's fake, trimmed to what the routes need) ───

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
  revision(): string {
    return (this.db.prepare("SELECT value FROM meta WHERE setting = 'app_revision'").get() as { value: string }).value
  }
}

function seedGrading(d1: FakeD1, pipeline = true): void {
  d1.db.transaction(() => {
    const ins = d1.db.prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)')
    ins.run('flags', 'flag-pipeline', JSON.stringify({ key: 'pipeline', enabled: pipeline }), '2026-01-01T00:00:00Z')
    ins.run('items', 'ITM-NUT', JSON.stringify({ id: 'ITM-NUT', uom: 'Piece', requiresGrading: true }), '2026-01-01T00:00:00Z')
    ins.run('grns', 'GRN-C1', JSON.stringify({
      id: 'GRN-C1', date: '2026-10-09', farmerId: 'F-1', farmerName: 'Kumar', lot: 'LOT-C1', total: 100,
      a: 0, b: 0, c: 0, reject: 0, rate: 35, transport: 500, accepted: 0, materialValue: 0, landed: 0,
      grossCost: 0, usableCost: 0, status: 'Posted', gradingMode: 'staged', itemId: 'ITM-NUT', uom: 'Piece', location: 'Cold Room',
    }), '2026-01-01T00:00:00Z')
    ins.run('ledger', 'L-GRN-C1', JSON.stringify({
      id: 'L-GRN-C1', type: 'Receipt', doc: 'GRN-C1', item: 'ITM-NUT', item_type: 'Raw Material', lot: 'LOT-C1',
      location: 'Cold Room', status: 'Quarantine', qty_in: 100, qty_out: 0, uom: 'Piece', unit_cost: 35,
      at: '2026-10-09T06:00:00Z', expiry: null, vendor_id: null,
    }), '2026-01-01T00:00:00Z')
  })()
}

function seedTrace(d1: FakeD1): void {
  d1.db.transaction(() => {
    const ins = d1.db.prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)')
    ins.run('grns', 'GRN-C1', JSON.stringify({ id: 'GRN-C1', lot: 'LOT-C1', farmerName: 'Kumar', date: '2026-10-09' }), '2026-01-01T00:00:00Z')
    ins.run('orders', 'ORD-1', JSON.stringify({ id: 'ORD-1', customerId: 'CUS-1', customerName: 'Fresh Mart', date: '2026-10-11', lines: [{ sku: 'PACK-200ML', qty: 1 }], status: 'Open' }), '2026-01-01T00:00:00Z')
    ins.run('customers', 'CUS-1', JSON.stringify({ id: 'CUS-1', name: 'Fresh Mart' }), '2026-01-01T00:00:00Z')
  })()
}

const gradeBody = { grnId: 'GRN-C1', expectedVersion: 1, a: 60, b: 30, c: 5, reject: 5 }

function fakeRes() {
  const res = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: unknown) => {
      res.headers[name] = value
      return res
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code
      return res
    }),
    json: vi.fn((body: unknown) => {
      ;(res as { body?: unknown }).body = body
    }),
    end: vi.fn(),
  }
  return res as unknown as VercelResponse & typeof res & { body?: unknown }
}

function fakeReq(
  url: string,
  { method = 'GET', headers = {}, body, query }: { method?: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {},
): VercelRequest {
  return { headers, url, method, body, query } as unknown as VercelRequest
}

beforeEach(() => {
  world.authError = null
  world.caller = { email: 'buy@roligt.local', permissions: ['page.procurement'] }
  world.d1 = null
})

describe('the POST route contract', () => {
  it('a missing Idempotency-Key is 422 before anything runs', async () => {
    const d1 = new FakeD1()
    seedGrading(d1)
    world.d1 = d1
    const res = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: gradeBody }), res)
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.body).toMatchObject({ code: 'idempotency_key' })
    expect(d1.revision()).toBe('0') // nothing wrote
  })

  it('a non-POST method is 405; a non-JSON content type is 415; a malformed body is 400', async () => {
    world.d1 = new FakeD1()
    const get = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'GET', headers: { 'content-type': 'application/json' } }), get)
    expect(get.status).toHaveBeenCalledWith(405)
    const xml = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'text/xml' }, body: gradeBody }), xml)
    expect(xml.status).toHaveBeenCalledWith(415)
    const bad = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k' }, body: '{nope' }), bad)
    expect(bad.status).toHaveBeenCalledWith(400)
  })

  it('an unauthenticated caller is 401; a missing store is 503', async () => {
    world.authError = 'no session'
    const unauth = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k' }, body: gradeBody }), unauth)
    expect(unauth.status).toHaveBeenCalledWith(401)

    world.authError = null
    world.d1 = null
    const noStore = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k' }, body: gradeBody }), noStore)
    expect(noStore.status).toHaveBeenCalledWith(503)
  })
})

describe('POST /api/grading (the route end to end)', () => {
  it('grades and answers 200; the replay carries Idempotency-Replayed and writes nothing', async () => {
    const d1 = new FakeD1()
    seedGrading(d1)
    world.d1 = d1
    const first = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' }, body: gradeBody }), first)
    expect(first.status).toHaveBeenCalledWith(200)
    expect(first.body).toMatchObject({ grnId: 'GRN-C1', accepted: 95 })
    expect(first.setHeader).not.toHaveBeenCalledWith('Idempotency-Replayed', 'true')
    const rev = d1.revision()

    const second = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' }, body: gradeBody }), second)
    expect(second.status).toHaveBeenCalledWith(200)
    expect(second.body).toEqual(first.body)
    expect(second.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true')
    expect(d1.revision()).toBe(rev)
  })

  it('a reused key with a changed body is 422 through the route', async () => {
    const d1 = new FakeD1()
    seedGrading(d1)
    world.d1 = d1
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' }, body: gradeBody }), fakeRes())
    const res = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' }, body: { ...gradeBody, a: 61, b: 29 } }), res)
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.body).toMatchObject({ code: 'idempotency_key' })
  })

  it('a service refusal maps to its own status — pipeline off is 421', async () => {
    const d1 = new FakeD1()
    seedGrading(d1, false)
    world.d1 = d1
    const res = fakeRes()
    await grading(fakeReq('/api/grading', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' }, body: gradeBody }), res)
    expect(res.status).toHaveBeenCalledWith(421)
    expect(res.body).toMatchObject({ code: 'pipeline_off' })
  })
})

describe('POST /api/transformations/close (the route end to end)', () => {
  it('refuses a caller without can.close_run with 403 before touching the store', async () => {
    const d1 = new FakeD1()
    world.d1 = d1
    const res = fakeRes()
    await close(fakeReq('/api/transformations/close', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k' }, body: { batchId: 'B-1', expectedVersion: 1, spoilage: [] } }), res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.body).toMatchObject({ code: 'role_allowed' })
  })
})

describe('GET /api/genealogy and /api/search (the routes end to end)', () => {
  it('answers the walk from the query string', async () => {
    const d1 = new FakeD1()
    seedTrace(d1)
    world.d1 = d1
    const res = fakeRes()
    await genealogy(fakeReq('/api/genealogy?seed=LOT:LOT-C1&dir=forward&depth=3', { query: { seed: 'LOT:LOT-C1', dir: 'forward', depth: '3' } }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.body as { nodes: { id: string }[]; truncated: boolean }
    expect(body.nodes.map((n) => n.id)).toContain('grn:GRN-C1')
  })

  it('refuses the delivery agent 403', async () => {
    const d1 = new FakeD1()
    seedTrace(d1)
    world.d1 = d1
    world.caller = { email: 'ride@roligt.local', permissions: ['page.my-deliveries'] }
    const res = fakeRes()
    await genealogy(fakeReq('/api/genealogy?seed=LOT:LOT-C1', { query: { seed: 'LOT:LOT-C1' } }), res)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('searches across kinds from ?q=', async () => {
    const d1 = new FakeD1()
    seedTrace(d1)
    world.d1 = d1
    const res = fakeRes()
    await search(fakeReq('/api/search?q=Fresh', { query: { q: 'Fresh' } }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.body as { results: { kind: string; id: string }[] }
    expect(body.results.some((r) => r.kind === 'customer' && r.id === 'CUS-1')).toBe(true)
  })
})
