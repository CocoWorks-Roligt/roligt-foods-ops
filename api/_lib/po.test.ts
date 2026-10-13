import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { createPurchaseOrder, listPurchaseOrders, patchPurchaseOrder, receiveAgainstPurchaseOrder } from './purchaseOrders.js'
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
const receive = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  receiveAgainstPurchaseOrder(client(d1), caller, id, body, key)
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
    expect(out.body.po.version).toBe(1)
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
    expect(out.body.po.version).toBe(version + 1)
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

describe('receiveAgainstPurchaseOrder', () => {
  const seedGrn = (d1: FakeD1, id: string) =>
    d1.db
      .prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('grns', id, JSON.stringify({ id, accepted: 1800 }), 1, '2026-01-01T00:00:00Z')

  /** A PO walked to acknowledged, the state receipts hang off. */
  const ackedPo = async (d1: FakeD1): Promise<string> => {
    seedVendor(d1)
    const out = await create(d1, procurement, body, 'r0')
    const id = out.body.po.id
    await patch(d1, procurement, id, { status: 'sent', expectedVersion: 1 }, 'r1')
    await patch(d1, procurement, id, { status: 'acknowledged', expectedVersion: 2 }, 'r2')
    return id
  }

  it('links the GRN and lands an acknowledged order in received', async () => {
    const d1 = new FakeD1()
    seedGrn(d1, 'GRN-2026-0001')
    const id = await ackedPo(d1)
    const out = await receive(d1, procurement, id, { grnId: 'GRN-2026-0001', expectedVersion: 3 }, 'r3')
    expect(out.body.po.status).toBe('received')
    expect(out.body.po.receivedGrnIds).toEqual(['GRN-2026-0001'])
    expect(out.body.po.version).toBe(4)
    const audits = (
      d1.db.prepare("SELECT json FROM documents WHERE collection = 'audits' AND json_extract(json, '$.action') = 'po.received'").all() as { json: string }[]
    )
    expect(audits).toHaveLength(1)
  })

  it('keeps a received order received for part-receipts, and repeats are no-ops', async () => {
    const d1 = new FakeD1()
    seedGrn(d1, 'GRN-2026-0001')
    seedGrn(d1, 'GRN-2026-0002')
    const id = await ackedPo(d1)
    await receive(d1, procurement, id, { grnId: 'GRN-2026-0001', expectedVersion: 3 }, 'r4')
    const second = await receive(d1, procurement, id, { grnId: 'GRN-2026-0002', expectedVersion: 4 }, 'r5')
    expect(second.body.po.status).toBe('received')
    expect(second.body.po.receivedGrnIds).toEqual(['GRN-2026-0001', 'GRN-2026-0002'])
    const again = await receive(d1, procurement, id, { grnId: 'GRN-2026-0002', expectedVersion: 5 }, 'r6')
    expect(again.body.po.receivedGrnIds).toEqual(['GRN-2026-0001', 'GRN-2026-0002'])
    expect(again.body.po.version).toBe(5)
  })

  it('refuses a receipt against an order nobody has acknowledged', async () => {
    const d1 = new FakeD1()
    seedGrn(d1, 'GRN-2026-0001')
    seedVendor(d1)
    const out = await create(d1, procurement, body, 'r7')
    await expect(receive(d1, procurement, out.body.po.id, { grnId: 'GRN-2026-0001', expectedVersion: 1 }, 'r8')).rejects.toMatchObject(
      { code: 'po_not_acked' },
    )
  })

  it('refuses a receipt the plant does not hold, and a stale version', async () => {
    const d1 = new FakeD1()
    seedGrn(d1, 'GRN-2026-0001')
    const id = await ackedPo(d1)
    await expect(receive(d1, procurement, id, { grnId: 'GRN-404', expectedVersion: 3 }, 'r9')).rejects.toMatchObject({
      code: 'grn_not_found',
    })
    await expect(receive(d1, procurement, id, { grnId: 'GRN-2026-0001', expectedVersion: 0 }, 'r10')).rejects.toMatchObject({
      status: 409,
    })
  })

  it('replays the stored answer without linking twice', async () => {
    const d1 = new FakeD1()
    seedGrn(d1, 'GRN-2026-0001')
    const id = await ackedPo(d1)
    const first = await receive(d1, procurement, id, { grnId: 'GRN-2026-0001', expectedVersion: 3 }, 'r11')
    const again = await receive(d1, procurement, id, { grnId: 'GRN-2026-0001', expectedVersion: 3 }, 'r11')
    expect(again.replay).toBe(true)
    expect(again.body.po.receivedGrnIds).toEqual(first.body.po.receivedGrnIds)
  })

  it('is the Procurement page\'s own — Quality gets 403', async () => {
    const d1 = new FakeD1()
    seedGrn(d1, 'GRN-2026-0001')
    const id = await ackedPo(d1)
    await expect(receive(d1, qcOnly, id, { grnId: 'GRN-2026-0001', expectedVersion: 3 }, 'r12')).rejects.toMatchObject({
      status: 403,
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
    expect(out.pos.every((po) => po.version >= 1)).toBe(true)
    await expect(list(d1, qcOnly)).rejects.toMatchObject({ status: 403 })
  })
})
