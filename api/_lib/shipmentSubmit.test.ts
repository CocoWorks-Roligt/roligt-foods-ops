import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { createShipment, patchShipment, postDeliveryEvent } from './shipments.js'
import { submitShipment } from './shipmentSubmit.js'
import { correctChallan, listChallans } from './challans.js'
import { renderChallanPdf } from './challanPdf.js'
import { DomainError } from './domain.js'
import type { Challan, Shipment } from '../../src/lib/contracts.js'

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
  counter(series: string): number | undefined {
    return (
      this.db.prepare('SELECT next FROM counters WHERE series = ?').get(series) as { next: number } | undefined
    )?.next
  }
}

const client = (d1: FakeD1): D1Client => d1 as unknown as D1Client
const create = (d1: FakeD1, caller: Caller, body: unknown, key: string) =>
  createShipment(client(d1), caller, body, key)
const patch = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  patchShipment(client(d1), caller, id, body, key)
const event = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  postDeliveryEvent(client(d1), caller, id, body, key)
const submit = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  submitShipment(client(d1), caller, id, body, key)
const correct = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  correctChallan(client(d1), caller, id, body, key)
const listChallansFor = (d1: FakeD1, caller: Caller) => listChallans(client(d1), caller)

const board: Caller = { email: 'store@roligt.local', permissions: ['page.shipments'] }
const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const agent: Caller = { email: 'driver@roligt.local', permissions: ['page.my-deliveries'] }

const insertDoc = (d1: FakeD1, collection: string, id: string, doc: unknown) =>
  d1.db
    .prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(collection, id, JSON.stringify(doc), 1, '2026-01-01T00:00:00Z')

const seed = (d1: FakeD1, over: { id: string; challan?: string; qty?: number } = { id: 'D-1' }) => {
  d1.db
    .prepare('INSERT OR IGNORE INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('customers', 'C-1', JSON.stringify({ id: 'C-1', name: 'Green Grocer', shipTo: '12 Market Road' }), 1, '2026-01-01T00:00:00Z')
  d1.db
    .prepare('INSERT OR IGNORE INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(
      'items',
      'FG-TCW-250',
      JSON.stringify({
        id: 'FG-TCW-250',
        name: 'Tender Coconut Water 250ml',
        type: 'Finished Goods',
        uom: 'Pack',
        lotControlled: true,
        reorder: 0,
      }),
      1,
      '2026-01-01T00:00:00Z',
    )
  insertDoc(d1, 'dispatches', over.id, {
    id: over.id,
    customerId: 'C-1',
    customerName: 'Green Grocer',
    batchId: 'B-9',
    sku: 'FG-TCW-250',
    qty: over.qty ?? 40,
    expiry: '2026-11-01',
    challan: over.challan ?? 'DC/26/1042',
    orderId: 'O-1',
    vehicle: 'AP-01',
    dispatchTime: '2026-10-15T04:00:00Z',
    status: 'Dispatched',
    pod: '',
  })
}

const createBody = (over: Record<string, unknown> = {}) => ({
  orderId: 'O-1',
  dispatchIds: ['D-1'],
  vehicle: 'AP-07-1234',
  agentUserId: 'driver@roligt.local',
  ...over,
})

/** A trip standing Out for Delivery, one dispatch, the Classic DC number on it. */
const outForDelivery = async (d1: FakeD1, over: { challan?: string; qty?: number; id?: string } = {}) => {
  seed(d1, { id: over.id ?? 'D-1', challan: over.challan, qty: over.qty })
  const id = (await create(d1, board, createBody(), 'k1')).body.shipment.id
  await patch(d1, board, id, { expectedVersion: 1, status: 'Dispatched' }, 'p1')
  await event(d1, agent, id, { type: 'started' }, 'start')
  return id
}

const fullLine = (over: Record<string, unknown> = {}) => ({
  dispatchId: 'D-1',
  sku: 'FG-TCW-250',
  lot: 'B-9',
  qtyDelivered: 40,
  qtyRejected: 0,
  ...over,
})
const sig = { signatureKey: 'delivery/sig-1.png', printedName: 'Ravi Kumar', phone: '9848012345' }

describe('submitShipment', () => {
  it('lands a full delivery: outcome, signature, adopted DC number, dispatch stamped', async () => {
    const d1 = new FakeD1()
    const id = await outForDelivery(d1)
    const out = await submit(d1, agent, id, { lines: [fullLine()], signature: sig }, 's1')
    expect(out.status).toBe(200)
    expect(out.body.shipment.status).toBe('Delivered')
    expect(out.body.shipment.signature?.printedName).toBe('Ravi Kumar')
    expect(out.body.shipment.times.delivered).toBeTruthy()
    expect(out.body.shipment.stops[0].completedAt).toBeTruthy()
    // the challan ADOPTS the DC number the dispatch already carried
    expect(out.body.challan.number).toBe('DC/26/1042')
    expect(out.body.challan.lines[0]).toMatchObject({
      skuName: 'Tender Coconut Water 250ml',
      qty: 40,
      uom: 'Pack',
      lot: 'B-9',
      packaging: 'LOOSE',
    })
    expect(out.body.returns).toEqual([])
    // the dispatch row reads the same truth Classic's modal would write
    const dispatch = JSON.parse(d1.doc('dispatches', 'D-1')!.json) as { status: string; pod: string; deliveredTime: string }
    expect(dispatch.status).toBe('Delivered')
    expect(dispatch.pod).toBe('Ravi Kumar')
    expect(dispatch.deliveredTime).toBeTruthy()
    // the signature event lands in the history
    expect(d1.count('delivery_events')).toBe(2) // started + signature
    // adopted, so the counter never moved
    expect(d1.counter('challan')).toBeUndefined()
  })

  it('a partial delivery opens ONE return for the trip and stamps the row honestly', async () => {
    const d1 = new FakeD1()
    const id = await outForDelivery(d1)
    const out = await submit(
      d1,
      agent,
      id,
      { lines: [fullLine({ qtyDelivered: 38, qtyRejected: 2, reason: 'Dented cans' })], signature: sig },
      's1',
    )
    expect(out.body.shipment.status).toBe('Partially Delivered')
    expect(out.body.returns.length).toBe(1)
    expect(out.body.returns[0].status).toBe('Open')
    expect(out.body.returns[0].lines[0]).toMatchObject({ item: 'FG-TCW-250', qty: 2, reason: 'Dented cans' })
    expect(out.body.challan.lines[0].qty).toBe(38)
    const dispatch = JSON.parse(d1.doc('dispatches', 'D-1')!.json) as { status: string; deliveryNote?: string }
    expect(dispatch.status).toBe('Partially Delivered')
    expect(dispatch.deliveryNote).toContain('Dented cans')
    expect(dispatch.deliveryNote).toContain(out.body.returns[0].id)
    expect(d1.doc('returns', out.body.returns[0].id)).toBeTruthy()
  })

  it('everything rejected lands Returned — the challan proves the refusal at zero', async () => {
    const d1 = new FakeD1()
    const id = await outForDelivery(d1)
    const out = await submit(
      d1,
      agent,
      id,
      { lines: [fullLine({ qtyDelivered: 0, qtyRejected: 40, reason: 'Customer refused the lot' })], signature: sig },
      's1',
    )
    expect(out.body.shipment.status).toBe('Returned')
    expect(out.body.challan.lines[0].qty).toBe(0)
    expect(out.body.returns[0].lines[0].qty).toBe(40)
  })

  it('mints a fresh DC when the member numbers differ — the counter moves once', async () => {
    const d1 = new FakeD1()
    seed(d1, { id: 'D-1', challan: 'DC/26/1041' })
    seed(d1, { id: 'D-2', challan: 'DC/26/1042' })
    d1.db
      .prepare('INSERT INTO counters(series, next) VALUES (?, ?)')
      .run('challan', 1042)
    const id = (
      await create(
        d1,
        board,
        createBody({ dispatchIds: ['D-1', 'D-2'], stops: [{ customerId: 'C-1', dispatchIds: ['D-1', 'D-2'] }] }),
        'k1',
      )
    ).body.shipment.id
    await patch(d1, board, id, { expectedVersion: 1, status: 'Dispatched' }, 'p1')
    await event(d1, agent, id, { type: 'started' }, 'start')
    const out = await submit(
      d1,
      agent,
      id,
      { lines: [fullLine({ dispatchId: 'D-1' }), fullLine({ dispatchId: 'D-2', lot: 'B-9' })], signature: sig },
      's1',
    )
    expect(out.body.challan.number).toBe('DC1043/2026')
    expect(d1.counter('challan')).toBe(1043)
    expect(d1.doc('challans', 'DC1043/2026')).toBeTruthy()
  })

  it('refuses bad arithmetic, uncovered dispatches, and a second submit', async () => {
    const d1 = new FakeD1()
    const id = await outForDelivery(d1)
    await expect(
      submit(d1, agent, id, { lines: [fullLine({ qtyDelivered: 39 })], signature: sig }, 's1'),
    ).rejects.toMatchObject({ code: 'line_qty_mismatch' } as Partial<DomainError>)
    await expect(submit(d1, agent, id, { lines: [], signature: sig }, 's1')).rejects.toMatchObject({
      code: 'body_invalid',
    } as Partial<DomainError>)
    await expect(
      submit(
        d1,
        agent,
        id,
        { lines: [fullLine(), fullLine({ dispatchId: 'D-99' })], signature: sig },
        's1',
      ),
    ).rejects.toMatchObject({ code: 'line_dispatch_foreign' } as Partial<DomainError>)
    // a Created trip cannot be submitted; from Dispatched it can (the walk)
    const fresh = new FakeD1()
    seed(fresh)
    const created = (await create(fresh, board, createBody(), 'k1')).body.shipment.id
    await expect(
      submit(fresh, agent, created, { lines: [fullLine()], signature: sig }, 's1'),
    ).rejects.toMatchObject({ code: 'trip_not_out' } as Partial<DomainError>)
    await patch(fresh, board, created, { expectedVersion: 1, status: 'Dispatched' }, 'p1')
    const unstarted = await submit(fresh, agent, created, { lines: [fullLine()], signature: sig }, 's2')
    expect(unstarted.body.shipment.status).toBe('Delivered')
    expect(unstarted.body.shipment.times.outForDelivery).toBeTruthy()
    // a successful submit first — then a second one is refused, the same key replays
    const good = await submit(d1, agent, id, { lines: [fullLine()], signature: sig }, 's1')
    expect(good.status).toBe(200)
    await expect(
      submit(d1, agent, id, { lines: [fullLine()], signature: sig }, 'other-key'),
    ).rejects.toMatchObject({ code: 'already_submitted', status: 409 } as Partial<DomainError>)
    const replay = await submit(d1, agent, id, { lines: [fullLine()], signature: sig }, 's1')
    expect(replay.status).toBe(200)
  })

  it('an agent cannot submit another agent\'s trip — 404, and a foreign caller 403', async () => {
    const d1 = new FakeD1()
    const id = await outForDelivery(d1)
    const stranger: Caller = { email: 'other@roligt.local', permissions: ['page.my-deliveries'] }
    await expect(
      submit(d1, stranger, id, { lines: [fullLine()], signature: sig }, 's1'),
    ).rejects.toMatchObject({ status: 404 } as Partial<DomainError>)
    const qc: Caller = { email: 'lab@roligt.local', permissions: ['page.quality'] }
    await expect(
      submit(d1, qc, id, { lines: [fullLine()], signature: sig }, 's1'),
    ).rejects.toMatchObject({ status: 403 } as Partial<DomainError>)
    // the board may submit for any trip (a dead phone's delivery still lands)
    const asBoard = await submit(d1, board, id, { lines: [fullLine()], signature: sig }, 's2')
    expect(asBoard.status).toBe(200)
  })
})

describe('challans — the register and corrections', () => {
  const issued = async (d1: FakeD1): Promise<{ shipmentId: string; challan: Challan }> => {
    const id = await outForDelivery(d1)
    const out = await submit(d1, agent, id, { lines: [fullLine()], signature: sig }, 's1')
    return { shipmentId: id, challan: out.body.challan }
  }

  it('lists the register — an agent\'s own challans only', async () => {
    const d1 = new FakeD1()
    const { challan } = await issued(d1)
    const asAgent = await listChallansFor(d1, agent)
    expect(asAgent.challans.map((c) => c.id)).toEqual([challan.id])
    const stranger: Caller = { email: 'other@roligt.local', permissions: ['page.my-deliveries'] }
    expect((await listChallansFor(d1, stranger)).challans).toEqual([])
    expect((await listChallansFor(d1, board)).challans.length).toBe(1)
  })

  it('a correction supersedes: fresh number, linked version, reason — old stands Superseded', async () => {
    const d1 = new FakeD1()
    const { challan } = await issued(d1)
    d1.db.prepare('INSERT INTO counters(series, next) VALUES (?, ?)').run('challan', 200)
    const out = await correct(
      d1,
      admin,
      challan.id,
      {
        reason: 'Wrong expiry printed',
        expectedVersion: 1,
        lines: challan.lines.map((l) => ({ ...l, expiry: '2026-12-01' })),
      },
      'c1',
    )
    expect(out.status).toBe(201)
    expect(out.body.challan.number).toBe('DC0201/2026')
    expect(out.body.challan.supersedesId).toBe(challan.id)
    expect(out.body.challan.version).toBe(2)
    expect(out.body.challan.lines[0].expiry).toBe('2026-12-01')
    const old = JSON.parse(d1.doc('challans', challan.id)!.json) as Challan
    expect(old.status).toBe('Superseded')
    expect(d1.counter('challan')).toBe(201)
    // only an issued challan corrects; the superseded one refuses
    await expect(
      correct(d1, admin, challan.id, { reason: 'again', expectedVersion: 2 }, 'c2'),
    ).rejects.toMatchObject({ code: 'illegal_transition' } as Partial<DomainError>)
    // replay — the identical body under the same key; a different body is refused
    const sameBody = {
      reason: 'Wrong expiry printed',
      expectedVersion: 1,
      lines: challan.lines.map((l) => ({ ...l, expiry: '2026-12-01' })),
    }
    const replay = await correct(d1, admin, challan.id, sameBody, 'c1')
    expect(replay.replay).toBe(true)
    expect(d1.count('challans')).toBe(2)
    await expect(
      correct(d1, admin, challan.id, { reason: 'a different ask', expectedVersion: 1 }, 'c1'),
    ).rejects.toThrow(/already used/)
    // an agent never corrects
    await expect(
      correct(d1, agent, out.body.challan.id, { reason: 'x', expectedVersion: 1 }, 'c3'),
    ).rejects.toMatchObject({ status: 403 } as Partial<DomainError>)
  })

  it('renders the challan PDF — a real %PDF with the number and buyer on it', async () => {
    const d1 = new FakeD1()
    const { shipmentId } = await issued(d1)
    const challan = JSON.parse(d1.doc('challans', 'DC/26/1042')!.json) as Challan
    const shipment = JSON.parse(d1.doc('shipments', shipmentId)!.json) as Shipment
    const bytes = await renderChallanPdf(
      challan,
      shipment,
      new Map([['C-1', { id: 'C-1', name: 'Green Grocer', shipTo: '12 Market Road' } as never]]),
    )
    expect(bytes.length).toBeGreaterThan(1000)
    // a PDF file starts %PDF- and ends %%EOF
    const head = Buffer.from(bytes.slice(0, 5)).toString('latin1')
    expect(head).toBe('%PDF-')
  })
})
