/**
 * The B4 routes at the handler level: GET /api/kpis/:module and GET
 * /api/events, with _lib/auth and _lib/shared mocked (no WorkOS, no D1
 * provider) and the same in-memory SQLite fake the service tests drive.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { D1ApiError } from './d1.js'

const world = vi.hoisted(() => ({
  caller: { email: 'qc@roligt.local', permissions: ['page.quality', 'page.production'] } as { email: string; permissions: string[] },
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

const kpisRoute = (await import('../kpis/[module].ts')).default
const eventsRoute = (await import('../events.ts')).default

// ── the in-memory D1 (b3Routes.test.ts's fake, trimmed) ─────────────────────

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
}

function seedQc(db: Database.Database): void {
  const ins = db.prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)')
  ins.run('items', 'ITM-WATER', JSON.stringify({ id: 'ITM-WATER', name: 'Coconut Water' }), '2026-10-13T09:00:00.000Z')
  ins.run('batches', 'B-1', JSON.stringify({ id: 'B-1', date: '2026-10-11' }), '2026-10-13T09:00:00.000Z')
  ins.run('qcs', 'QC-1', JSON.stringify({ id: 'QC-1', batchId: 'B-1', item: 'ITM-WATER', disposition: 'Pending' }), '2026-10-13T09:00:00.000Z')
  db.prepare(`INSERT INTO meta(setting, value) VALUES ('app_revision', '5:nonce') ON CONFLICT(setting) DO UPDATE SET value = excluded.value`).run()
}

function fakeRes() {
  const res = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    chunks: [] as string[],
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
    flushHeaders: vi.fn(),
    write: vi.fn((s: string) => void res.chunks.push(s)),
    end: vi.fn(),
    on: vi.fn(),
  }
  return res as unknown as VercelResponse & typeof res & { body?: unknown; chunks: string[] }
}

function fakeReq(query: Record<string, string> = {}) {
  const handlers: Record<string, () => void> = {}
  const req = {
    headers: {},
    url: '/api/',
    method: 'GET',
    query,
    on: vi.fn((ev: string, cb: () => void) => {
      handlers[ev] = cb
      return req
    }),
  }
  const out = req as unknown as VercelRequest
  return { req: out, close: () => handlers['close']?.() }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  world.authError = null
  world.d1 = null
})

describe('GET /api/kpis/:module', () => {
  it('serves the module fold as JSON', async () => {
    const d1 = new FakeD1()
    seedQc(d1.db)
    world.d1 = d1
    const res = fakeRes()
    await kpisRoute(fakeReq({ module: 'qc' }).req, res)
    expect(res.statusCode).toBe(200)
    const body = (res as { body?: { module: string; cards: { key: string; value: number }[] } }).body
    expect(body?.module).toBe('qc')
    expect(body?.cards.find((c) => c.key === 'qc-pending')?.value).toBe(1)
  })

  it('answers 404 for an unknown module and 401 unsigned', async () => {
    world.d1 = new FakeD1()
    const missing = fakeRes()
    await kpisRoute(fakeReq({ module: 'nope' }).req, missing)
    expect(missing.statusCode).toBe(404)

    world.authError = 'no session'
    const unsigned = fakeRes()
    await kpisRoute(fakeReq({ module: 'qc' }).req, unsigned)
    expect(unsigned.statusCode).toBe(401)
  })

  it('503s without the D1 store', async () => {
    const res = fakeRes()
    await kpisRoute(fakeReq({ module: 'qc' }).req, res)
    expect(res.statusCode).toBe(503)
  })
})

describe('GET /api/events', () => {
  it('streams SSE headers and a hello carrying the revision', async () => {
    const d1 = new FakeD1()
    seedQc(d1.db)
    world.d1 = d1
    const res = fakeRes()
    const { req, close } = fakeReq()
    await eventsRoute(req, res)
    await settle()
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-cache, no-transform')
    expect(res.chunks.join('')).toContain('retry: 20000')
    expect(res.chunks.join('')).toContain('event: hello')
    expect(res.chunks.join('')).toContain('"revision":"5:nonce"')
    // close the socket so the stream's default-interval timers stop
    close()
  })

  it('503s without the D1 store, before any stream starts', async () => {
    const res = fakeRes()
    await eventsRoute(fakeReq().req, res)
    expect(res.statusCode).toBe(503)
    expect(res.chunks).toEqual([])
  })
})
