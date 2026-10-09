#!/usr/bin/env npx tsx
/**
 * The incremental ladder — the full-scale run answered "does 1000 hold?"; this
 * one answers "how do the timings MOVE as the plant grows to 1000?" — the
 * question a growth curve actually needs. Same rules as the load test:
 * roligt-ops-scratch only (the database is resolved BY NAME and the run
 * refuses anything else, prod UUID included even if the env names it), the
 * REAL engine modules over the REAL REST client, and every row cleaned up.
 *
 * The ladder climbs in STEP-doc rungs (default 100) to MAX docs (default
 * 1000). Each rung adds its STEP blend documents through commitChangesD1 in
 * honest ≤16-row commits, then — with the plant AT that volume — measures the
 * four timings that can move with size:
 *   commit RTT      the rung's own add-commits, plus 3 update-commits of one
 *                   existing row (a commit priced at the FULL rung, not the
 *                   growth band crossing under it)
 *   poll p50        the revision heartbeat, raw REST — what a cold instance
 *                   pays every 20 s per client (the engine's 4 s memo would
 *                   flatter it)
 *   point read p50  the preflight shape — one document by id, the hottest
 *                   single read the app sends
 *   snapshot p50    the offline-first sync's heavy path, memo-broken so every
 *                   sample is the real 26-SELECT batch, plus its rows_read
 *                   (the free-tier meter that scales with the plant)
 *
 * One table at the end, markdown-ready for the load-test doc.
 *
 * usage: npx tsx scripts/d1/load-test-incremental.ts [--step 100] [--max 1000]
 *                                                     [--skip-cleanup]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { D1ApiError, D1Client } from '../../api/_lib/d1.js'
import { commitChangesD1 } from '../../api/_lib/d1Commit.js'
import { readSnapshotD1, resetD1Caches } from '../../api/_lib/d1Snapshot.js'
import { Conflict } from '../../api/_lib/commitGates.js'
import { WIRE_TABLES } from '../../api/_lib/registry.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import type { Caller } from '../../api/_lib/auth.js'
import type { StateChanges } from '../../src/lib/sync.js'

// ---- flags ----
const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt
}
const STEP = arg('step', 100)
const MAX = arg('max', 1000)
const SKIP_CLEANUP = process.argv.includes('--skip-cleanup')
if (MAX % STEP !== 0) throw new Error(`--max ${MAX} is not a multiple of --step ${STEP}`)

const SCRATCH_NAME = 'roligt-ops-scratch'
const PROD_UUID = 'de8175f2-567d-492f-b2f4-63736fb1d402' // refused even if the env names it
const PREFIX = 'LOADINC-' // disjoint from the load test's LOAD-: either script's cleanup leaves the other's rows alone
const caller: Caller = { email: 'loadtest@roligt.local', permissions: [...PERMISSIONS] }
const nowIso = () => new Date().toISOString()

// ---- credentials: env first, else wrangler's OAuth toml (never printed) ----
function tomlToken(): string {
  const f = join(process.env.HOME ?? '.', 'Library/Preferences/.wrangler/config/default.toml')
  return /^oauth_token = "([^"]+)"/m.exec(readFileSync(f, 'utf8'))[1]
}
const CF = process.env.D1_API_BASE || 'https://api.cloudflare.com'
if (!process.env.D1_ACCOUNT_ID || !process.env.D1_DATABASE_ID || !process.env.D1_API_TOKEN) {
  try {
    for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
    }
  } catch {
    /* no .env — fall through to wrangler */
  }
}
const token = process.env.D1_API_TOKEN || tomlToken()
if (!token) throw new Error('no D1 credential: pass D1_API_TOKEN or log in with wrangler')
const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

// Resolve account (when only the token is known — wrangler's flow), then the
// database BY NAME; refuse anything that is not scratch.
if (!process.env.D1_ACCOUNT_ID) {
  const me = await (await fetch(`${CF}/client/v4/accounts`, { headers: authHeaders })).json()
  if (!me.success) throw new Error(`account discovery failed: ${JSON.stringify(me.errors)}`)
  const ids: string[] = me.result.map((a: { id: string }) => a.id)
  const found: string[] = []
  for (const id of ids) {
    const dbs = await (await fetch(`${CF}/client/v4/accounts/${id}/d1/database`, { headers: authHeaders })).json()
    if (dbs.success && dbs.result.some((d: { name: string }) => d.name === SCRATCH_NAME)) found.push(id)
  }
  if (found.length !== 1) throw new Error(`expected exactly one account holding ${SCRATCH_NAME}, found ${found.length}`)
  process.env.D1_ACCOUNT_ID = found[0]
}
{
  const dbs = await (await fetch(`${CF}/client/v4/accounts/${process.env.D1_ACCOUNT_ID}/d1/database`, { headers: authHeaders })).json()
  if (!dbs.success) throw new Error(`database discovery failed: ${JSON.stringify(dbs.errors)}`)
  const scratch = dbs.result.find((d: { name: string }) => d.name === SCRATCH_NAME)
  const claimed = process.env.D1_DATABASE_ID ? dbs.result.find((d: { uuid: string }) => d.uuid === process.env.D1_DATABASE_ID) : scratch
  if (claimed?.uuid === PROD_UUID || scratch?.uuid === PROD_UUID) {
    console.error('refusing: this is the PRODUCTION database — the ladder runs on scratch only')
    process.exit(1)
  }
  if (!scratch) throw new Error(`no database named ${SCRATCH_NAME} in this account`)
  if (process.env.D1_DATABASE_ID && process.env.D1_DATABASE_ID !== scratch.uuid) {
    console.error(`refusing: D1_DATABASE_ID names ${claimed?.name ?? 'unknown'}, not ${SCRATCH_NAME}`)
    process.exit(1)
  }
  process.env.D1_DATABASE_ID = scratch.uuid
}
process.env.D1_API_TOKEN = token
const d1 = new D1Client()
const REST = `${CF}/client/v4/accounts/${process.env.D1_ACCOUNT_ID}/d1/database/${process.env.D1_DATABASE_ID}/query`

interface RestOut {
  status: number
  success: boolean
  result?: { results?: unknown[]; meta?: Record<string, unknown> }[]
  errors?: unknown[]
}
/** Raw REST — measurement only; behavior goes through the engine. Never
 *  throws: the rows_read probe wants refusal envelopes unmangled. */
async function rest(body: unknown): Promise<RestOut> {
  const res = await fetch(REST, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => null)) as Omit<RestOut, 'status'> | null
  if (!json) return { status: res.status, success: false, errors: [{ message: `HTTP ${res.status}, unparsable body` }] }
  return { status: res.status, ...json }
}
/** A one-statement read that DOES throw, classified — a timed sample that
 *  429s must count as an error, not pass as a fast empty. */
async function one(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const out = await rest({ sql, params })
  if (out.status === 429) throw new Error('http-429')
  if (out.status >= 400) throw new Error(`http-${out.status}`)
  if (!out.success) throw new Error('d1-refused')
  return out.result?.[0]?.results ?? []
}

// ---- harness (the load test's own Recorder, verbatim) ----
class Recorder {
  private samples: number[] = []
  readonly errors: Record<string, number> = {}
  fail(kind: string): void {
    this.errors[kind] = (this.errors[kind] ?? 0) + 1
  }
  async run<T>(fn: () => Promise<T>): Promise<T | null> {
    const t0 = performance.now()
    try {
      const out = await fn()
      this.samples.push(performance.now() - t0)
      return out
    } catch (e) {
      this.samples.push(performance.now() - t0)
      this.fail(
        e instanceof Conflict
          ? 'conflict-409'
          : e instanceof D1ApiError
            ? `api-${e.code ?? 'refused'}`
            : e instanceof Error && e.constructor.name !== 'Error'
              ? e.constructor.name
              : ((e as Error)?.message || 'unknown'),
      )
      return null
    }
  }
  get n(): number {
    return this.samples.length
  }
  get errorCount(): number {
    return Object.values(this.errors).reduce((a, b) => a + b, 0)
  }
  pct(p: number): number {
    if (!this.samples.length) return 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))])
  }
  max(): number {
    return this.samples.length ? Math.round(Math.max(...this.samples)) : 0
  }
  report(): string {
    const errs = this.errorCount ? `  errors: ${JSON.stringify(this.errors)}` : '  errors: none'
    return `n=${this.n}  p50=${this.pct(50)}ms  p95=${this.pct(95)}ms  p99=${this.pct(99)}ms  max=${this.max()}ms${errs}`
  }
}

// a blend-recipe-shaped document: the load test's own row, so rungs are comparable rung-for-rung
const melangeDoc = (i: number) => ({
  id: `${PREFIX}MEL-${String(i).padStart(4, '0')}`,
  name: `Ladder blend ${i}`,
  stage: 'Blending',
  outputItem: 'ITM-COCOA-500',
  plannedKg: 120 + (i % 37),
  components: [
    { lotId: `LOT-2026${String(1000 + (i % 91))}`, item: 'ITM-COCOA-RAW', kg: 60 + (i % 11) },
    { lotId: `LOT-2026${String(2000 + (i % 73))}`, item: 'ITM-SUGAR', kg: 40 + (i % 7) },
    { lotId: `LOT-2026${String(3000 + (i % 53))}`, item: 'ITM-BUTTER', kg: 20 + (i % 5) },
  ],
  notes: 'ladder row',
  createdAt: nowIso(),
})
/** chunk into honest-client commits (≤16 rows — validateChanges' ceiling) */
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
const melangeCommit = (docs: { id: string; data: unknown }[]): StateChanges => ({
  empty: false,
  tables: [{ table: 'melanges', upsert: docs, remove: [] }],
  counters: {},
  config: undefined,
})
const parseRevision = (t: unknown): number => Number.parseInt(String(t ?? ''), 10) || 0

// ============================================================ baseline
console.log(`incremental ladder — step ${STEP} to max ${MAX}, scratch only`)
const census = async () => {
  const rows = (await one('SELECT collection, COUNT(*) AS n FROM documents GROUP BY collection ORDER BY collection')) as { collection: string; n: number }[]
  const [rev] = await one("SELECT value FROM meta WHERE setting = 'app_revision'")
  return { collections: rows, revision: String(rev?.value ?? '0') }
}
// sweep FIRST, census second: a re-run after an aborted attempt must measure
// its baseline against a swept base, or cleanup's compare sees ghost rows
await rest({ sql: `DELETE FROM documents WHERE id LIKE '${PREFIX}%'` })
const before = await census()
console.log(`revision ${before.revision} at start · collections: ${before.collections.map((c) => `${c.collection}:${c.n}`).join(' ')}`)

interface Rung {
  level: number
  docsInPlant: number
  addCommits: number
  addWallSecs: number
  addRowsPerSec: number
  addP50: number
  addP95: number
  addMax: number
  updP50: number
  pollP50: number
  pointP50: number
  snapP50: number
  snapMax: number
  rowsRead: number
  melangesInState: number
  landed: number
  revisionAdvance: number
  errors: number
}
const rungs: Rung[] = []
let revisionSoFar = parseRevision(before.revision)
let lastAdd: StateChanges | null = null // the top rung's final add-commit, re-sent verbatim at the summit

// ============================================================ the ladder
for (let level = STEP; level <= MAX; level += STEP) {
  // -- add this rung's rows (ids continue numbering; every rung writes new docs)
  const docs = Array.from({ length: STEP }, (_, k) => melangeDoc(level - STEP + k))
  const commits = chunk(docs.map((d) => ({ id: d.id, data: d })), 16)
  const add = new Recorder()
  const t0 = Date.now()
  for (const c of commits) {
    await add.run(() => commitChangesD1(d1, caller, melangeCommit(c)))
  }
  const addWall = (Date.now() - t0) / 1000
  // the rung's last add-commit, kept verbatim for the idempotent re-send at the top
  lastAdd = melangeCommit(commits[commits.length - 1])

  // -- 3 update-commits of one existing row: a commit priced at the FULL rung.
  // The basis threads through the chain as the WRAPPED {id, data} wire row —
  // the preflight unwraps expect's .data for spec collections, so a bare doc
  // would compare against {} and 409 'changed' (the second draft's lesson);
  // and no expect at all is the 409 'exists' the first draft proved 10×.
  const upd = new Recorder()
  const updId = docs[0].id
  let basis: { id: string; data: unknown } = { id: updId, data: docs[0] }
  for (let u = 1; u <= 3; u++) {
    const next = { ...docs[0], update: u }
    await upd.run(() =>
      commitChangesD1(d1, caller, {
        empty: false,
        tables: [{ table: 'melanges', upsert: [{ id: updId, data: next }], remove: [], expect: { [updId]: basis } }],
        counters: {},
        config: undefined,
      }),
    )
    basis = { id: updId, data: next }
  }

  // -- landed / revision checks for the whole rung's work
  const [row] = await one(`SELECT COUNT(*) AS n FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}MEL-%'`) as { n?: number }[]
  const [tot] = await one('SELECT COUNT(*) AS n FROM documents') as { n?: number }[]
  const [revRow] = await one("SELECT value FROM meta WHERE setting = 'app_revision'")
  const revisionAdvance = parseRevision(revRow?.value) - revisionSoFar
  revisionSoFar = parseRevision(revRow?.value)

  // -- the timings at this volume: poll, point read, snapshot (+ rows_read)
  const poll = new Recorder()
  for (let s = 0; s < 5; s++) await poll.run(() => one("SELECT value FROM meta WHERE setting = 'app_revision'"))
  const point = new Recorder()
  for (let s = 0; s < 5; s++) await point.run(() => one('SELECT id, json FROM documents WHERE collection = ? AND id = ?', ['melanges', docs[Math.floor(STEP / 2)].id]))
  const snap = new Recorder()
  let melangesInState = 0
  for (let s = 0; s < 3; s++) {
    resetD1Caches() // no memo shelter — every sample is the real 26-SELECT batch
    const out = await snap.run(() => readSnapshotD1(d1))
    if (out) melangesInState = ((out.state as { melanges?: unknown[] } | undefined)?.melanges?.length ?? 0)
  }
  const snapBatch = await rest({
    batch: [
      ...WIRE_TABLES.map((t) => ({ sql: 'SELECT id, json FROM documents WHERE collection = ? ORDER BY id LIMIT 10001', params: [t] })),
      { sql: 'SELECT series, next FROM counters' },
      { sql: 'SELECT setting, value FROM meta' },
    ],
  })
  const rowsRead = snapBatch.result?.reduce((a, r) => a + (Number(r.meta?.rows_read) || 0), 0) ?? 0

  const errors = add.errorCount + upd.errorCount + poll.errorCount + point.errorCount + snap.errorCount
  rungs.push({
    level,
    docsInPlant: Number(tot?.n ?? 0),
    addCommits: commits.length,
    addWallSecs: +addWall.toFixed(1),
    addRowsPerSec: +(STEP / addWall).toFixed(1),
    addP50: add.pct(50),
    addP95: add.pct(95),
    addMax: add.max(),
    updP50: upd.pct(50),
    pollP50: poll.pct(50),
    pointP50: point.pct(50),
    snapP50: snap.pct(50),
    snapMax: snap.max(),
    rowsRead,
    melangesInState,
    landed: Number(row?.n ?? 0),
    revisionAdvance,
    errors,
  })
  const r = rungs[rungs.length - 1]
  console.log(
    `\nrung ${level} — plant at ${r.docsInPlant} docs · landed ${r.landed}/${level} · revision +${revisionAdvance} (expect ${commits.length + 3}) · errors ${errors}`,
  )
  console.log(`  add ${commits.length} commits, wall ${addWall.toFixed(1)} s (${(STEP / addWall).toFixed(1)} rows/s) — ${add.report()}`)
  console.log(`  update@${level} — ${upd.report()}`)
  console.log(`  poll p50 ${r.pollP50} ms (n=${poll.n}) · point p50 ${r.pointP50} ms (n=${point.n}) · snapshot p50 ${r.snapP50}/max ${r.snapMax} ms (n=${snap.n}) · rows_read ${rowsRead} · melanges in state ${melangesInState}`)
}

// ============================================================ integrity + idempotence
const [mel] = await one(`SELECT COUNT(*) AS n, MIN(version) AS minv, MAX(version) AS maxv FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}MEL-%'`) as { n?: number; minv?: number; maxv?: number }[]
const spot = (await one(`SELECT json FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}MEL-%' LIMIT 10`)) as { json?: string }[]
const spotOk = spot.every((r) => {
  const d = JSON.parse(r.json ?? 'null') as { components?: unknown[] }
  return Array.isArray(d.components) && d.components.length === 3
})
// the idempotent re-send at the top of the ladder: the exact last add-commit
// again — no expect, content byte-identical to what's stored, so the engine's
// jsonEq short-circuit answers wrote:false with no bump (a re-send CARRYING an
// expect would be refused in the preflight before identity is even consulted)
const again = await commitChangesD1(d1, caller, lastAdd!)
const [revTop] = await one("SELECT value FROM meta WHERE setting = 'app_revision'")
console.log(`\n=== integrity ===`)
console.log(`ladder rows: ${mel?.n} (expect ${MAX}) · versions ${mel?.minv}..${mel?.maxv} · components round-trip: ${spotOk ? 'ok' : 'FAILED'}`)
console.log(`idempotent re-send at ${MAX}: wrote=${again.wrote} · revision ${revTop?.value} (unchanged since last rung: ${parseRevision(revTop?.value) === revisionSoFar})`)

// ============================================================ cleanup
if (!SKIP_CLEANUP) {
  const del = await rest({ sql: `DELETE FROM documents WHERE id LIKE '${PREFIX}%'` })
  const after = await census()
  const same = JSON.stringify(after.collections) === JSON.stringify(before.collections)
  const ahead = parseRevision(after.revision) > parseRevision(before.revision)
  console.log(`\n=== cleanup ===`)
  console.log(`delete success=${del.success} · collections back to baseline: ${same ? 'yes' : `NO — ${JSON.stringify(after.collections)}`} · revision still ahead (monotonic): ${ahead}`)
}

// ============================================================ the table
console.log(`\n=== ladder — step ${STEP}, max ${MAX} (scratch) ===`)
console.log('| Rung | Docs in plant | Add wall | rows/s | add-commit p50/p95/max | update@rung p50 | poll p50 | point p50 | snapshot p50/max | rows_read | errs |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const r of rungs) {
  console.log(
    `| ${r.level} | ${r.docsInPlant} | ${r.addWallSecs} s | ${r.addRowsPerSec} | ${r.addP50}/${r.addP95}/${r.addMax} | ${r.updP50} | ${r.pollP50} | ${r.pointP50} | ${r.snapP50}/${r.snapMax} | ${r.rowsRead} | ${r.errors} |`,
  )
}

console.log('\n=== summary ===')
console.log(JSON.stringify({ step: STEP, max: MAX, rungs, integrity: { rows: mel?.n, minVersion: mel?.minv, maxVersion: mel?.maxv, componentsRoundTrip: spotOk }, idempotentResend: { wrote: again.wrote } }, null, 2))
