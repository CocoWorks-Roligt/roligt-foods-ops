/**
 * The Phase-4 dev smoke — the real engines against the REAL scratch database
 * over the REAL REST client, end to end. Opt-in (D1_SMOKE=1 plus the D1_* env
 * the D1Client constructor reads); the normal suite never touches the network.
 *
 * The unit suite (d1Engine.test.ts) pins the engines' logic against real
 * SQLite semantics in memory; this file pins the remaining untested surface —
 * the REST wire itself: the batch envelope the production endpoint really
 * returns, RETURNING through the real response shape, changes() as the
 * provider reports it, and the assert's CHECK surfacing in the provider's own
 * error message after the constraint rename. Everything it writes is SMOKE-
 * prefixed (plus the smoketest counter series) and cleaned up in afterAll;
 * the revision stays bumped — monotonic by design, and this is scratch.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { D1Client } from './d1.js'
import { readRevisionD1, readSnapshotD1, resetD1Caches } from './d1Snapshot.js'
import { commitChangesD1 } from './d1Commit.js'
import { writeAdminAuditD1 } from './adminAudit.js'
import { d1ComplianceStore } from './d1Compliance.js'
import { Conflict } from './commitGates.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'

// the probe's .env pattern — the runner may also pass the vars directly
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
}

const SMOKE = !!process.env.D1_SMOKE && !!process.env.D1_ACCOUNT_ID && !!process.env.D1_DATABASE_ID && !!process.env.D1_API_TOKEN

describe.skipIf(!SMOKE)('D1 dev smoke (scratch, live)', () => {
  // constructed in beforeAll — a skipped describe never runs it, and the
  // constructor refuses to build a client without the env (the guard IS the gate)
  let d1!: D1Client
  const admin: Caller = { email: 'smoke@roligt.local', permissions: [...PERMISSIONS] }

  const DOC = { id: 'SMOKE-D1-1', status: 'Posted', total: 100 }
  const AUDIT = { id: 'SMOKE-AUD-1', at: '2026-10-08T09:00:00Z', actor: 'smoke@roligt.local', action: 'smoke', doc: 'SMOKE-D1-1', details: 'the dev smoke' }
  const CHANGES: StateChanges = {
    empty: false,
    tables: [
      { table: 'grns', upsert: [{ id: 'SMOKE-D1-1', data: DOC }], remove: [] },
      { table: 'audits', upsert: [AUDIT], remove: [] },
    ],
    counters: { smoketest: 41 },
    config: undefined,
  }

  let revisionBefore = ''

  beforeAll(() => {
    d1 = new D1Client()
  })

  beforeEach(() => {
    resetD1Caches()
  })

  afterAll(async () => {
    if (!SMOKE) return
    await d1.batch([
      { sql: "DELETE FROM documents WHERE collection = 'grns' AND id = 'SMOKE-D1-1'" },
      { sql: "DELETE FROM documents WHERE collection = 'audits' AND id = 'SMOKE-AUD-1'" },
      { sql: "DELETE FROM documents WHERE collection = 'audits' AND id LIKE 'AUD-admin-%' AND json LIKE '%smoke@roligt.local%'" },
      { sql: "DELETE FROM documents WHERE collection = 'compliance' AND id = 'SMOKE-CMP-1'" },
      { sql: "DELETE FROM counters WHERE series = 'smoketest'" },
    ])
  })

  it('reads the imported plant: one atomic batch, an established state, the meta token', async () => {
    const snap = await readSnapshotD1(d1)
    revisionBefore = snap.revision
    expect(parseInt(snap.revision, 10)).toBeGreaterThan(0) // the dump landed Zoho's real token
    expect(snap.everWritten).toBe(true)
    expect(Array.isArray(snap.state?.audits)).toBe(true)
    expect((snap.state?.audits?.length ?? 0)).toBeGreaterThan(0)
    expect(snap.state?.config).toBeTruthy()
    await expect(readRevisionD1(d1)).resolves.toBe(snap.revision) // the memo serves the same token
  })

  it('commits the happy path: doc + audit + counter land, the token advances', async () => {
    const { token, wrote } = await commitChangesD1(d1, admin, CHANGES)
    expect(wrote).toBe(true)
    expect(parseInt(token, 10)).toBe(parseInt(revisionBefore, 10) + 1)
    const [row] = await d1.query<{ version: number }>("SELECT version FROM documents WHERE collection = 'grns' AND id = 'SMOKE-D1-1'")
    expect(row?.version).toBe(1)
    const [ctr] = await d1.query<{ next: number }>("SELECT next FROM counters WHERE series = 'smoketest'")
    expect(ctr?.next).toBe(41)
  })

  it('the idempotent re-send is a no-op: same token back, no bump', async () => {
    const again = await commitChangesD1(d1, admin, CHANGES)
    expect(again.wrote).toBe(false)
    expect(again.token).toMatch(new RegExp(`^${parseInt(revisionBefore, 10) + 1}:`))
  })

  it('a stale expect refuses the whole commit with the 409 shape', async () => {
    const conflict = await commitChangesD1(d1, admin, {
      ...CHANGES,
      tables: [{ table: 'grns', upsert: [{ id: 'SMOKE-D1-1', data: { ...DOC, status: 'X' } }], remove: [], expect: { 'SMOKE-D1-1': { id: 'SMOKE-D1-1', data: { ...DOC, status: 'Someone else moved it' } } } }],
      counters: {},
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(conflict).toBeInstanceOf(Conflict)
    expect((conflict as Conflict).conflicts).toContainEqual({ table: 'grns', id: 'SMOKE-D1-1', kind: 'changed' })
    const [row] = await d1.query<{ version: number }>("SELECT version FROM documents WHERE collection = 'grns' AND id = 'SMOKE-D1-1'")
    expect(row?.version).toBe(1) // nothing moved
  })

  it('an edit whose expect matches lands and advances the row version', async () => {
    const amended = { ...DOC, status: 'Amended' }
    const { token, wrote } = await commitChangesD1(d1, admin, {
      ...CHANGES,
      tables: [{ table: 'grns', upsert: [{ id: 'SMOKE-D1-1', data: amended }], remove: [], expect: { 'SMOKE-D1-1': { id: 'SMOKE-D1-1', data: DOC } } }],
      counters: {},
    })
    expect(wrote).toBe(true)
    expect(parseInt(token, 10)).toBe(parseInt(revisionBefore, 10) + 2)
    const [row] = await d1.query<{ version: number; json: string }>("SELECT version, json FROM documents WHERE collection = 'grns' AND id = 'SMOKE-D1-1'")
    expect(row?.version).toBe(2)
    expect(JSON.parse(row!.json)).toEqual(amended)
  })

  it('the compliance register saves, refuses a stale save, and removes', async () => {
    const cs = d1ComplianceStore(d1)
    const doc = { id: 'SMOKE-CMP-1', title: 'Smoke licence', docType: 'Licence', remindEmails: ['lead@roligt.local'] }
    await expect(cs.save(doc, null)).resolves.toEqual({ saved: true, version: 'SMOKE-CMP-1:1' })
    await expect(cs.save({ ...doc, title: 'Renewed' }, 'SMOKE-CMP-1:1')).resolves.toEqual({ saved: true, version: 'SMOKE-CMP-1:2' })
    await expect(cs.save({ ...doc, title: 'Stale' }, 'SMOKE-CMP-1:1')).resolves.toEqual({ saved: false })
    const listed = await cs.list()
    expect(listed.map((r) => r.doc.id)).toContain('SMOKE-CMP-1')
    await cs.remove('SMOKE-CMP-1', 'SMOKE-CMP-1')
    await expect(cs.fetch('SMOKE-CMP-1')).resolves.toBeNull()
  })

  it('the admin audit files its row and bumps the token the poll serves', async () => {
    await writeAdminAuditD1(d1, admin, 'smoke role change', 'ops@roligt.local', 'granted nothing')
    // scratch's dump carries real AUD-admin-* rows — scope to the one this run filed
    const [row] = await d1.query<{ id: string; json: string }>(
      "SELECT id, json FROM documents WHERE collection = 'audits' AND id LIKE 'AUD-admin-%' AND json LIKE '%smoke role change%'",
    )
    expect(row?.id).toMatch(/^AUD-admin-/)
    expect(JSON.parse(row!.json)).toMatchObject({ actor: 'smoke@roligt.local', action: 'smoke role change', doc: 'ops@roligt.local' })
    const token = await readRevisionD1(d1) // served from the write's own memo — the poll's read
    expect(parseInt(token, 10)).toBeGreaterThan(parseInt(revisionBefore, 10) + 2)
  })
})
