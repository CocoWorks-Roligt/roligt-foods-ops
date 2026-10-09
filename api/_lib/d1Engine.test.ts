/**
 * The D1 engine against REAL SQLite semantics — better-sqlite3 in memory,
 * loaded with the production schema.sql, executing the engines' own SQL
 * strings through a D1Client-shaped fake. Nothing here is a mock of the
 * engine's logic: the guarded upsert's conflict condition, the assert table's
 * CHECK, changes() visibility inside a transaction, RETURNING rows — all of
 * it is SQLite answering, which is the fidelity the REST batch gave the Phase-0
 * probe and the reason the engine could be built on Design A at all.
 *
 * The fake's one test-only affordance is `beforeBatch` — a hook between the
 * engine's preflight read and its write batch, where a rival's write can land
 * exactly as another instance's would in production. The rival commits in its
 * own transaction; the engine's batch then misses its guard and must roll
 * back whole, which is the CAS story the whole 409 contract rests on.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import { readRevisionD1, readSnapshotD1, resetD1Caches } from './d1Snapshot.js'
import { commitChangesD1 } from './d1Commit.js'
import { writeAdminAuditD1 } from './adminAudit.js'
import { d1ComplianceStore } from './d1Compliance.js'
import { Conflict, Forbidden, expectedPeriodOf } from './commitGates.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { DEFAULT_COMPLIANCE_LEAD_DAYS } from '../../src/lib/complianceRules.js'

type Stmt = { sql: string; params?: unknown[] }

/** The D1Client subset the engines use, over a real in-memory SQLite. */
class FakeD1 {
  readonly db: Database.Database
  /** A rival's write, run between the engine's statements — its own transaction. */
  beforeBatch: ((stmts: Stmt[]) => void) | null = null
  readonly calls = { query: 0, batch: 0 }

  constructor() {
    this.db = new Database(':memory:')
    this.db.exec(readFileSync(new URL('../../scripts/d1/schema.sql', import.meta.url), 'utf8'))
  }

  private run(sql: string, params: unknown[]): { rows: unknown[]; changes: number } {
    const stmt = this.db.prepare(sql)
    // stmt.reader is better-sqlite3's own truth for "this statement returns
    // rows" — .run() on a SELECT silently discards them
    if (stmt.reader) {
      const rows = stmt.all(...(params as never[])) as unknown[]
      return { rows, changes: rows.length }
    }
    const info = stmt.run(...(params as never[]))
    return { rows: [], changes: info.changes }
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.query++
    return this.run(sql, params).rows as T[]
  }

  async batch<T>(stmts: Stmt[]): Promise<{ results: T[]; meta: { changes: number } }[]> {
    this.calls.batch++
    this.beforeBatch?.(stmts)
    const out: { results: T[]; meta: { changes: number } }[] = []
    try {
      this.db.transaction(() => {
        for (const s of stmts) {
          const r = this.run(s.sql, s.params ?? [])
          out.push({ results: r.rows as T[], meta: { changes: r.changes } })
        }
      })()
    } catch (e) {
      // the provider's shape: success:false → D1ApiError carrying its own
      // message — here SQLite's, whose named CHECK self-identifies
      const err = e as { message?: string }
      throw new D1ApiError(String(err.message ?? e))
    }
    return out
  }

  /** Direct table access for seeding and asserting — never the engines' path. */
  doc(collection: string, id: string): { json: string; version: number } | undefined {
    return this.db
      .prepare('SELECT json, version FROM documents WHERE collection = ? AND id = ?')
      .get(collection, id) as { json: string; version: number } | undefined
  }
  revision(): string {
    return (this.db.prepare("SELECT value FROM meta WHERE setting = 'app_revision'").get() as { value: string }).value
  }
  counter(series: string): number | undefined {
    return (this.db.prepare('SELECT next FROM counters WHERE series = ?').get(series) as { next: number } | undefined)?.next
  }
  meta(setting: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE setting = ?').get(setting) as { value: string } | undefined)?.value
  }
}

const fresh = (): FakeD1 => new FakeD1()

function seed(d1: FakeD1, rows: { collection: string; id: string; json: unknown; version?: number }[], meta: Record<string, string> = {}, counters: Record<string, number> = {}): void {
  d1.db.transaction(() => {
    const ins = d1.db.prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(r.collection, r.id, JSON.stringify(r.json), r.version ?? 1, '2026-01-01T00:00:00Z')
    const metaIns = d1.db.prepare('INSERT INTO meta(setting, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(meta)) metaIns.run(k, v)
    const ctrIns = d1.db.prepare('INSERT INTO counters(series, next) VALUES (?, ?)')
    for (const [k, v] of Object.entries(counters)) ctrIns.run(k, v)
  })()
}

const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const operator: Caller = { email: 'op@roligt.local', permissions: [] }
const suppliersClerk: Caller = { email: 'supplies@roligt.local', permissions: ['page.vendors'] }

const GRN_DOC = { id: 'GRN-1', status: 'Posted', total: 100 }
const LEDGER_ROW = {
  id: 'L1', type: 'GRN', doc: 'GRN-1', item: 'Tender Coconut', item_type: 'Raw Material', lot: 'LOT-1',
  location: 'Cold Room', status: 'In Stock', qty_in: 90, qty_out: 0, uom: 'Piece', unit_cost: 35, at: '2026-09-21T08:00:00Z',
}
const AUDIT_ROW = { id: 'A1', at: '2026-09-21T08:00:00Z', actor: 'Admin', action: 'posted', doc: 'GRN-1', details: '90 accepted' }

const CHANGES: StateChanges = {
  empty: false,
  tables: [
    { table: 'grns', upsert: [{ id: 'GRN-1', data: GRN_DOC }], remove: [] },
    { table: 'ledger', upsert: [LEDGER_ROW], remove: [] },
    { table: 'audits', upsert: [AUDIT_ROW], remove: [] },
  ],
  counters: { grn: 1 },
  config: undefined,
}

beforeEach(() => {
  resetD1Caches()
})

describe('readSnapshotD1 / readRevisionD1', () => {
  it('serves a fresh database as never-written: revision "0", state null (the client seeds)', async () => {
    const d1 = fresh()
    const snap = await readSnapshotD1(d1 as unknown as D1Client)
    expect(snap.revision).toBe('0')
    expect(snap.everWritten).toBe(false)
    expect(snap.state).toBeNull()
  })

  it('parses rows through the wire decoders: collections as docs, ledger flat, audits newest-first', async () => {
    const d1 = fresh()
    seed(
      d1,
      [
        { collection: 'grns', id: 'GRN-1', json: GRN_DOC },
        { collection: 'ledger', id: 'L1', json: LEDGER_ROW },
        { collection: 'audits', id: 'A-old', json: { ...AUDIT_ROW, id: 'A-old', at: '2026-09-20T08:00:00Z' } },
        { collection: 'audits', id: 'A1', json: AUDIT_ROW },
      ],
      { app_config: '{"tolerances":{"lab":5}}' },
      { grn: 7 },
    )
    const snap = await readSnapshotD1(d1 as unknown as D1Client)
    expect(snap.revision).toBe('0')
    expect(snap.everWritten).toBe(true)
    expect(snap.state?.grns).toEqual([GRN_DOC])
    expect(snap.state?.ledger?.[0]).toMatchObject({ id: 'L1', qtyIn: 90, item: 'Tender Coconut' })
    expect(snap.state?.audits?.map((a) => a.id)).toEqual(['A1', 'A-old']) // newest first
    expect(snap.state?.counters).toEqual({ grn: 7 })
    expect(snap.state?.config).toEqual({ tolerances: { lab: 5 } })
  })

  it('reads first-class packs beside their SKU pointers', async () => {
    const d1 = fresh()
    const pack = { id: 'PACK:250 ml BiB|BiB|250|ml', name: '250 ml BiB', type: 'BiB', size: 250, unit: 'ml', packVolume: 0.25, bom: [] }
    seed(d1, [
      { collection: 'packs', id: pack.id, json: pack },
      { collection: 'products', id: 'FG-1', json: { id: 'FG-1', name: 'TCW 250 ml', packId: pack.id } },
    ])
    const snap = await readSnapshotD1(d1 as unknown as D1Client)
    expect(snap.state?.packs).toEqual([pack])
    expect(snap.state?.products).toEqual([{ id: 'FG-1', name: 'TCW 250 ml', packId: pack.id }])
  })

  it('a wiped collection reads [] (an empty wire table IS the wipe on D1), and period:* counters stay out of counters', async () => {
    const d1 = fresh()
    seed(
      d1,
      [
        { collection: 'ledger', id: 'L1', json: LEDGER_ROW },
      ],
      { 'period:grn': 'YYYY:2026' },
    )
    const snap = await readSnapshotD1(d1 as unknown as D1Client)
    // ledger rows exist → the plant is established; every other wire table read
    // back empty, which the Zoho sweep called a wipe and D1 cannot distinguish
    // (nor needs to: an empty table is a wipe)
    expect(snap.state?.grns).toEqual([])
    expect(snap.state?.vendors).toEqual([])
    expect(snap.state?.counters).toBeUndefined() // nothing but the period key, which meta owns
    expect(snap.state?.counterPeriods).toEqual({ grn: 'YYYY:2026' })
  })

  it('memoizes the revision read (two polls, one query) and single-flights the full batch', async () => {
    const d1 = fresh()
    const store = d1 as unknown as D1Client
    await readRevisionD1(store)
    await readRevisionD1(store)
    expect(d1.calls.query).toBe(1)
    const [a, b] = await Promise.all([readSnapshotD1(store), readSnapshotD1(store)])
    expect(a).toBe(b) // the same in-flight read served both
    expect(d1.calls.batch).toBe(1)
  })

  it('serves the state memo while the revision holds, and re-batches once a write moves the token', async () => {
    const d1 = fresh()
    const store = d1 as unknown as D1Client
    await readSnapshotD1(store)
    await readSnapshotD1(store)
    expect(d1.calls.batch).toBe(1) // memo hit — the revision never moved
    await commitChangesD1(store, admin, CHANGES) // a write bumps the token inside its own batch
    const snap = await readSnapshotD1(store)
    expect(d1.calls.batch).toBe(4) // read + preflight + write + the re-read the moved token forced
    expect(snap.state?.grns).toEqual([GRN_DOC])
    expect(snap.revision).toMatch(/^1:/)
  })

  it('skips a hand-written row that is no document without failing the read', async () => {
    const d1 = fresh()
    seed(d1, [
      { collection: 'grns', id: 'GRN-str', json: 'not json' }, // stringifies to a valid-JSON string — not a document
      { collection: 'grns', id: 'GRN-1', json: GRN_DOC },
    ])
    d1.db
      .prepare("INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('grns', 'GRN-worse', '{oops', 1, '2026-01-01T00:00:00Z')")
      .run() // genuinely unparsable — only a hand-edit can produce it
    const snap = await readSnapshotD1(d1 as unknown as D1Client)
    expect(snap.state?.grns).toEqual([GRN_DOC])
  })
})

describe('commitChangesD1', () => {
  it('writes a pack master as its own D1 document', async () => {
    const d1 = fresh()
    const pack = { id: 'PACK:5 L BiB|BiB|5|L', name: '5 L BiB', type: 'BiB', size: 5, unit: 'L', packVolume: 5, bom: [] }
    await commitChangesD1(d1 as unknown as D1Client, admin, {
      empty: false,
      tables: [{ table: 'packs', upsert: [{ id: pack.id, data: pack }], remove: [] }],
      counters: {},
    })
    expect(JSON.parse(d1.doc('packs', pack.id)!.json)).toEqual(pack)
  })

  it('writes doc + ledger + audit + counter in one atomic batch and stamps the audit actor', async () => {
    const d1 = fresh()
    const { token, wrote } = await commitChangesD1(d1 as unknown as D1Client, admin, CHANGES)
    expect(wrote).toBe(true)
    expect(token).toMatch(/^1:[0-9a-z]+$/)
    expect(JSON.parse(d1.doc('grns', 'GRN-1')!.json)).toEqual(GRN_DOC)
    expect(d1.doc('grns', 'GRN-1')!.version).toBe(1)
    expect(JSON.parse(d1.doc('ledger', 'L1')!.json)).toEqual(LEDGER_ROW) // flat, unstamped
    const audit = JSON.parse(d1.doc('audits', 'A1')!.json)
    expect(audit.actor).toBe('boss@roligt.local') // the authenticated caller, not the payload's claim
    expect(audit.details).toBeTruthy()
    expect(d1.counter('grn')).toBe(1)
    expect(d1.revision()).toBe(token)
  })

  it('an idempotent re-send is a no-op: the same token back, nothing written, no bump', async () => {
    const d1 = fresh()
    const store = d1 as unknown as D1Client
    const first = await commitChangesD1(store, admin, CHANGES)
    const again = await commitChangesD1(store, admin, CHANGES)
    expect(again.wrote).toBe(false)
    expect(again.token).toBe(first.token)
    expect(d1.calls.batch).toBe(3) // commit 1's preflight + write, commit 2's preflight only
    expect(d1.revision()).toBe(first.token)
  })

  it('an edit whose expect matches the stored row lands and advances the version', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'grns', id: 'GRN-1', json: GRN_DOC }])
    const amended = { ...GRN_DOC, status: 'Amended' }
    const { token, wrote } = await commitChangesD1(d1 as unknown as D1Client, admin, {
      ...CHANGES,
      tables: [{ table: 'grns', upsert: [{ id: 'GRN-1', data: amended }], remove: [], expect: { 'GRN-1': { id: 'GRN-1', data: GRN_DOC } } }],
      counters: {},
    })
    expect(wrote).toBe(true)
    expect(d1.doc('grns', 'GRN-1')!.version).toBe(2)
    expect(JSON.parse(d1.doc('grns', 'GRN-1')!.json)).toEqual(amended)
    expect(d1.revision()).toBe(token)
  })

  it('a stale expect refuses the whole commit before any write', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'grns', id: 'GRN-1', json: GRN_DOC }])
    await expect(
      commitChangesD1(d1 as unknown as D1Client, admin, {
        ...CHANGES,
        tables: [{ table: 'grns', upsert: [{ id: 'GRN-1', data: { ...GRN_DOC, status: 'X' } }], remove: [], expect: { 'GRN-1': { id: 'GRN-1', data: { ...GRN_DOC, status: 'Draft' } } } }],
        counters: { grn: 9 },
      }),
    ).rejects.toMatchObject({ conflicts: [{ table: 'grns', id: 'GRN-1', kind: 'changed' }] })
    expect(d1.doc('grns', 'GRN-1')!.version).toBe(1)
    expect(d1.counter('grn')).toBeUndefined()
    expect(d1.revision()).toBe('0')
  })

  it('an insert naming an existing different row with no expect refuses as "exists"', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'grns', id: 'GRN-1', json: GRN_DOC }])
    await expect(
      commitChangesD1(d1 as unknown as D1Client, admin, {
        ...CHANGES,
        tables: [{ table: 'grns', upsert: [{ id: 'GRN-1', data: { ...GRN_DOC, total: 5 } }], remove: [] }],
        counters: {},
      }),
    ).rejects.toMatchObject({ conflicts: [{ table: 'grns', id: 'GRN-1', kind: 'exists' }] })
  })

  it('an expect against a row somebody deleted refuses as "changed" (no resurrection)', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'grns', id: 'GRN-1', json: GRN_DOC }])
    d1.db.prepare("DELETE FROM documents WHERE collection = 'grns'").run()
    await expect(
      commitChangesD1(d1 as unknown as D1Client, admin, {
        ...CHANGES,
        tables: [{ table: 'grns', upsert: [{ id: 'GRN-1', data: GRN_DOC }], remove: [], expect: { 'GRN-1': { id: 'GRN-1', data: GRN_DOC } } }],
        counters: {},
      }),
    ).rejects.toMatchObject({ conflicts: [{ table: 'grns', id: 'GRN-1', kind: 'changed' }] })
  })

  it('a rival write between preflight and batch trips the assert: 409, rival stands, siblings rolled back', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'grns', id: 'GRN-1', json: GRN_DOC, version: 1 }])
    d1.beforeBatch = (stmts) => {
      // the write batch only — the preflight batch must observe the old row
      if (!stmts.some((s) => s.sql.startsWith('DELETE FROM _assert_changed'))) return
      const rival = JSON.stringify({ ...GRN_DOC, status: 'Rival' })
      d1.db.prepare("UPDATE documents SET json = ?, version = 2 WHERE collection = 'grns' AND id = 'GRN-1'").run(rival)
    }
    const conflict = await commitChangesD1(d1 as unknown as D1Client, admin, {
      ...CHANGES,
      tables: [
        { table: 'grns', upsert: [{ id: 'GRN-1', data: { ...GRN_DOC, status: 'Mine' } }], remove: [], expect: { 'GRN-1': { id: 'GRN-1', data: GRN_DOC } } },
        { table: 'grns', upsert: [{ id: 'GRN-2', data: { id: 'GRN-2', status: 'Posted' } }], remove: [] },
      ],
      counters: { grn: 4 },
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(conflict).toBeInstanceOf(Conflict)
    expect((conflict as Conflict).conflicts).toContainEqual({ table: 'grns', id: 'GRN-1', kind: 'changed' })
    // the rival's write stands; our sibling row and counter rolled back whole
    expect(JSON.parse(d1.doc('grns', 'GRN-1')!.json).status).toBe('Rival')
    expect(d1.doc('grns', 'GRN-1')!.version).toBe(2)
    expect(d1.doc('grns', 'GRN-2')).toBeUndefined()
    expect(d1.counter('grn')).toBeUndefined()
    expect(d1.revision()).toBe('0')
  })

  it('audits are insert-only: re-naming an existing id writes nothing and bumps nothing', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'audits', id: 'A1', json: { ...AUDIT_ROW, actor: 'whoever' } }])
    const { token, wrote } = await commitChangesD1(d1 as unknown as D1Client, admin, {
      ...CHANGES,
      tables: [{ table: 'audits', upsert: [{ ...AUDIT_ROW, details: 'rewritten history' }], remove: [] }],
      counters: {},
    })
    expect(wrote).toBe(false)
    expect(token).toBe('0')
    expect(JSON.parse(d1.doc('audits', 'A1')!.json).actor).toBe('whoever')
  })

  it('an identical ledger retry is a no-op (insert-only semantics without the expect)', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'ledger', id: 'L1', json: LEDGER_ROW }])
    const { wrote } = await commitChangesD1(d1 as unknown as D1Client, admin, {
      ...CHANGES,
      tables: [{ table: 'ledger', upsert: [LEDGER_ROW], remove: [] }],
      counters: {},
    })
    expect(wrote).toBe(false)
    expect(d1.doc('ledger', 'L1')!.version).toBe(1)
  })

  it('counters: a forward move lands; a stale regression alone is skipped with no bump', async () => {
    const d1 = fresh()
    seed(d1, [], {}, { grn: 5 })
    const store = d1 as unknown as D1Client
    const fwd = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: { grn: 9 } })
    expect(fwd.wrote).toBe(true)
    expect(d1.counter('grn')).toBe(9)
    const stale = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: { grn: 3 } })
    expect(stale.wrote).toBe(false)
    expect(d1.counter('grn')).toBe(9)
  })

  it('counters: a non-admin jump past the ceiling is Forbidden before any write (an admin may vault)', async () => {
    const d1 = fresh()
    seed(d1, [], {}, { grn: 5 })
    await expect(commitChangesD1(d1 as unknown as D1Client, operator, { ...CHANGES, tables: [], counters: { grn: 200_001 } })).rejects.toBeInstanceOf(Forbidden)
    expect(d1.counter('grn')).toBe(5)
  })

  it('counters: a genuine period reset rewinds the number and lands the period row', async () => {
    const d1 = fresh()
    const meta = { app_config: '{}', 'period:grn': 'ZZZ:old' }
    seed(d1, [], meta, { grn: 500 })
    const expected = expectedPeriodOf(new Map(Object.entries(meta)), 'grn')
    const { wrote } = await commitChangesD1(d1 as unknown as D1Client, admin, {
      ...CHANGES,
      tables: [],
      counters: { grn: 1, 'period:grn': expected },
    })
    expect(wrote).toBe(true)
    expect(d1.counter('grn')).toBe(1) // rewound — the reset the new period unlocks
    expect(d1.meta('period:grn')).toBe(expected)
  })

  it('counters: a forged or merely-echoed period claim writes nothing', async () => {
    const d1 = fresh()
    const meta = { app_config: '{}', 'period:grn': 'ZZZ:old' }
    seed(d1, [], meta, { grn: 500 })
    const store = d1 as unknown as D1Client
    const forged = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: { grn: 1, 'period:grn': 'forged' } })
    expect(forged.wrote).toBe(false)
    expect(d1.counter('grn')).toBe(500)
    expect(d1.revision()).toBe('0')
    const echo = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: { 'period:grn': 'ZZZ:old' } })
    expect(echo.wrote).toBe(false)
  })

  it('config: an admin genuine change lands in app_config; an echo skips', async () => {
    const d1 = fresh()
    seed(d1, [], { app_config: '{"tolerances":{"lab":5}}' })
    const store = d1 as unknown as D1Client
    const changed = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: {}, config: { tolerances: { lab: 6 } } })
    expect(changed.wrote).toBe(true)
    expect(d1.meta('app_config')).toBe('{"tolerances":{"lab":6}}')
    const echo = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: {}, config: { tolerances: { lab: 6 } } })
    expect(echo.wrote).toBe(false)
  })

  it('config: an operator without the page is refused; a scoped clerk cannot file an audit-only ride', async () => {
    const d1 = fresh()
    const store = d1 as unknown as D1Client
    await expect(commitChangesD1(store, operator, { ...CHANGES, tables: [], counters: {}, config: { anything: 1 } })).rejects.toBeInstanceOf(Forbidden)
    await expect(
      commitChangesD1(store, suppliersClerk, { ...CHANGES, tables: [{ table: 'audits', upsert: [AUDIT_ROW], remove: [] }], counters: {} }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('removes: a present row is deleted; an absent id is already the outcome; a vanished-in-window row still succeeds', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'grns', id: 'GRN-1', json: GRN_DOC }])
    const store = d1 as unknown as D1Client
    const gone = await commitChangesD1(store, admin, { ...CHANGES, tables: [{ table: 'grns', upsert: [], remove: ['GRN-1'] }], counters: {} })
    expect(gone.wrote).toBe(true)
    expect(d1.doc('grns', 'GRN-1')).toBeUndefined()
    const absent = await commitChangesD1(store, admin, { ...CHANGES, tables: [{ table: 'grns', upsert: [], remove: ['GRN-9'] }], counters: {} })
    expect(absent.wrote).toBe(false)
    // the rival deletes the row inside our window: our DELETE changes 0 rows, and the outcome asked for is true either way
    seed(d1, [{ collection: 'grns', id: 'GRN-2', json: { id: 'GRN-2', status: 'Posted' } }])
    d1.beforeBatch = (stmts) => {
      if (stmts.some((s) => s.sql.startsWith('DELETE FROM _assert_changed'))) {
        d1.db.prepare("DELETE FROM documents WHERE collection = 'grns' AND id = 'GRN-2'").run()
      }
    }
    const raced = await commitChangesD1(store, admin, { ...CHANGES, tables: [{ table: 'grns', upsert: [], remove: ['GRN-2'] }], counters: {} })
    expect(raced.wrote).toBe(true)
    expect(d1.doc('grns', 'GRN-2')).toBeUndefined()
  })

  it('the revision stays strictly monotonic across commits', async () => {
    const d1 = fresh()
    const store = d1 as unknown as D1Client
    const first = await commitChangesD1(store, admin, CHANGES)
    const second = await commitChangesD1(store, admin, { ...CHANGES, tables: [{ table: 'grns', upsert: [{ id: 'GRN-2', data: { id: 'GRN-2', status: 'Posted' } }], remove: [] }], counters: { grn: 2 } })
    const third = await commitChangesD1(store, admin, { ...CHANGES, tables: [], counters: { grn: 3 } })
    const n = (t: string) => parseInt(t, 10)
    expect(n(second.token)).toBeGreaterThan(n(first.token))
    expect(n(third.token)).toBeGreaterThan(n(second.token))
  })
})

describe('writeAdminAuditD1', () => {
  it('files the trail row and bumps the revision in one batch, then the memo serves the token without a query', async () => {
    const d1 = fresh()
    await writeAdminAuditD1(d1 as unknown as D1Client, admin, 'role changed', 'ops@roligt.local', 'granted page.vendors')
    const ids = d1.db.prepare("SELECT id, json FROM documents WHERE collection = 'audits'").all() as { id: string; json: string }[]
    expect(ids).toHaveLength(1)
    expect(ids[0].id).toMatch(/^AUD-admin-/)
    expect(JSON.parse(ids[0].json)).toMatchObject({ actor: 'boss@roligt.local', action: 'role changed', doc: 'ops@roligt.local' })
    const token = d1.revision()
    expect(token).toMatch(/^1:/)
    expect(d1.calls.query).toBe(0)
    await expect(readRevisionD1(d1 as unknown as D1Client)).resolves.toBe(token) // the memo the write left
    expect(d1.calls.query).toBe(0)
  })
})

describe('d1ComplianceStore', () => {
  const CMP = { id: 'CMP-FSSAI-1', title: 'FSSAI licence', docType: 'Licence', remindEmails: ['lead@roligt.local'] }

  it('lists by soonest expiry and composes fetch tokens from the row version', async () => {
    const d1 = fresh()
    seed(d1, [
      { collection: 'compliance', id: 'CMP-B', json: { ...CMP, id: 'CMP-B', expiresOn: '2027-01-01' } },
      { collection: 'compliance', id: 'CMP-A', json: { ...CMP, id: 'CMP-A', expiresOn: '2026-11-01' } },
      { collection: 'compliance', id: 'CMP-NODATE', json: { ...CMP, id: 'CMP-NODATE' } },
      { collection: 'compliance', id: 'CMP-BAD', json: 'not json' },
    ])
    const cs = d1ComplianceStore(d1 as unknown as D1Client)
    const docs = await cs.list()
    expect(docs.map((d) => d.doc.id)).toEqual(['CMP-A', 'CMP-B', 'CMP-NODATE'])
    const stored = await cs.fetch('CMP-A')
    expect(stored?.version).toBe('CMP-A:1')
    expect(stored?.handle).toBe('CMP-A')
    expect(await cs.fetch('CMP-NONE')).toBeNull()
  })

  it('saves against the observed token, advances it, and refuses a stale one', async () => {
    const d1 = fresh()
    const cs = d1ComplianceStore(d1 as unknown as D1Client)
    const first = await cs.save(CMP, null)
    expect(first).toEqual({ saved: true, version: 'CMP-FSSAI-1:1' })
    const stored = await cs.fetch(CMP.id)
    expect(stored?.version).toBe('CMP-FSSAI-1:1')
    const second = await cs.save({ ...CMP, title: 'FSSAI licence (renewed)' }, stored!.version)
    expect(second).toEqual({ saved: true, version: 'CMP-FSSAI-1:2' })
    expect(d1.doc('compliance', CMP.id)!.version).toBe(2)
    // the stale retry of the first save: the row moved past its observed token
    const stale = await cs.save({ ...CMP, title: 'Stale edit' }, 'CMP-FSSAI-1:1')
    expect(stale).toEqual({ saved: false })
    expect(JSON.parse(d1.doc('compliance', CMP.id)!.json).title).toBe('FSSAI licence (renewed)')
  })

  it('markSent lands the marker, and a race with an edit is false — never an error', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'compliance', id: CMP.id, json: CMP }])
    const cs = d1ComplianceStore(d1 as unknown as D1Client)
    await expect(cs.markSent({ ...CMP, reminderSentFor: '2026-11-01', reminderSentAt: '2026-10-08T03:30:00Z' }, 'CMP-FSSAI-1:1')).resolves.toBe(true)
    // the row is at version 2 now; the same observed token again is the lost race
    await expect(cs.markSent({ ...CMP, reminderSentFor: '2026-11-01' }, 'CMP-FSSAI-1:1')).resolves.toBe(false)
  })

  it('removes by handle, and the lead window reads from app_config with the default guard', async () => {
    const d1 = fresh()
    seed(d1, [{ collection: 'compliance', id: CMP.id, json: CMP }], { app_config: '{"complianceLeadDays": 45}' })
    const cs = d1ComplianceStore(d1 as unknown as D1Client)
    await expect(cs.leadDays()).resolves.toBe(45)
    await cs.remove(CMP.id, CMP.id)
    expect(await cs.fetch(CMP.id)).toBeNull()
    d1.db.prepare("UPDATE meta SET value = '{\"complianceLeadDays\": \"lots\"}' WHERE setting = 'app_config'").run()
    await expect(cs.leadDays()).resolves.toBe(DEFAULT_COMPLIANCE_LEAD_DAYS)
  })
})
