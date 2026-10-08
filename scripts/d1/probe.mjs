#!/usr/bin/env node
/**
 * The D1 REST-behavior probe — Phase 0's hard gate. The whole D1 engine design
 * hangs on three things the Cloudflare docs do not pin for the REST query
 * endpoint (only the Workers binding documents them):
 *
 *   P1  batch atomicity  — does a mid-batch failure roll back the whole batch?
 *   P2  changes() sight  — does changes() in statement N+1 see statement N?
 *                          (assert form A; fallback B is a COUNT(*) subquery)
 *   P3  RETURNING        — are RETURNING rows visible per-statement in the
 *                          batch response? (the revision bump reads its token)
 * plus the failure envelope's exact shape (what d1.ts maps errors from) and
 * the latency of a 26-SELECT batch (the snapshot read).
 *
 * usage: node scripts/d1/probe.mjs
 * Reads D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID from the environment or
 * .env. Creates and drops only its own _probe_* tables; safe to re-run.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const ACCOUNT = process.env.D1_ACCOUNT_ID
const TOKEN = process.env.D1_API_TOKEN
const DATABASE = process.env.D1_DATABASE_ID
if (!ACCOUNT || !TOKEN || !DATABASE) {
  console.error('D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID are required (env or .env).')
  process.exit(1)
}
const URL_BASE = `${process.env.D1_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}`

async function call(body) {
  const res = await fetch(`${URL_BASE}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { _unparsable: text.slice(0, 400) } }
  return { status: res.status, json }
}
const single = (sql, params = []) => call({ sql, params })
const batch = (stmts) => call({ batch: stmts.map(([sql, params = []]) => ({ sql, params })) })
const rowsOf = (r) => r.json?.result?.[0]?.results ?? []

const results = []
const pin = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const failEnvelope = {} // captured failure shapes for d1.ts's error mapping

// health + envelope shape
const health = await single('SELECT 1 AS one')
pin('P0 health: single query returns result[0].results', rowsOf(health)[0]?.one === 1, `HTTP ${health.status}`)

// probe tables (own namespace only)
await single('DROP TABLE IF EXISTS _probe_a')
await single('DROP TABLE IF EXISTS _probe_b')
await single('CREATE TABLE _probe_a (id TEXT PRIMARY KEY)')
await single('CREATE TABLE _probe_b (n INTEGER CHECK (n = 1))')

// P1 batch atomicity: a CHECK violation in statement 3 must roll back statement 2
const atomicBatch = await batch([
  ['DELETE FROM _probe_a'],
  ['INSERT INTO _probe_a VALUES (?)', ['x']],
  ['INSERT INTO _probe_b VALUES (?)', [0]], // CHECK(n=1) violation
])
if (!atomicBatch.json.success) failEnvelope.checkViolation = atomicBatch.json
const afterFail = await single('SELECT COUNT(*) AS c FROM _probe_a')
const atomic = rowsOf(afterFail)[0]?.c === 0
pin('P1 batch atomicity: mid-batch CHECK failure rolled back the whole batch', atomic,
  `count after failed batch = ${rowsOf(afterFail)[0]?.c}; envelope success=${atomicBatch.json.success}`)

// P2a changes() visibility: assert via changes() PASSES when the prior insert landed
const formAOk = await batch([
  ['DELETE FROM _probe_a'],
  ['INSERT INTO _probe_a VALUES (?)', ['y']],
  ['INSERT INTO _probe_b VALUES (changes())'], // 1 ⇒ CHECK passes, iff changes() sees the insert
])
const formAWorks = formAOk.json.success === true && (await single(`SELECT id FROM _probe_a WHERE id='y'`)).json.success
// P2b the assert actually trips: a no-op statement must fail the CHECK
const formATrips = await batch([
  ['DELETE FROM _probe_a'],
  ['DELETE FROM _probe_a'], // zero changes
  ['INSERT INTO _probe_b VALUES (changes())'], // 0 ⇒ CHECK must fail
])
const formATripsWorks = formATrips.json.success === false
if (!formATrips.json.success) failEnvelope.assertTrip = formATrips.json
pin('P2 changes() sees the previous statement in a batch (assert form A viable)', formAWorks === true && formATripsWorks === true,
  `positive=${formAWorks} negative=${formATripsWorks}`)

// P3 RETURNING visibility inside a batch
const returning = await batch([
  ['DELETE FROM _probe_a'],
  ['INSERT INTO _probe_a VALUES (?) ON CONFLICT(id) DO UPDATE SET id = excluded.id RETURNING id', ['r']],
])
const returningRows = returning.json?.result?.[1]?.results
pin('P3 RETURNING rows are visible per-statement in the batch response', Array.isArray(returningRows) && returningRows[0]?.id === 'r',
  JSON.stringify(returningRows).slice(0, 120))

// P4 latency of a 26-SELECT batch (the snapshot read shape)
const t0 = Date.now()
const latency = await batch(Array.from({ length: 26 }, () => ['SELECT COUNT(*) AS c FROM documents']))
const elapsed = Date.now() - t0
pin('P4 a 26-statement SELECT batch answers (latency noted)', latency.json.success === true, `${elapsed} ms`)

// cleanup
await single('DROP TABLE _probe_a')
await single('DROP TABLE _probe_b')

// verdict
const verdict = atomic && formAWorks && formATripsWorks
  ? 'DESIGN A + ASSERT FORM A (atomic batches, changes() asserts)'
  : atomic
    ? 'DESIGN A + ASSERT FORM B (atomic batches, COUNT(*) asserts)'
    : 'DESIGN B (no batch atomicity — idempotent-first write batch, guard misses detected after landing, bump only when every guard held)'
console.log(`\nverdict: ${verdict}`)
if (Object.keys(failEnvelope).length) {
  console.log('\nfailure envelope(s) captured for d1.ts error mapping:')
  for (const [k, v] of Object.entries(failEnvelope)) console.log(`  ${k}: ${JSON.stringify(v).slice(0, 400)}`)
}
console.log(results.every((r) => r.pass) ? '\nall pins green' : '\nSOME PINS FAILED — do not build the engine on assumptions; re-run or hand-check before Phase 4')
