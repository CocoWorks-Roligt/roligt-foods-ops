import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { createPurchaseOrder, listPurchaseOrders, patchPurchaseOrder } from './purchaseOrders.js'
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
  counter(series: string): number | undefined {
    return (this.db.prepare('SELECT next FROM counters WHERE series = ?').get(series) as { next: number } | undefined)
      ?.next
  }
}

const client = (d1: FakeD1): D1Client => d1 as unknown as D1Client
const create = (d1: FakeD1, caller: Caller, body: unknown, key: string) =>
  createPurchaseOrder(client(d1), caller, body, key)
const patch = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  patchPurchaseOrder(client(d1), caller, id, body, key)
const list = (d1: FakeD1, caller: Caller) => listPurchaseOrders(client(d1), caller)

const procurement: Caller = { email: 'buy@roligt.local', permissions: ['page.procurement'] }
const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const qcOnly: Caller = { email: 'lab@roligt.local', permissions: ['page.quality'] }

const seedVendor = (d1: FakeD1) =>
  d1.db
    .prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('vendors', 'V-1', JSON.stringify({ id: 'V-1', name: 'Grove Farm' }), 1, '2026-01-01T00:00:00Z')

const body = {
  vendorId: 'V-1',
  lines: [{ item: 'RM-TCW-COCO', qty: 2000, uom: 'Piece', rate: 22 }],
  expectedOn: '2026-10-20',
}

describe('createPurchaseOrder', () => {
  it('mints a numbered draft, advances the po counter, and audits', async () => {
    const d1 = new FakeD1()
    seedVendor(d1)
    const out = await create(d1, procurement, body, 'k1')
    expect(out.status).toBe(201)
    expect(out.body.po.status).toBe('draft')
    expect(out.body.po.number).toBeTruthy()
    expect(out.body.po.receivedGrnIds).toEqual([])
    const stored = d1.doc('purchase_orders', out.body.po.id)
    expect(stored).toBeTruthy()
    expect(d1.counter('po')).toBe(1)
    const audits = (
      d1.db.prepare("SELECT json FROM documents WHERE collection = 'audits' AND json_extract(json, '$.action') = 'po.created'").all() as { json: string }[]
    )
    expect(audits).toHaveLength(1)
  })

  it('refuses an order for a supplier the plant does not hold', async () => {
    const d1 = new FakeD1()
    seedVendor(d1)
    await expect(create(d1, procurement, { ...body, vendorId: 'NOPE' }, 'k2')).rejects.toMatchObject({
      code: 'vendor_not_found',
    })
  })

  it('refuses an order with no lines, saying so per field', async () => {
    const d1 = new FakeD1()
    seedVendor(d1)
    await expect(create(d1, procurement, { vendorId: 'V-1', lines: [] }, 'k3')).rejects.toMatchObject({
      code: 'invalid_po',
    })
  })

  it('is the Procurement page\'s own — Quality gets 403', async () => {
    const d1 = new FakeD1()
    seedVendor(d1)
    await expect(create(d1, qcOnly, body, 'k4')).rejects.toMatchObject({ status: 403, code: 'role_allowed' })
  })

  it('replays the stored answer without minting a second number', async () => {
    const d1 = new FakeD1()
    seedVendor(d1)
    const first = await create(d1, procurement, body, 'k5')
    const again = await create(d1, procurement, body, 'k5')
    expect(again.replay).toBe(true)
    expect(again.body.po.id).toBe(first.body.po.id)
    const pos = d1.db.prepare("SELECT COUNT(*) n FROM documents WHERE collection = 'purchase_orders'").get() as { n: number }
    expect(pos.n).toBe(1)
  })
})

describe('patchPurchaseOrder', () => {
  const makePo = async (d1: FakeD1): Promise<{ id: string; version: number }> => {
    seedVendor(d1)
    const out = await create(d1, procurement, body, 'mk')
    const stored = d1.doc('purchase_orders', out.body.po.id)!
    return { id: out.body.po.id, version: stored.version }
  }

  it('moves a draft to sent and audits the move', async () => {
    const d1 = new FakeD1()
    const { id, version } = await makePo(d1)
    const out = await patch(d1, procurement, id, { status: 'sent', expectedVersion: version }, 'p1')
    expect(out.body.po.status).toBe('sent')
    const audits = (
      d1.db.prepare("SELECT json FROM documents WHERE collection = 'audits' AND json_extract(json, '$.action') = 'po.status'").all() as { json: string }[]
    )
    expect(audits).toHaveLength(1)
  })

  it('refuses a move the machine does not allow', async () => {
    const d1 = new FakeD1()
    const { id, version } = await makePo(d1)
    await expect(patch(d1, procurement, id, { status: 'received', expectedVersion: version }, 'p2')).rejects.toMatchObject(
      { code: 'illegal_transition' },
    )
  })

  it('holds closed behind its fully-received guard until a receipt is linked', async () => {
    const d1 = new FakeD1()
    const { id } = await makePo(d1)
    await patch(d1, procurement, id, { status: 'sent', expectedVersion: 1 }, 'p3')
    await patch(d1, procurement, id, { status: 'acknowledged', expectedVersion: 2 }, 'p4')
    await patch(d1, procurement, id, { status: 'received', expectedVersion: 3 }, 'p5')
    await expect(patch(d1, procurement, id, { status: 'closed', expectedVersion: 4 }, 'p6')).rejects.toBeInstanceOf(
      DomainError,
    )
    // link one receipt, and the same move lands
    const stored = JSON.parse(d1.doc('purchase_orders', id)!.json) as { receivedGrnIds: string[] }
    stored.receivedGrnIds = ['GRN-2026-0009']
    d1.db
      .prepare('UPDATE documents SET json = ? WHERE collection = ? AND id = ?')
      .run(JSON.stringify(stored), 'purchase_orders', id)
    const out = await patch(d1, procurement, id, { status: 'closed', expectedVersion: d1.doc('purchase_orders', id)!.version }, 'p7')
    expect(out.body.po.status).toBe('closed')
  })

  it('refuses a stale version with a 409', async () => {
    const d1 = new FakeD1()
    const { id } = await makePo(d1)
    await expect(patch(d1, procurement, id, { status: 'sent', expectedVersion: 0 }, 'p8')).rejects.toMatchObject({
      status: 409,
      code: 'cas_version',
    })
  })
})

describe('listPurchaseOrders', () => {
  it('lists newest first for Procurement, and refuses everyone else', async () => {
    const d1 = new FakeD1()
    seedVendor(d1)
    await create(d1, procurement, body, 'l1')
    await create(d1, procurement, { ...body, expectedOn: '2026-10-25' }, 'l2')
    const out = await list(d1, admin)
    expect(out.pos).toHaveLength(2)
    expect(out.pos[0]!.number >= out.pos[1]!.number).toBe(true)
    await expect(list(d1, qcOnly)).rejects.toMatchObject({ status: 403 })
  })
})
