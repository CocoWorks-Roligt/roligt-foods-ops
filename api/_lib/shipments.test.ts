import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import {
  createShipment,
  getShipment,
  listShipments,
  patchShipment,
  postDeliveryEvent,
} from './shipments.js'
import { DomainError } from './domain.js'
import type { Shipment } from '../../src/lib/contracts.js'

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
}

const client = (d1: FakeD1): D1Client => d1 as unknown as D1Client
const create = (d1: FakeD1, caller: Caller, body: unknown, key: string) =>
  createShipment(client(d1), caller, body, key)
const list = (d1: FakeD1, caller: Caller) => listShipments(client(d1), caller)
const get = (d1: FakeD1, caller: Caller, id: string) => getShipment(client(d1), caller, id)
const patch = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  patchShipment(client(d1), caller, id, body, key)
const event = (d1: FakeD1, caller: Caller, id: string, body: unknown, key: string) =>
  postDeliveryEvent(client(d1), caller, id, body, key)

const board: Caller = { email: 'store@roligt.local', permissions: ['page.shipments'] }
const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const agent: Caller = { email: 'driver@roligt.local', permissions: ['page.my-deliveries'] }
const qcOnly: Caller = { email: 'lab@roligt.local', permissions: ['page.quality'] }

const insertDoc = (d1: FakeD1, collection: string, id: string, doc: unknown) =>
  d1.db
    .prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(collection, id, JSON.stringify(doc), 1, '2026-01-01T00:00:00Z')

const seedCustomer = (d1: FakeD1, id = 'C-1', name = 'Green Grocer') =>
  insertDoc(d1, 'customers', id, { id, name, shipTo: '12 Market Road' })

const seedDispatch = (
  d1: FakeD1,
  over: { id: string; orderId?: string; customerId?: string; status?: string },
) =>
  insertDoc(d1, 'dispatches', over.id, {
    id: over.id,
    customerId: over.customerId ?? 'C-1',
    customerName: 'Green Grocer',
    batchId: 'B-9',
    sku: 'FG-TCW-250',
    qty: 40,
    expiry: '2026-11-01',
    challan: 'DC/26/1042',
    orderId: over.orderId ?? 'O-1',
    vehicle: 'AP-01',
    dispatchTime: '2026-10-15T04:00:00Z',
    status: over.status ?? 'Dispatched',
    pod: '',
  })

const createBody = (over: Record<string, unknown> = {}) => ({
  orderId: 'O-1',
  dispatchIds: ['D-1'],
  vehicle: 'AP-07-1234',
  ...over,
})

describe('createShipment', () => {
  it('mints a Created trip with the derived stop off the customer master, and audits', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const out = await create(d1, board, createBody(), 'k1')
    expect(out.status).toBe(201)
    const trip = out.body.shipment
    expect(trip.status).toBe('Created')
    expect(trip.version).toBe(1)
    expect(trip.packaging).toBe('LOOSE')
    expect(trip.stops).toEqual([
      { customerId: 'C-1', customerName: 'Green Grocer', address: '12 Market Road', dispatchIds: ['D-1'] },
    ])
    expect(d1.doc('shipments', trip.id)?.version).toBe(1)
    expect(d1.count('audits')).toBe(1)
  })

  it('refuses a dispatch from another order, and one already delivered', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1', orderId: 'O-2' })
    await expect(create(d1, board, createBody(), 'k1')).rejects.toMatchObject({
      code: 'dispatch_not_on_order',
      status: 422,
    } as Partial<DomainError>)
    seedDispatch(d1, { id: 'D-2', status: 'Delivered' })
    await expect(create(d1, board, createBody({ dispatchIds: ['D-2'] }), 'k2')).rejects.toMatchObject({
      code: 'dispatch_already_delivered',
    } as Partial<DomainError>)
  })

  it('refuses a dispatch already on an active trip — and frees once it lands', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    await create(d1, board, createBody(), 'k1')
    await expect(create(d1, board, createBody({ dispatchIds: ['D-1'] }), 'k2')).rejects.toMatchObject({
      code: 'shipment_dispatch_busy',
      status: 409,
    } as Partial<DomainError>)
    // land the first trip: terminal status frees the dispatch
    const first = d1.db.prepare(`SELECT id FROM documents WHERE collection = 'shipments'`).get() as {
      id: string
    }
    const stored = JSON.parse(d1.doc('shipments', first.id)!.json) as Shipment
    d1.db
      .prepare('UPDATE documents SET json = ? WHERE collection = ? AND id = ?')
      .run(JSON.stringify({ ...stored, status: 'Delivered' }), 'shipments', first.id)
    const again = await create(d1, board, createBody(), 'k3')
    expect(again.status).toBe(201)
  })

  it('multi-customer dispatches need the stops spelled out', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1, 'C-1')
    seedCustomer(d1, 'C-2', 'Cafe Two')
    seedDispatch(d1, { id: 'D-1', customerId: 'C-1' })
    seedDispatch(d1, { id: 'D-2', customerId: 'C-2' })
    await expect(create(d1, board, createBody({ dispatchIds: ['D-1', 'D-2'] }), 'k1')).rejects.toMatchObject({
      code: 'stops_required',
    } as Partial<DomainError>)
    const out = await create(
      d1,
      board,
      createBody({
        dispatchIds: ['D-1', 'D-2'],
        stops: [
          { customerId: 'C-1', dispatchIds: ['D-1'] },
          { customerId: 'C-2', dispatchIds: ['D-2'], address: '5 Hill St' },
        ],
      }),
      'k2',
    )
    expect(out.body.shipment.stops.map((s) => s.address)).toEqual(['12 Market Road', '5 Hill St'])
    // a dispatch named at two stops is refused (D-3 is on no trip yet, so the
    // busy guard cannot fire first)
    seedDispatch(d1, { id: 'D-3' })
    await expect(
      create(
        d1,
        board,
        createBody({
          dispatchIds: ['D-3'],
          stops: [
            { customerId: 'C-1', dispatchIds: ['D-3'] },
            { customerId: 'C-1', dispatchIds: ['D-3'] },
          ],
        }),
        'k3',
      ),
    ).rejects.toMatchObject({ code: 'stop_dispatch_twice' } as Partial<DomainError>)
  })

  it('replays the same Idempotency-Key without a second trip', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const first = await create(d1, board, createBody(), 'k1')
    const replay = await create(d1, board, createBody(), 'k1')
    expect(replay.replay).toBe(true)
    expect(replay.body.shipment.id).toBe(first.body.shipment.id)
    expect(d1.count('shipments')).toBe(1)
  })

  it('is the board\'s own — QC cannot create, and neither can an agent', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    await expect(create(d1, qcOnly, createBody(), 'k1')).rejects.toMatchObject({
      status: 403,
      code: 'role_allowed',
    } as Partial<DomainError>)
    await expect(create(d1, agent, createBody(), 'k1')).rejects.toMatchObject({
      status: 403,
    } as Partial<DomainError>)
    // the full catalog is the admin — they may
    const out = await create(d1, admin, createBody(), 'k2')
    expect(out.status).toBe(201)
  })
})

describe('listShipments / getShipment — the agent scope', () => {
  it('an agent lists their own trips only; the board lists every trip, newest first', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    seedDispatch(d1, { id: 'D-2' })
    const mine = await create(
      d1,
      board,
      createBody({ dispatchIds: ['D-1'], agentUserId: 'driver@roligt.local' }),
      'k1',
    )
    const other = await create(d1, board, createBody({ dispatchIds: ['D-2'] }), 'k2')
    const asAgent = await list(d1, agent)
    expect(asAgent.shipments.map((s) => s.shipment.id)).toEqual([mine.body.shipment.id])
    const asBoard = await list(d1, board)
    expect(asBoard.shipments.map((s) => s.shipment.id).sort()).toEqual(
      [mine.body.shipment.id, other.body.shipment.id].sort(),
    )
    // the detail carries the flattened dispatch lines
    const mineDetail = asBoard.shipments.find((s) => s.shipment.id === mine.body.shipment.id)!
    expect(mineDetail.lines.length).toBe(1)
    expect(mineDetail.lines[0]).toMatchObject({ dispatchId: 'D-1', lot: 'B-9', challan: 'DC/26/1042' })
  })

  it('a foreign trip answers 404 to an agent — not 403', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const created = await create(d1, board, createBody(), 'k1')
    const id = created.body.shipment.id
    await expect(get(d1, agent, id)).rejects.toMatchObject({
      status: 404,
      code: 'shipment_not_found',
    } as Partial<DomainError>)
    const own = await get(d1, board, id)
    expect(own.events).toEqual([])
    expect(own.lines[0].dispatchId).toBe('D-1')
  })
})

describe('patchShipment — the board\'s word', () => {
  it('reassigns the agent and the vehicle with a CAS bump, and audits what changed', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const created = await create(d1, board, createBody(), 'k1')
    const id = created.body.shipment.id
    const out = await patch(
      d1,
      board,
      id,
      { expectedVersion: 1, agentUserId: 'driver@roligt.local', vehicle: 'AP-09-0000' },
      'p1',
    )
    expect(out.body.shipment.agentUserId).toBe('driver@roligt.local')
    expect(out.body.shipment.vehicle).toBe('AP-09-0000')
    expect(out.body.shipment.version).toBe(2)
    expect(d1.doc('shipments', id)?.version).toBe(2)
    const audit = d1.db
      .prepare(`SELECT json FROM documents WHERE collection = 'audits' ORDER BY rowid DESC LIMIT 1`)
      .get() as { json: string }
    expect(JSON.parse(JSON.parse(audit.json).details)).toMatchObject({ agentUserId: 'driver@roligt.local' })
  })

  it('walks the board\'s own arrows — Created→Dispatched stamps the clock; outcomes are not patchable', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const id = (await create(d1, board, createBody(), 'k1')).body.shipment.id
    const out = await patch(d1, board, id, { expectedVersion: 1, status: 'Dispatched' }, 'p1')
    expect(out.body.shipment.status).toBe('Dispatched')
    expect(out.body.shipment.times.dispatched).toBeTruthy()
    await expect(
      patch(d1, board, id, { expectedVersion: 2, status: 'Delivered' }, 'p2'),
    ).rejects.toMatchObject({ code: 'status_not_patchable' } as Partial<DomainError>)
  })

  it('refuses a stale version, an agent, and a nothing-burger', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const id = (await create(d1, board, createBody(), 'k1')).body.shipment.id
    await expect(patch(d1, board, id, { expectedVersion: 7, vehicle: 'X' }, 'p1')).rejects.toMatchObject({
      code: 'cas_version',
      status: 409,
    } as Partial<DomainError>)
    await expect(
      patch(d1, agent, id, { expectedVersion: 1, vehicle: 'X' }, 'p1'),
    ).rejects.toMatchObject({ status: 403 } as Partial<DomainError>)
    await expect(patch(d1, board, id, { expectedVersion: 1 }, 'p2')).rejects.toMatchObject({
      code: 'body_invalid',
    } as Partial<DomainError>)
  })
})

describe('postDeliveryEvent — the PWA\'s history', () => {
  const startedTrip = async (d1: FakeD1) => {
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const created = await create(d1, board, createBody({ agentUserId: 'driver@roligt.local' }), 'k1')
    const id = created.body.shipment.id
    await patch(d1, board, id, { expectedVersion: 1, status: 'Dispatched' }, 'p1')
    await event(d1, agent, id, { type: 'started' }, 'start')
    return id
  }

  it('started walks Dispatched→Out for Delivery — and walks Created through both arrows', async () => {
    const d1 = new FakeD1()
    seedCustomer(d1)
    seedDispatch(d1, { id: 'D-1' })
    const id = (await create(d1, board, createBody(), 'k1')).body.shipment.id
    // the board never marked it dispatched — the agent's start walks both
    const out = await event(d1, board, id, { type: 'started' }, 'e1')
    expect(out.body.shipmentStatus).toBe('Out for Delivery')
    const stored = JSON.parse(d1.doc('shipments', id)!.json) as Shipment
    expect(stored.status).toBe('Out for Delivery')
    expect(stored.times.dispatched).toBeTruthy()
    expect(stored.times.outForDelivery).toBeTruthy()
    expect(d1.count('delivery_events')).toBe(1)
  })

  it('a bad day: failed from Out for Delivery, rescheduled with a new ETA, started again', async () => {
    const d1 = new FakeD1()
    const id = await startedTrip(d1)
    await event(d1, agent, id, { type: 'failed', payload: { reason: 'Van broke down' } }, 'e2')
    const resched = await event(d1, agent, id, { type: 'rescheduled', payload: { eta: '2026-10-16T09:00' } }, 'e3')
    expect(resched.body.shipmentStatus).toBe('Rescheduled')
    const again = await event(d1, agent, id, { type: 'started' }, 'e4')
    expect(again.body.shipmentStatus).toBe('Out for Delivery')
    const stored = JSON.parse(d1.doc('shipments', id)!.json) as Shipment
    expect(stored.eta).toBe('2026-10-16T09:00')
    // failed only once out: a trip still at Dispatched cannot fail
    seedDispatch(d1, { id: 'D-2' })
    const stuck = (await create(d1, board, createBody({ dispatchIds: ['D-2'] }), 'k9')).body.shipment.id
    await patch(d1, board, stuck, { expectedVersion: 1, status: 'Dispatched' }, 'p9')
    await expect(event(d1, board, stuck, { type: 'failed', payload: { reason: 'x' } }, 'e9')).rejects.toMatchObject({
      code: 'illegal_transition',
    } as Partial<DomainError>)
  })

  it('line_confirm and arrived record without racing the trip doc — arrived stamps the stop', async () => {
    const d1 = new FakeD1()
    const id = await startedTrip(d1)
    const versionBefore = d1.doc('shipments', id)!.version
    const confirm = await event(
      d1,
      agent,
      id,
      { type: 'line_confirm', payload: { sku: 'FG-TCW-250', qtyDelivered: 38, qtyRejected: 2, reason: 'Dented' } },
      'e2',
    )
    expect(confirm.body.shipmentStatus).toBe('Out for Delivery')
    expect(d1.doc('shipments', id)!.version).toBe(versionBefore) // append-only leaves the CAS token alone
    const arrived = await event(d1, agent, id, { type: 'arrived' }, 'e3')
    expect(arrived.body.shipmentStatus).toBe('Out for Delivery')
    const stored = JSON.parse(d1.doc('shipments', id)!.json) as Shipment
    expect(stored.stops[0].arrivedAt).toBeTruthy()
    // a repeat with the stop named is refused; without one it just records
    await expect(event(d1, agent, id, { type: 'arrived', payload: { stopIndex: 0 } }, 'e4')).rejects.toMatchObject({
      code: 'stop_already_arrived',
    } as Partial<DomainError>)
    const passive = await event(d1, agent, id, { type: 'arrived' }, 'e5')
    expect(passive.status).toBe(201)
  })

  it('replays the same key, and an agent cannot touch a foreign trip', async () => {
    const d1 = new FakeD1()
    const id = await startedTrip(d1)
    const first = await event(d1, agent, id, { type: 'otp', payload: { ok: true } }, 'e1')
    const replay = await event(d1, agent, id, { type: 'otp', payload: { ok: true } }, 'e1')
    expect(replay.replay).toBe(true)
    expect(replay.body.event.id).toBe(first.body.event.id)
    // the trip's own start event plus this one — the replay added nothing
    expect(d1.count('delivery_events')).toBe(2)
    // foreign trip — another agent's
    const stranger: Caller = { email: 'other@roligt.local', permissions: ['page.my-deliveries'] }
    await expect(event(d1, stranger, id, { type: 'started' }, 'e2')).rejects.toMatchObject({
      status: 404,
    } as Partial<DomainError>)
    // and the machine still refuses a terminal move
    d1.db
      .prepare('UPDATE documents SET json = ? WHERE collection = ? AND id = ?')
      .run(
        JSON.stringify({ ...(JSON.parse(d1.doc('shipments', id)!.json) as Shipment), status: 'Delivered' }),
        'shipments',
        id,
      )
    await expect(event(d1, agent, id, { type: 'started' }, 'e3')).rejects.toMatchObject({
      code: 'illegal_transition',
    } as Partial<DomainError>)
  })
})
