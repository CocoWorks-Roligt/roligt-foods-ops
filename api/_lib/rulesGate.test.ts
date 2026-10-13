/**
 * The rules gate's verdicts and their wiring into the commit path — the same
 * real-SQLite fidelity as d1Engine.test.ts (better-sqlite3 on the production
 * schema, driven through a D1Client-shaped fake), so the flag matrix is proven
 * where it lives: flags OFF is byte-for-byte today's engine, flags ON refuses
 * the offending rows whole and files the 'rules.rejected' audit trail.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { D1Client } from './d1.js'
import { resetD1Caches } from './d1Snapshot.js'
import { commitChangesD1 } from './d1Commit.js'
import { RulesRejected, gateRules, rulesWantsEvidence, type RulesEvidence } from './rulesGate.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { ALL_FLAGS_OFF } from '../../src/lib/rules/flags.js'

type Stmt = { sql: string; params?: unknown[] }

/** The D1Client subset the engine uses, over a real in-memory SQLite. */
class FakeD1 {
  readonly db: Database.Database
  readonly calls = { batch: 0 }
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
    this.calls.batch++
    const out: { results: T[]; meta: { changes: number } }[] = []
    this.db.transaction(() => {
      for (const s of stmts) {
        const r = this.run(s.sql, s.params ?? [])
        out.push({ results: r.rows as T[], meta: { changes: r.changes } })
      }
    })()
    return out
  }
  doc(collection: string, id: string): { json: string; version: number } | undefined {
    return this.db
      .prepare('SELECT json, version FROM documents WHERE collection = ? AND id = ?')
      .get(collection, id) as { json: string; version: number } | undefined
  }
  docs(collection: string): { id: string; json: string }[] {
    return this.db
      .prepare('SELECT id, json FROM documents WHERE collection = ?')
      .all(collection) as { id: string; json: string }[]
  }
}

const fresh = (): FakeD1 => new FakeD1()

function seed(
  d1: FakeD1,
  rows: { collection: string; id: string; json: unknown }[],
  meta: Record<string, string> = {},
): void {
  d1.db.transaction(() => {
    const ins = d1.db.prepare('INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)')
    for (const r of rows) ins.run(r.collection, r.id, JSON.stringify(r.json), '2026-01-01T00:00:00Z')
    const metaIns = d1.db.prepare('INSERT INTO meta(setting, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(meta)) metaIns.run(k, v)
  })()
}

const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }

// ── fixtures: the plant's own example batch, its materials and its flags ─────

const NUT = { id: 'NUT', name: 'Tender Coconut', uom: 'Piece', avgUnitWeight: 0.5 }
const WATER = { id: 'WATER', name: 'Coconut Water (bulk)', uom: 'Litre', densityKgPerL: 1 }
const MALAI = { id: 'MALAI', name: 'Coconut Malai (bulk)', uom: 'Kg' }

const BATCH_OPEN = {
  id: 'B-1',
  kind: 'Extraction',
  status: 'Awaiting QC',
  sourceLines: [{ lot: 'LOT-1', item: 'NUT', uom: 'Piece', qty: 100, unitCost: 30 }],
  outputLines: [
    { item: 'WATER', qty: 46, uom: 'Litre' },
    { item: 'MALAI', qty: 3, uom: 'Kg' },
  ],
}

const SPOILAGE = (qty: number, uom = 'Kg') => ({
  id: `SP-${qty}-${uom}`,
  batchId: 'B-1',
  stage: 'extraction',
  qty,
  uom,
  reasonCode: 'rotten',
  at: '2026-09-01T00:00:00Z',
  actor: 'op@roligt.local',
})

const APP_CONFIG = JSON.stringify({ massBalanceTolerancePct: 2, avgNutWeightG: 500, defaultDensityKgPerL: 1 })

const flag = (key: string, enabled: boolean) => ({
  collection: 'flags',
  id: key,
  json: { key, enabled, note: '', updatedBy: 'test', updatedAt: '2026-01-01T00:00:00Z' },
})

const blendDraw = (status: string) => ({
  id: `L-${status}`,
  type: 'Melange Consume',
  doc: 'B-9',
  item: 'WATER',
  item_type: 'Semi Finished',
  lot: 'B-9',
  location: 'Cold Room',
  status,
  qty_in: 0,
  qty_out: 40,
  uom: 'Litre',
  unit_cost: 10,
  at: '2026-09-01T00:00:00Z',
})

const ledgerChange = (row: Record<string, unknown>): StateChanges => ({
  empty: false,
  tables: [{ table: 'ledger', upsert: [row], remove: [] }],
  counters: {},
})

const closeChange = (batch: Record<string, unknown>, stored?: Record<string, unknown>): StateChanges => ({
  empty: false,
  tables: [
    {
      table: 'batches',
      upsert: [{ id: batch.id, data: batch }],
      remove: [],
      ...(stored ? { expect: { [String(batch.id)]: { id: batch.id, data: stored } } } : {}),
    },
  ],
  counters: {},
})

beforeEach(() => {
  resetD1Caches()
})

describe('rulesWantsEvidence', () => {
  it('wants nothing unless the payload touches a ledger draw or a batch status', () => {
    expect(rulesWantsEvidence({ ...ledgerChange(blendDraw('Released')), tables: [] })).toEqual({
      flags: false,
      closeBatchIds: [],
      itemIds: [],
    })
  })

  it('a ledger row asks for the flags; a close-directed batch asks for flags, spoilage and items', () => {
    expect(rulesWantsEvidence(ledgerChange(blendDraw('Quarantine'))).flags).toBe(true)
    const wants = rulesWantsEvidence(closeChange({ ...BATCH_OPEN, status: 'Closed' }))
    expect(wants.flags).toBe(true)
    expect(wants.closeBatchIds).toEqual(['B-1'])
    expect(new Set(wants.itemIds)).toEqual(new Set(['NUT', 'WATER', 'MALAI']))
  })

  it('a batch upsert that is not close-directed wants nothing', () => {
    const wants = rulesWantsEvidence(closeChange({ ...BATCH_OPEN, status: 'Awaiting QC' }))
    expect(wants).toEqual({ flags: false, closeBatchIds: [], itemIds: [] })
  })
})

describe('gateRules (pure)', () => {
  const evidenceOf = (over: Partial<RulesEvidence> = {}): RulesEvidence => ({
    flags: { ...ALL_FLAGS_OFF },
    storedBatches: {},
    spoilage: [],
    items: {},
    appConfig: JSON.parse(APP_CONFIG),
    ...over,
  })

  it('both flags off: a Quarantine blend draw and a record-less close both pass untouched', () => {
    expect(() => gateRules(ledgerChange(blendDraw('Quarantine')), evidenceOf())).not.toThrow()
    expect(() => gateRules(closeChange({ ...BATCH_OPEN, status: 'Closed' }), evidenceOf())).not.toThrow()
  })

  it('qc_gate_v2: a non-Released bulk draw is refused with the stable code', () => {
    expect(() =>
      gateRules(ledgerChange(blendDraw('Quarantine')), evidenceOf({ flags: { ...ALL_FLAGS_OFF, qc_gate_v2: true } })),
    ).toThrow(RulesRejected)
    try {
      gateRules(ledgerChange(blendDraw('Quarantine')), evidenceOf({ flags: { ...ALL_FLAGS_OFF, qc_gate_v2: true } }))
    } catch (e) {
      const r = e as RulesRejected
      expect(r.code).toBe('lot_not_released')
      expect(r.guard).toBe('released_only')
      expect(r.entity).toBe('lot')
      expect(r.docId).toBe('B-9')
    }
  })

  it('raw produce and packing material draws are not bulk draws — never refused by the QC gate', () => {
    const flags = { ...ALL_FLAGS_OFF, qc_gate_v2: true }
    expect(() =>
      gateRules(
        ledgerChange({ ...blendDraw('Available'), type: 'Production Consume', item: 'NUT', item_type: 'Raw Material' }),
        evidenceOf({ flags }),
      ),
    ).not.toThrow()
    expect(() =>
      gateRules(
        ledgerChange({ ...blendDraw('Available'), type: 'Packing Consume', item: 'CTN-1L', item_type: 'Packing Material' }),
        evidenceOf({ flags }),
      ),
    ).not.toThrow()
  })
})

describe('commitChangesD1 — the qc_gate_v2 arm on the live path', () => {
  it('flags off (legacy): a Quarantine bulk blend draw lands exactly as it does today', async () => {
    const d1 = fresh()
    seed(d1, [], { app_config: APP_CONFIG })
    const { wrote } = await commitChangesD1(d1 as unknown as D1Client, admin, ledgerChange(blendDraw('Quarantine')))
    expect(wrote).toBe(true)
    expect(d1.doc('ledger', 'L-Quarantine')).toBeDefined()
    expect(d1.docs('audits')).toEqual([]) // no rules fired, no trail rows
  })

  it('flag on: the draw is refused whole, and the refusal is filed as an audit row', async () => {
    const d1 = fresh()
    seed(d1, [flag('qc_gate_v2', true)], { app_config: APP_CONFIG })
    const rejection = await commitChangesD1(d1 as unknown as D1Client, admin, ledgerChange(blendDraw('Quarantine'))).then(
      () => null,
      (e: unknown) => e,
    )
    expect(rejection).toBeInstanceOf(RulesRejected)
    expect((rejection as RulesRejected).code).toBe('lot_not_released')
    // the offending line never landed…
    expect(d1.doc('ledger', 'L-Quarantine')).toBeUndefined()
    // …but the trail row did: action 'rules.rejected', details naming entity and guard
    const trail = d1.docs('audits')
    expect(trail).toHaveLength(1)
    const audit = JSON.parse(trail[0].json)
    expect(audit).toMatchObject({ actor: 'boss@roligt.local', action: 'rules.rejected', doc: 'B-9' })
    expect(JSON.parse(audit.details)).toEqual({ entity: 'lot', guard: 'released_only' })
    expect(d1.calls.batch).toBe(2) // preflight + the rejection's audit batch — no write batch
  })

  it('flag on: a Released draw lands, and so does packing material drawn Available', async () => {
    const d1 = fresh()
    seed(d1, [flag('qc_gate_v2', true)], { app_config: APP_CONFIG })
    const store = d1 as unknown as D1Client
    const { wrote: w1 } = await commitChangesD1(store, admin, ledgerChange(blendDraw('Released')))
    expect(w1).toBe(true)
    const { wrote: w2 } = await commitChangesD1(
      store,
      admin,
      ledgerChange({ ...blendDraw('Available'), type: 'Packing Consume', item: 'CTN-1L', item_type: 'Packing Material' }),
    )
    expect(w2).toBe(true)
    expect(d1.docs('audits')).toEqual([])
  })
})

describe('commitChangesD1 — the batch_v2 arm on the live path', () => {
  const baseSeed = (d1: FakeD1, flagsOn: boolean, spoilage?: unknown) =>
    seed(
      d1,
      [
        ...(flagsOn ? [flag('batch_v2', true)] : []),
        { collection: 'batches', id: 'B-1', json: BATCH_OPEN },
        { collection: 'items', id: 'NUT', json: NUT },
        { collection: 'items', id: 'WATER', json: WATER },
        { collection: 'items', id: 'MALAI', json: MALAI },
        ...(spoilage ? [{ collection: 'spoilage_records', id: String((spoilage as { id: string }).id), json: spoilage }] : []),
      ],
      { app_config: APP_CONFIG },
    )

  it('flags off (legacy): a close with no spoilage record lands as it does today', async () => {
    const d1 = fresh()
    baseSeed(d1, false)
    const { wrote } = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...BATCH_OPEN, status: 'Closed' }, BATCH_OPEN),
    )
    expect(wrote).toBe(true)
    expect(JSON.parse(d1.doc('batches', 'B-1')!.json).status).toBe('Closed')
  })

  it('flag on: closing without a spoilage record is refused (spoilage_required) and audited', async () => {
    const d1 = fresh()
    baseSeed(d1, true)
    const rejection = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...BATCH_OPEN, status: 'Closed' }, BATCH_OPEN),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(rejection).toBeInstanceOf(RulesRejected)
    expect((rejection as RulesRejected).code).toBe('spoilage_required')
    expect(JSON.parse(d1.doc('batches', 'B-1')!.json).status).toBe('Awaiting QC') // unchanged
    const audit = JSON.parse(d1.docs('audits')[0].json)
    expect(audit).toMatchObject({ action: 'rules.rejected', doc: 'B-1' })
    expect(JSON.parse(audit.details)).toEqual({ entity: 'run', guard: 'spoilage_required' })
  })

  it('flag on: the plant example balances and closes (100 nuts = 50 kg in; 46 + 3 out; 1 kg spoilage)', async () => {
    const d1 = fresh()
    baseSeed(d1, true, SPOILAGE(1))
    const { wrote } = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...BATCH_OPEN, status: 'Closed' }, BATCH_OPEN),
    )
    expect(wrote).toBe(true)
    expect(JSON.parse(d1.doc('batches', 'B-1')!.json).status).toBe('Closed')
    expect(d1.docs('audits')).toEqual([])
  })

  it('flag on: an explicit zero record with variance exactly AT the tolerance still closes', async () => {
    const d1 = fresh()
    baseSeed(d1, true, SPOILAGE(0)) // 50 in, 49 out → 2% exactly
    const { wrote } = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...BATCH_OPEN, status: 'Released' }, BATCH_OPEN),
    )
    expect(wrote).toBe(true)
    expect(JSON.parse(d1.doc('batches', 'B-1')!.json).status).toBe('Released')
  })

  it('flag on: within-tolerance-but-unrecorded is one thing, out-of-tolerance is refused (mass_balance_ok)', async () => {
    const d1 = fresh()
    baseSeed(d1, true, SPOILAGE(0))
    const skimmed = {
      ...BATCH_OPEN,
      outputLines: [
        { item: 'WATER', qty: 44, uom: 'Litre' },
        { item: 'MALAI', qty: 3, uom: 'Kg' },
      ], // 47 of 50 → 6% variance
    }
    const rejection = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...skimmed, status: 'Closed' }, BATCH_OPEN),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(rejection).toBeInstanceOf(RulesRejected)
    expect((rejection as RulesRejected).code).toBe('mass_balance_ok')
    expect((rejection as RulesRejected).message).toContain('6.00%')
    expect(JSON.parse(d1.doc('batches', 'B-1')!.json).status).toBe('Awaiting QC')
  })

  it('flag on: a line whose unit has no conversion fails closed — no balance, no close', async () => {
    const d1 = fresh()
    baseSeed(d1, true, SPOILAGE(1))
    const packed = {
      ...BATCH_OPEN,
      outputLines: [{ item: 'PACK-500', qty: 40, uom: 'Pack' }],
    }
    const rejection = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...packed, status: 'Closed' }, BATCH_OPEN),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(rejection).toBeInstanceOf(RulesRejected)
    expect((rejection as RulesRejected).code).toBe('mass_balance_ok')
    expect((rejection as RulesRejected).message).toContain('no conversion to kg')
  })

  it('flag on: an edit that leaves an already-closed status alone is not a status change', async () => {
    const d1 = fresh()
    const stored = { ...BATCH_OPEN, status: 'Closed' }
    seed(d1, [flag('batch_v2', true), { collection: 'batches', id: 'B-1', json: stored }], { app_config: APP_CONFIG })
    const { wrote } = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...stored, location: 'Cold Room 2' }, stored),
    )
    expect(wrote).toBe(true)
    expect(d1.docs('audits')).toEqual([])
  })

  it('another batch’s spoilage record does not close this one', async () => {
    const d1 = fresh()
    baseSeed(d1, true, { ...SPOILAGE(1), batchId: 'B-2', id: 'SP-OTHER' })
    const rejection = await commitChangesD1(
      d1 as unknown as D1Client,
      admin,
      closeChange({ ...BATCH_OPEN, status: 'Closed' }, BATCH_OPEN),
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(rejection).toBeInstanceOf(RulesRejected)
    expect((rejection as RulesRejected).code).toBe('spoilage_required')
  })
})
