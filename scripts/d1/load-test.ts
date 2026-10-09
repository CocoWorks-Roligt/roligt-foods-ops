#!/usr/bin/env npx tsx
/**
 * The D1 load test — the question the Zoho years never answered until
 * production asked it: what does the store do when the plant actually leans on
 * it? Runs ONLY against roligt-ops-scratch (the database is resolved BY NAME
 * and the run refuses anything else), drives the REAL engine modules over the
 * REAL REST client, and cleans up every row it writes.
 *
 * Phases (each prints its own table; a JSON summary lands at the end):
 *   0  census        — the baseline this run must leave behind when it ends
 *   1  volume        — ROWS melange-shaped documents through commitChangesD1
 *                      in honest-client commits (≤16 rows each), plus the
 *                      idempotent re-send contract under load
 *   2  boundary      — the REST shapes the app never sends but cutover day
 *                      might: a 1000-statement batch, a 101-param IN, and a
 *                      snapshot read with the volume rows present (rows_read)
 *   3  concurrency   — W disjoint writers (expect zero conflicts), a contended
 *                      row raced by every worker per round (expect exactly one
 *                      winner — the assert's CHECK under real contention), and
 *                      readers looping full snapshots mid-write
 *   4  sustain       — S seconds of mixed revision-poll + commit traffic at
 *                      the natural rate; counts 429 / overloaded / 5xx
 *   5  integrity     — counts, versions, the revision's monotonic advance
 *   6  cleanup       — every LOAD-* row gone, the census back at baseline (the
 *                      revision stays ahead — monotonic by design; scratch)
 *
 * Credentials: D1_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN from the env win
 * (the smoke's path); otherwise wrangler's own d1:write OAuth token is read
 * from its toml and the account is resolved live — same flow as the Phase-0
 * probe and the smoke runner. The token is never printed.
 *
 * usage: npx tsx scripts/d1/load-test.ts [--rows 1000] [--workers 8]
 *                                        [--sustain-secs 60] [--skip-cleanup]
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
const ROWS = arg('rows', 1000)
const WORKERS = arg('workers', 8)
const SUSTAIN_SECS = arg('sustain-secs', 60)
const SKIP_CLEANUP = process.argv.includes('--skip-cleanup')

const SCRATCH_NAME = 'roligt-ops-scratch'
const PROD_UUID = 'de8175f2-567d-492f-b2f4-63736fb1d402' // refused even if the env names it
const PREFIX = 'LOAD-'
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
    console.error('refusing: this is the PRODUCTION database — the load test runs on scratch only')
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
/** Raw REST — measurement and one-shot probes only; behavior goes through the
 *  engine. Never throws: the boundary probes want the refusal envelopes. */
async function rest(body: unknown): Promise<RestOut> {
  const res = await fetch(REST, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => null)) as Omit<RestOut, 'status'> | null
  if (!json) return { status: res.status, success: false, errors: [{ message: `HTTP ${res.status}, unparsable body` }] }
  return { status: res.status, ...json }
}
/** A one-statement read that DOES throw, classified — the poll loop's traffic
 *  must count its 429/overload refusals, not swallow them as fast empties. */
async function one(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const out = await rest({ sql, params })
  if (out.status === 429) throw new Error('http-429')
  if (out.status >= 400) throw new Error(`http-${out.status}`)
  if (!out.success) throw new Error('d1-refused')
  return out.result?.[0]?.results ?? []
}

// ---- harness ----
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
const phase = (name: string, note = ''): void => console.log(`\n=== ${name}${note ? ` — ${note}` : ''} ===`)

// a melange-shaped document: a real collection's realistic width, components and all
const melangeDoc = (i: number) => ({
  id: `${PREFIX}MEL-${String(i).padStart(4, '0')}`,
  name: `Load blend ${i}`,
  stage: 'Blending',
  outputItem: 'ITM-COCOA-500',
  plannedKg: 120 + (i % 37),
  components: [
    { lotId: `LOT-2026${String(1000 + (i % 91))}`, item: 'ITM-COCOA-RAW', kg: 60 + (i % 11) },
    { lotId: `LOT-2026${String(2000 + (i % 73))}`, item: 'ITM-SUGAR', kg: 40 + (i % 7) },
    { lotId: `LOT-2026${String(3000 + (i % 53))}`, item: 'ITM-BUTTER', kg: 20 + (i % 5) },
  ],
  notes: 'load-test row',
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

// ============================================================ 0. census
phase('0 census', 'the baseline the run must restore')
const census = async () => {
  const rows = (await one('SELECT collection, COUNT(*) AS n FROM documents GROUP BY collection ORDER BY collection')) as { collection: string; n: number }[]
  const [rev] = await one("SELECT value FROM meta WHERE setting = 'app_revision'")
  const [ctrs] = await one('SELECT COUNT(*) AS n FROM counters')
  return { collections: rows, revision: String(rev?.value ?? '0'), counters: Number(ctrs?.n ?? 0) }
}
const before = await census()
console.log(`revision ${before.revision} · ${before.counters} counter series · collections: ${before.collections.map((c) => `${c.collection}:${c.n}`).join(' ')}`)
// a re-run after an aborted attempt must start clean
await rest({ sql: `DELETE FROM documents WHERE id LIKE '${PREFIX}%'` })
await rest({ sql: "DELETE FROM counters WHERE series = 'loadtest'" })

const summary: { phases: Record<string, unknown> } = { phases: {} }

// ============================================================ 1. volume
phase('1 volume', `${ROWS} melange documents through the engine, honest ≤16-row commits`)
{
  const docs = Array.from({ length: ROWS }, (_, i) => melangeDoc(i))
  const commits = chunk(docs.map((d) => ({ id: d.id, data: d })), 16)
  const vol = new Recorder()
  const t0 = Date.now()
  for (const c of commits) {
    await vol.run(() => commitChangesD1(d1, caller, melangeCommit(c)))
  }
  const wallS = (Date.now() - t0) / 1000
  console.log(`${commits.length} commits in ${wallS.toFixed(1)} s (${(ROWS / wallS).toFixed(1)} rows/s) — per-commit RTT:`)
  console.log(`  ${vol.report()}`)
  const [row] = await one(`SELECT COUNT(*) AS n FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}MEL-%'`) as { n?: number }[]
  const [revRow] = await one("SELECT value FROM meta WHERE setting = 'app_revision'")
  const advanced = parseRevision(revRow?.value) - parseRevision(before.revision)
  console.log(`melanges landed: ${row?.n} / ${ROWS} · revision advanced by ${advanced} (expect ${commits.length}) · token now ${revRow?.value}`)
  summary.phases.volume = { rows: ROWS, commits: commits.length, wallSecs: +wallS.toFixed(1), commitRtt: vol.report(), landed: row?.n, revisionAdvance: advanced }
  // the idempotent re-send: the exact last commit again — wrote:false, no bump
  resetD1Caches()
  const again = await commitChangesD1(d1, caller, melangeCommit(commits[commits.length - 1]))
  const [revRow2] = await one("SELECT value FROM meta WHERE setting = 'app_revision'")
  const idem = { wrote: again.wrote, tokenUnchanged: revRow2?.value === revRow?.value }
  console.log(`idempotent re-send: wrote=${idem.wrote} token unchanged=${idem.tokenUnchanged}`)
  summary.phases.volume.idempotentResend = idem
}

// ============================================================ 2. boundary
phase('2 boundary', 'REST shapes cutover day might send')
{
  // 2a — one batch of 1000 statements (the import/restore shape; the engine never sends this)
  const stmts = Array.from({ length: 1000 }, (_, i) => ({
    sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('grns', ?, ?, 1, ?) ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json`,
    params: [`${PREFIX}B1-${i}`, JSON.stringify({ id: `${PREFIX}B1-${i}`, marker: 'boundary' }), nowIso()],
  }))
  const t0 = Date.now()
  const big = await rest({ batch: stmts })
  const bigMs = Date.now() - t0
  const [b1] = await one(`SELECT COUNT(*) AS n FROM documents WHERE collection = 'grns' AND id LIKE '${PREFIX}B1-%'`) as { n?: number }[]
  console.log(`2a single 1000-statement batch: success=${big.success} landed=${b1?.n} in ${bigMs} ms${big.success ? '' : ` errors=${JSON.stringify(big.errors).slice(0, 300)}`}`)
  summary.phases.batch1000 = { success: big.success, landed: b1?.n, ms: bigMs }
  await rest({ sql: `DELETE FROM documents WHERE collection = 'grns' AND id LIKE '${PREFIX}B1-%'` })

  // 2b — a 101-param IN: the preflight's bound (the 16-row ceiling keeps the app at ≤17)
  const params101 = Array.from({ length: 101 }, (_, i) => `${PREFIX}x-${i}`)
  const in101 = await rest({ sql: `SELECT id FROM documents WHERE collection = 'melanges' AND id IN (${params101.map(() => '?').join(',')})`, params: params101 })
  console.log(`2b 101-param IN(): success=${in101.success}${in101.success ? ' (unexpected — the bound is per-query)' : ` · refused: ${JSON.stringify(in101.errors).slice(0, 240)}`}`)
  summary.phases.in101 = { success: in101.success }

  // 2c — the snapshot read with the volume rows present: latency + rows_read
  resetD1Caches()
  const t1 = performance.now()
  const snap = await readSnapshotD1(d1)
  const snapMs = Math.round(performance.now() - t1)
  const snapBatch = await rest({
    batch: [
      ...WIRE_TABLES.map((t) => ({ sql: 'SELECT id, json FROM documents WHERE collection = ? ORDER BY id LIMIT 10001', params: [t] })),
      { sql: 'SELECT series, next FROM counters' },
      { sql: 'SELECT setting, value FROM meta' },
    ],
  })
  const rowsRead = snapBatch.result?.reduce((a, r) => a + (Number(r.meta?.rows_read) || 0), 0) ?? 0
  const melangesIn = ((snap.state as { melanges?: unknown[] } | undefined)?.melanges?.length ?? 0)
  console.log(`2c snapshot: engine ${snapMs} ms · rest batch rows_read=${rowsRead} · melanges in state=${melangesIn}`)
  summary.phases.snapshot = { engineMs: snapMs, rowsRead, melangesInState: melangesIn }
}

// ============================================================ 3. concurrency
phase('3 concurrency', `${WORKERS} workers — disjoint writes, one contended row, snapshot readers`)
{
  // 3a — disjoint: each worker edits only its own rows; a conflict here is a bug
  const dis = new Recorder()
  const disjointWork = (w: number) => {
    const own = Array.from({ length: 10 }, (_, k) => ({ id: `${PREFIX}W${w}-${k}`, data: { ...melangeDoc(0), id: `${PREFIX}W${w}-${k}`, worker: w, k } }))
    return (async () => {
      for (const c of chunk(own, 5)) await dis.run(() => commitChangesD1(d1, caller, melangeCommit(c)))
    })()
  }
  const t0 = Date.now()
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => disjointWork(w)))
  const disWall = Date.now() - t0
  const [dw] = await one(`SELECT COUNT(*) AS n FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}W%'`) as { n?: number }[]
  console.log(`3a disjoint (${WORKERS}×10 rows): wall=${disWall} ms (${(WORKERS * 10) / (disWall / 1000)} rows/s) landed=${dw?.n}`)
  console.log(`  ${dis.report()}`)
  summary.phases.disjoint = { wallMs: disWall, recorder: dis.report(), landed: dw?.n }

  // 3b — contended: every worker races the same row with the same basis each
  // round; exactly one win per round is the assert's whole contract
  const ctn = new Recorder()
  let wins = 0
  let idempotentEchoes = 0
  const ROUNDS = 10
  // ONE frozen basis — createdAt must not drift between the write and the next
  // round's expect, or every racer 409s on a basis that never was
  const ctnBase = melangeDoc(0)
  const docAt = (r: number) => ({ id: `${PREFIX}CTN`, data: { ...ctnBase, id: `${PREFIX}CTN`, round: r } })
  await commitChangesD1(d1, caller, melangeCommit([docAt(0)])) // the row everyone fights over
  const t1 = Date.now()
  for (let r = 1; r <= ROUNDS; r++) {
    const next = docAt(r)
    const expect = { [`${PREFIX}CTN`]: docAt(r - 1) }
    const round = await Promise.allSettled(
      Array.from({ length: WORKERS }, () =>
        commitChangesD1(d1, caller, { empty: false, tables: [{ table: 'melanges', upsert: [next], remove: [], expect }], counters: {}, config: undefined }),
      ),
    )
    for (const s of round) {
      // a fulfilled racer that wrote is the round's winner; one that wrote
      // nothing saw the winner's exact document already stored — the idempotent
      // echo, NOT a second write (the version count below proves the pair)
      if (s.status === 'fulfilled') {
        if (s.value.wrote) wins++
        else idempotentEchoes++
      } else ctn.fail(s.reason instanceof Conflict ? 'conflict-409' : (s.reason as Error)?.message || 'unknown')
    }
  }
  const ctnWall = Date.now() - t1
  const [row] = await one(`SELECT version, json FROM documents WHERE collection = 'melanges' AND id = '${PREFIX}CTN'`) as { version?: number; json?: string }[]
  const finalRound = (JSON.parse(row?.json ?? 'null') as { round?: number })?.round
  console.log(`3b contended (${ROUNDS} rounds × ${WORKERS} racers): wrote-true=${wins} (expect ${ROUNDS}) · idempotent echoes=${idempotentEchoes} · 409s=${ctn.errors['conflict-409'] ?? 0} · final version=${row?.version} (expect ${ROUNDS + 1}) · final round=${finalRound} (expect ${ROUNDS}) wall=${ctnWall} ms`)
  console.log(`  ${ctn.report()}`)
  summary.phases.contended = { wroteTrue: wins, expectedWins: ROUNDS, idempotentEchoes, finalVersion: row?.version, finalRound, wallMs: ctnWall, recorder: ctn.report() }

  // 3c — readers looping full snapshots while a writer keeps committing
  const rd = new Recorder()
  const wr = new Recorder()
  let stop = false
  const writer = (async () => {
    let i = 0
    while (!stop) {
      const id = `${PREFIX}RW-${i}`
      const out = await wr.run(() => commitChangesD1(d1, caller, melangeCommit([{ id, data: { ...melangeDoc(0), id } }])))
      if (out) i++
    }
  })()
  const reader = (async () => {
    while (!stop) {
      resetD1Caches() // no memo shelter — every read is the real batch
      await rd.run(() => readSnapshotD1(d1))
    }
  })()
  await new Promise((r) => setTimeout(r, 15_000))
  stop = true
  await Promise.all([writer, reader])
  console.log(`3c mixed (15 s): writer — ${wr.report()}`)
  console.log(`             reader — ${rd.report()}`)
  summary.phases.mixed = { writer: wr.report(), reader: rd.report() }
}

// ============================================================ 4. sustain
phase('4 sustain', `${SUSTAIN_SECS} s of revision polls + commits at the natural rate`)
{
  const polls = new Recorder()
  const commits = new Recorder()
  const stopAt = Date.now() + SUSTAIN_SECS * 1000
  const worker = async (w: number): Promise<void> => {
    let i = 0
    while (Date.now() < stopAt) {
      await polls.run(() => one("SELECT value FROM meta WHERE setting = 'app_revision'"))
      if (w === 0) {
        const id = `${PREFIX}S-${i}`
        const out = await commits.run(() => commitChangesD1(d1, caller, melangeCommit([{ id, data: { ...melangeDoc(0), id } }])))
        if (out) i++
      }
    }
  }
  const t0 = Date.now()
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)))
  const wall = (Date.now() - t0) / 1000
  const totalOps = polls.n + commits.n
  console.log(`${totalOps} ops in ${wall.toFixed(1)} s = ${(totalOps / wall).toFixed(1)} ops/s`)
  console.log(`  poll — ${polls.report()}`)
  console.log(`  commit — ${commits.report()}`)
  summary.phases.sustain = { wallSecs: +wall.toFixed(1), opsPerSec: +(totalOps / wall).toFixed(1), poll: polls.report(), commit: commits.report() }
}

// ============================================================ 5. integrity
phase('5 integrity', 'counts, versions, monotonic revision')
{
  const after = await census()
  const [mel] = await one(`SELECT COUNT(*) AS n, MIN(version) AS minv, MAX(version) AS maxv FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}%'`) as { n?: number; minv?: number; maxv?: number }[]
  const revDelta = parseRevision(after.revision) - parseRevision(before.revision)
  const spot = (await one(`SELECT json FROM documents WHERE collection = 'melanges' AND id LIKE '${PREFIX}MEL-%' LIMIT 10`)) as { json?: string }[]
  const spotOk = spot.every((r) => {
    const d = JSON.parse(r.json ?? 'null') as { components?: unknown[] }
    return Array.isArray(d.components) && d.components.length === 3
  })
  console.log(`LOAD melanges rows: ${mel?.n} (min v=${mel?.minv} max v=${mel?.maxv}) · revision +${revDelta} · components round-trip: ${spotOk ? 'ok' : 'FAILED'}`)
  summary.phases.integrity = { loadRows: mel?.n, minVersion: mel?.minv, maxVersion: mel?.maxv, revisionDelta: revDelta, componentsRoundTrip: spotOk }
}

// ============================================================ 6. cleanup
phase('6 cleanup', SKIP_CLEANUP ? 'SKIPPED (--skip-cleanup)' : 'every LOAD row gone')
if (!SKIP_CLEANUP) {
  const del = await rest({
    batch: [
      { sql: `DELETE FROM documents WHERE id LIKE '${PREFIX}%'` },
      { sql: "DELETE FROM counters WHERE series = 'loadtest'" },
    ],
  })
  console.log(`cleanup batch success=${del.success}`)
  const after = await census()
  const same = JSON.stringify(after.collections) === JSON.stringify(before.collections)
  const ahead = parseRevision(after.revision) > parseRevision(before.revision)
  console.log(`collections back to baseline: ${same ? 'yes' : `NO — ${JSON.stringify(after.collections)}`} · revision still ahead (monotonic): ${ahead}`)
  summary.phases.cleanup = { baselineRestored: same, revisionStillAhead: ahead }
}

console.log('\n=== summary ===')
console.log(JSON.stringify(summary, null, 2))
