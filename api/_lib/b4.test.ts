/**
 * B4 unit + service tests: the qc and orders-dispatch folds (pure, no store),
 * then kpisFor over the same in-memory SQLite fake the B3 tests drive — the
 * RBAC gate, page-based read withholding, the revision-keyed memo, the meta
 * cache for cached modules, and the freshness stamp — and the SSE stream's
 * hello/revision/bye protocol on real (tiny) intervals.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { D1ApiError } from './d1.js'
import { kpisFor, resetKpiMemo } from './kpis.js'
import { revisionStream } from './events.js'
import { qcKpis } from '../../src/lib/kpis/qc.ts'
import { ordersDispatchKpis } from '../../src/lib/kpis/ordersDispatch.ts'
import type { AppState, Batch, QcRecord } from '../../src/types.ts'

// ── the in-memory D1 (b3Routes.test.ts's fake, trimmed) ─────────────────────

type Stmt = { sql: string; params?: unknown[] }

class FakeD1 {
  readonly db: Database.Database
  queries = 0
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
    this.queries += 1
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

type Caller = { email: string; permissions: string[] }

const QC_CALLER: Caller = { email: 'qc@roligt.local', permissions: ['page.quality', 'page.production'] }
const OD_CALLER: Caller = { email: 'ops@roligt.local', permissions: ['page.orders', 'page.dispatch'] }

const NOW = '2026-10-13T09:00:00.000Z'

function put(d1: FakeD1, collection: string, id: string, doc: unknown, updated_at = NOW): void {
  d1.db
    .prepare(
      `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
    .run(collection, id, JSON.stringify(doc), updated_at)
}

function setRevision(d1: FakeD1, value: string): void {
  d1.db
    .prepare(`INSERT INTO meta(setting, value) VALUES ('app_revision', ?) ON CONFLICT(setting) DO UPDATE SET value = excluded.value`)
    .run(value)
}

function setConfig(d1: FakeD1, config: unknown): void {
  d1.db
    .prepare(`INSERT INTO meta(setting, value) VALUES ('app_config', ?) ON CONFLICT(setting) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(config))
}

const qcRecord = (id: string, batchId: string, disposition: string): QcRecord =>
  ({ id, batchId, item: 'ITM-WATER', micro: 'Pass', pesticides: 'Pass', heavyMetals: 'Pass', physico: 'Pass', disposition }) as QcRecord

const batchOf = (id: string, date: string): Batch => ({ id, date }) as Batch

function seedQc(d1: FakeD1): void {
  put(d1, 'items', 'ITM-WATER', { id: 'ITM-WATER', name: 'Coconut Water' })
  put(d1, 'batches', 'B-1', batchOf('B-1', '2026-10-11'))
  put(d1, 'batches', 'B-2', batchOf('B-2', '2026-10-13'))
  put(d1, 'qcs', 'QC-1', qcRecord('QC-1', 'B-1', 'Released'))
  put(d1, 'qcs', 'QC-2', qcRecord('QC-2', 'B-1', 'Rejected'))
  put(d1, 'qcs', 'QC-3', qcRecord('QC-3', 'B-2', 'Pending'))
  put(d1, 'qcs', 'QC-4', qcRecord('QC-4', 'B-2', 'Pending'))
  setRevision(d1, '5:nonce')
}

function seedOrders(d1: FakeD1): void {
  put(d1, 'orders', 'ORD-1', { id: 'ORD-1', customerId: 'CUS-1', customerName: 'Fresh Mart', date: '2026-10-11', dueDate: '2026-10-12', lines: [{ sku: 'PACK-1L', qty: 100 }], status: 'Open' })
  put(d1, 'orders', 'ORD-2', { id: 'ORD-2', customerId: 'CUS-1', customerName: 'Fresh Mart', date: '2026-10-12', lines: [{ sku: 'PACK-1L', qty: 100 }], status: 'Dispatched' })
  put(d1, 'dispatches', 'D-1', { id: 'D-1', orderId: 'ORD-2', sku: 'PACK-1L', qty: 60, status: 'Delivered', dispatchTime: '2026-10-12T08:00:00Z', challan: 'DC-1' })
  setRevision(d1, '7:nonce')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  resetKpiMemo()
})

afterEach(() => vi.useRealTimers())

// ── the folds, pure ─────────────────────────────────────────────────────────

describe('qcKpis', () => {
  const state = {
    items: [{ id: 'ITM-WATER', name: 'Coconut Water' }],
    batches: [batchOf('B-1', '2026-10-11'), batchOf('B-2', '2026-10-13')],
    qcs: [
      qcRecord('QC-1', 'B-1', 'Released'),
      qcRecord('QC-2', 'B-1', 'Rejected'),
      qcRecord('QC-3', 'B-2', 'Pending'),
      qcRecord('QC-4', 'B-2', 'Pending'),
    ],
  } as unknown as Partial<AppState>

  it('counts cards and buckets over the window', () => {
    const out = qcKpis(state, { from: '2026-10-01', to: '2026-10-13' }, '2026-10-13')
    const byKey = Object.fromEntries(out.cards.map((c) => [c.key, c]))
    expect(byKey['qc-pending'].value).toBe(2)
    expect(byKey['qc-rejected'].value).toBe(1)
    expect(byKey['qc-release-rate'].value).toBe(25)
    const aging = out.charts.find((c) => c.key === 'qc-pending-aging')
    expect(aging?.rows.find((r) => r.label === '0–2 days')?.value).toBe(2)
  })

  it('matches qualityReport month slices — one implementation', async () => {
    const { qualityReport } = await import('../../src/lib/reports/qualityReport.ts')
    const w = { from: '2026-10-01', to: '2026-10-31' }
    const report = qualityReport(state as never, w)
    const out = qcKpis(state, w, '2026-10-13')
    const octReleased = out.charts[0].rows.find((r) => r.series === 'Released')?.value
    expect(octReleased).toBe(report.byMonth[0]?.released)
  })
})

describe('ordersDispatchKpis', () => {
  const state = {
    orders: [
      { id: 'ORD-1', customerId: 'C1', customerName: 'A', date: '2026-10-11', dueDate: '2026-10-12', lines: [{ sku: 'P', qty: 100 }], status: 'Open' },
      { id: 'ORD-2', customerId: 'C1', customerName: 'A', date: '2026-10-12', lines: [{ sku: 'P', qty: 100 }], status: 'Dispatched' },
    ],
    dispatches: [
      { id: 'D-1', orderId: 'ORD-2', sku: 'P', qty: 60, status: 'Delivered', dispatchTime: '2026-10-12T08:00:00Z' },
    ],
  } as unknown as Partial<AppState>

  it('folds pipeline, overdue and fulfilment', () => {
    const out = ordersDispatchKpis(state, { from: '2026-10-01', to: '2026-10-13' }, '2026-10-13')
    const byKey = Object.fromEntries(out.cards.map((c) => [c.key, c]))
    expect(byKey['od-open'].value).toBe(1)
    expect(byKey['od-overdue'].value).toBe(1)
    expect(byKey['od-fulfilment'].value).toBe(30)
    const pipeline = out.charts.find((c) => c.key === 'od-pipeline')
    // a count tie keeps insertion order (ORD-1 Open read first)
    expect(pipeline?.rows).toEqual([
      { label: 'Open', value: 1 },
      { label: 'Dispatched', value: 1 },
    ])
  })
})

// ── kpisFor over the fake store ─────────────────────────────────────────────

describe('kpisFor', () => {
  it('serves a module with freshness stamped from documents', async () => {
    const d1 = new FakeD1()
    seedQc(d1)
    const out = await kpisFor(d1, QC_CALLER, 'qc', {})
    expect(out.module).toBe('qc')
    expect(out.cards.find((c) => c.key === 'qc-pending')?.value).toBe(2)
    expect(out.last_updated).toBe(NOW)
    expect(out.stale_after).toBe(300)
    expect(out.stale).toBe(false)
  })

  it('404s an unknown module', async () => {
    const d1 = new FakeD1()
    await expect(kpisFor(d1, QC_CALLER, 'nope', {})).rejects.toMatchObject({
      status: 404,
      code: 'invalid_module',
    })
  })

  it('403s a delivery agent and a caller without the module page', async () => {
    const d1 = new FakeD1()
    seedQc(d1)
    const agent: Caller = { email: 'driver@roligt.local', permissions: ['page.my-deliveries'] }
    await expect(kpisFor(d1, agent, 'qc', {})).rejects.toMatchObject({ status: 403 })
    const stranger: Caller = { email: 'ops@roligt.local', permissions: ['page.orders'] }
    await expect(kpisFor(d1, stranger, 'qc', {})).rejects.toMatchObject({ status: 403 })
  })

  it('folds without collections the caller may not read', async () => {
    const d1 = new FakeD1()
    seedQc(d1)
    // page.quality alone: qcs visible, batches withheld → the window read
    // (batch dates) empties the fold — no leak through the numbers.
    const caller: Caller = { email: 'qc@roligt.local', permissions: ['page.quality'] }
    const out = await kpisFor(d1, caller, 'qc', {})
    expect(out.cards.find((c) => c.key === 'qc-pending')?.value).toBe(0)
    expect(out.charts.every((c) => c.rows.every((r) => r.value === 0))).toBe(true)
  })

  it('memoizes per revision — a same-revision read never re-folds', async () => {
    const d1 = new FakeD1()
    seedQc(d1)
    const first = await kpisFor(d1, QC_CALLER, 'qc', {})
    const queriesAfterFirst = d1.queries
    // A document written WITHOUT a revision bump (impossible via real paths)
    // must not leak into a memoized answer.
    put(d1, 'qcs', 'QC-5', qcRecord('QC-5', 'B-2', 'Pending'), '2026-10-13T10:00:00.000Z')
    const memoized = await kpisFor(d1, QC_CALLER, 'qc', {})
    expect(memoized.cards.find((c) => c.key === 'qc-pending')?.value).toBe(2)
    expect(memoized.last_updated).toBe(first.last_updated)
    setRevision(d1, '6:nonce')
    const refolded = await kpisFor(d1, QC_CALLER, 'qc', {})
    expect(refolded.cards.find((c) => c.key === 'qc-pending')?.value).toBe(3)
    expect(d1.queries).toBeGreaterThan(queriesAfterFirst)
  })

  it('serves a cached module from meta within its TTL and refolds past it', async () => {
    const d1 = new FakeD1()
    setRevision(d1, '9:nonce')
    const first = await kpisFor(d1, OD_CALLER, 'shipment-tracking', {})
    expect(first.cards).toEqual([])
    // the cache row exists
    const row = d1.db.prepare(`SELECT value FROM meta WHERE setting = 'kpi:shipment-tracking'`).get() as { value: string }
    expect(JSON.parse(row.value).revision).toBe('9:nonce')

    // sentinel payload: a cold memo must be served FROM the cache
    const sentinel = JSON.parse(row.value)
    sentinel.payload.cards = [{ key: 'from-cache', label: 'From cache', value: 1 }]
    d1.db.prepare(`UPDATE meta SET value = ? WHERE setting = 'kpi:shipment-tracking'`).run(JSON.stringify(sentinel))
    resetKpiMemo()
    const cached = await kpisFor(d1, OD_CALLER, 'shipment-tracking', {})
    expect(cached.cards.map((c) => c.key)).toEqual(['from-cache'])

    // TTL past (or revision moved): refold and rewrite the cache
    setRevision(d1, '10:nonce')
    resetKpiMemo()
    const refolded = await kpisFor(d1, OD_CALLER, 'shipment-tracking', {})
    expect(refolded.cards).toEqual([])
  })

  it('serves the orders-dispatch fold end to end', async () => {
    const d1 = new FakeD1()
    seedOrders(d1)
    const out = await kpisFor(d1, OD_CALLER, 'orders-dispatch', { from: '2026-10-01', to: '2026-10-13' })
    const byKey = Object.fromEntries(out.cards.map((c) => [c.key, c]))
    expect(byKey['od-open'].value).toBe(1)
    expect(byKey['od-overdue'].value).toBe(1)
    expect(byKey['od-fulfilment'].value).toBe(30)
    expect(out.charts.find((c) => c.key === 'od-pipeline')?.rows).toHaveLength(2)
  })

  it('marks stale past the configured age, and honors kpiStaleAfterSec', async () => {
    const d1 = new FakeD1()
    seedQc(d1)
    setConfig(d1, { kpiStaleAfterSec: 60 })
    const fresh = await kpisFor(d1, QC_CALLER, 'qc', {})
    expect(fresh.stale).toBe(false)
    // 2 minutes later, same revision: memo serves, stale recomputed at read
    vi.setSystemTime(new Date('2026-10-13T09:02:00.000Z'))
    resetKpiMemo()
    const older = await kpisFor(d1, QC_CALLER, 'qc', {})
    expect(older.last_updated).toBe(NOW)
    expect(older.stale_after).toBe(60)
    expect(older.stale).toBe(true)
  })
})

// ── the SSE stream, real tiny intervals ────────────────────────────────────

function streamFake() {
  const chunks: string[] = []
  const res = {
    headers: {} as Record<string, unknown>,
    setHeader: (n: string, v: unknown) => void (res.headers[n] = v),
    flushHeaders: () => undefined,
    write: (s: string) => void chunks.push(s),
    end: () => void ((res as { ended?: boolean }).ended = true),
    on: () => res,
    status: () => res,
    json: () => res,
  }
  const req = { on: () => req }
  return { req: req as unknown as VercelRequest, res: res as unknown as VercelResponse, chunks, ended: () => (res as { ended?: boolean }).ended === true }
}

describe('revisionStream', () => {
  it('says hello, announces changes, heartbeats, and says bye at max life', async () => {
    const d1 = new FakeD1()
    setRevision(d1, '1:a')
    const { req, res, chunks, ended } = streamFake()
    revisionStream(req, res, async () => (d1.db.prepare(`SELECT value FROM meta WHERE setting = 'app_revision'`).get() as { value: string }).value, {
      pollMs: 20,
      heartbeatMs: 35,
      maxLifeMs: 80,
    })
    await vi.advanceTimersByTimeAsync(5)
    expect(chunks.join('')).toContain('event: hello')
    expect(chunks.join('')).toContain('"revision":"1:a"')

    setRevision(d1, '2:b')
    await vi.advanceTimersByTimeAsync(25)
    const joined = chunks.join('')
    expect(joined).toContain('event: revision')
    expect(joined).toContain('"revision":"2:b"')

    // t=110: past the heartbeat (35) and the max life (80) — ping, bye, ended.
    await vi.advanceTimersByTimeAsync(80)
    const all = chunks.join('')
    expect(all).toContain(': ping')
    expect(all).toContain('event: bye')
    expect(ended()).toBe(true)
  })
})
