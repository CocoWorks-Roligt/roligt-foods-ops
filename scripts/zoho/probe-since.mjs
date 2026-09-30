#!/usr/bin/env node
/** Live probe of the criteria contract behind fetchSince, against the SCRATCH base.
 *
 * Pinned 2026-09-30 across rounds (probe result papers since removed — git history):
 *   - `=` on a TEXT field works (fetchByKeyIn's daily bread)
 *   - `contains` on a TEXT field works — the ONLY surviving range-ish operator, and the
 *     one fetchSince's hour-bucket delta is built on
 *   - `>=`, `>`, `starts_with`, `startswith`, `like` answer HTTP 200 wrapping
 *     `{"error":{"code":500,"message":"INTERNAL SERVER ERROR"}}` — on TEXT and on
 *     date-typed columns alike
 *   - EVERY operator on a date-typed column (type 7) is refused, `=` included
 *   - a Text column stores what the app writes but READS BACK normalized:
 *     `2026-09-30T07:00:00.000Z` → `"2026/09/30 07:00:00"` — watermarks come from
 *     the Data JSON, never from the column
 *
 * This file re-runs the contract so a Zoho-side change (an operator starts working,
 * contains breaks) is caught before it eats a production sweep. PASS = the contract
 * still holds, refusals included.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..')
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const BASE = process.env.ZOHO_BASE_ID || (existsSync(join(CW, '.env'))
  ? Object.fromEntries(readFileSync(join(CW, '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(),l.slice(l.indexOf('=') + 1).trim()])).ZOHO_BASE_ID
  : '')
if (!BASE) { console.error('set ZOHO_BASE_ID (scratch!) first'); process.exit(1) }
// HARD GUARD: the probe must never touch production. (And /tables is a GET — a POST
// CREATES a table, pinned the embarrassing way 2026-09-30.)
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
if (BASE === PRODUCTION_BASE) { console.error('REFUSING: ZOHO_BASE_ID is the PRODUCTION base'); process.exit(1) }
if (BASE !== SCRATCH_BASE) { console.error('REFUSING: not the expected scratch id'); process.exit(1) }

const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({ refresh_token: ENV.refresh_token, client_id: ENV.client_id,
    client_secret: ENV.client_secret, grant_type: 'refresh_token' })
  const j = await (await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })).json()
  if (!j.access_token) throw new Error('token refresh failed')
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const wire = []
let lastCall = 0
async function raw(method, path, params) {
  const gap = 3600 - (Date.now() - lastCall)
  if (gap > 0) await sleep(gap)
  lastCall = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  const once = async () => {
    const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* opaque */ }
    wire.push({ method, path: url.pathname + '?' + url.searchParams.toString().slice(0, 300), status: res.status, body: text.slice(0, 300) })
    return { status: res.status, json, text }
  }
  try {
    return await once()
  } catch (e) {
    console.log(`  (${e.cause?.code ?? e.message} — retrying once after 5s)`)
    await sleep(5000)
    lastCall = Date.now()
    return once()
  }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

const LEDGER = { table: 'r17sKQ', appId: 'wvjocA', dataJson: 'jRNMfg', time: 'Qz8axw' }
const AUDITS = { table: 'JwjpIQ', appId: 'S656ng', dataJson: 'ay6fbg', time: 'JFSOPQ' }
const rowsOf = (j) => j?.records?.fetched ?? j?.records?.data
const refused = (j) => !!j?.error // the HTTP-200-wrapped INTERNAL SERVER ERROR

async function put(T, key, time) {
  const r = await raw('PUT', '/records', {
    base_id: BASE, table_id: T.table,
    data: JSON.stringify({ [T.appId]: key, [T.time]: time, [T.dataJson]: JSON.stringify({ id: key, at: time, time }) }),
    criteria: `"${T.appId}" = "${key}"`,
    is_upsert_needed: true, is_ids_used_in_params: true, is_ids_used_in_data: true,
  })
  return r.json?.status === 'success' || !!r.json?.records?.created
}
async function wipe(T, key) {
  const rr = await raw('POST', '/fetchRecordsWithCriteria', {
    base_id: BASE, table_id: T.table, criteria: `"${T.appId}" = "${key}"`, is_ids_used_in_params: true, count: 5,
  })
  const rec = rowsOf(rr.json)?.[0]
  if (!rec) return 'gone'
  const rd = await raw('DELETE', '/records', { base_id: BASE, table_id: T.table, record_id: rec.recordID ?? rec.recordId })
  return rd.status
}
/** One criteria read; returns the probe keys matched. */
async function crit(T, criteria, count = 100) {
  const r = await raw('POST', '/fetchRecordsWithCriteria', {
    base_id: BASE, table_id: T.table, criteria, is_ids_used_in_params: true, count,
  })
  const ks = (rowsOf(r.json) ?? []).map((x) => String(x.data?.[T.appId] ?? '')).filter((k) => k.startsWith('PROBE'))
  return { status: r.status, ks, json: r.json }
}

// two ledger rows straddling an hour boundary + one audit row — the delta shapes
const LA = 'PROBE-DL-A' // 2026-09-30T07:44 — the watermark hour
const LB = 'PROBE-DL-B' // 2026-09-29T23:10 — the previous day
const AX = 'PROBE-DX-A' // an audit at the watermark hour
check('write-ledger-a', await put(LEDGER, LA, '2026-09-30T07:44:00.000Z'), LA)
check('write-ledger-b', await put(LEDGER, LB, '2026-09-29T23:10:00.000Z'), LB)
check('write-audit-a', await put(AUDITS, AX, '2026-09-30T07:45:00.000Z'), AX)

// THE contract fetchSince depends on
let r = await crit(LEDGER, `"${LEDGER.dataJson}" contains "2026-09-30T07"`)
check('contains-hour-matches', r.ks.join() === LA, `matched ${JSON.stringify(r.ks)}`)
r = await crit(LEDGER, `"${LEDGER.dataJson}" contains "2026-09-29T23"`)
check('contains-prior-hour-distinct', r.ks.join() === LB, `matched ${JSON.stringify(r.ks)}`)
r = await crit(LEDGER, `"${LEDGER.dataJson}" contains "2020-01-01T00"`)
check('contains-miss-is-empty-not-error', r.status === 200 && Array.isArray(rowsOf(r.json)) && r.ks.length === 0,
  `HTTP ${r.status}; ${JSON.stringify(r.json).slice(0, 80)}`)
r = await crit(AUDITS, `"${AUDITS.dataJson}" contains "2026-09-30T07"`)
check('contains-works-on-audits', r.ks.join() === AX, `matched ${JSON.stringify(r.ks)}`)
r = await crit(LEDGER, `"${LEDGER.appId}" = "${LA}"`)
check('eq-text-still-works', r.ks.join() === LA, `matched ${JSON.stringify(r.ks)}`)

// the refusals, pinned as refusals — nobody builds a range query on these again
r = await crit(LEDGER, `"${LEDGER.dataJson}" >= "2026-09-30T00"`)
check('range-on-text-refused', refused(r.json), JSON.stringify(r.json).slice(0, 80))
r = await crit(LEDGER, `"${LEDGER.time}" contains "2026/09/30"`)
check('any-op-on-date-column-refused', refused(r.json), JSON.stringify(r.json).slice(0, 80))

// the Time column normalization that disqualifies it as a watermark source
r = await crit(LEDGER, `"${LEDGER.appId}" = "${LA}"`)
const timeBack = rowsOf(r.json)?.[0]?.data?.[LEDGER.time]
check('time-column-normalizes', timeBack === '2026/09/30 07:44:00', `read back ${JSON.stringify(timeBack)}`)

check('cleanup-ledger-a', await wipe(LEDGER, LA) === 200, '')
check('cleanup-ledger-b', await wipe(LEDGER, LB) === 200, '')
check('cleanup-audit-a', await wipe(AUDITS, AX) === 200, '')

writeFileSync(join(CW, 'docs', 'zoho-probe-since-results.md'),
  `# criteria-contract probe — ${new Date().toISOString()}\n\nbase: ${BASE} (scratch)\n\n` +
  `Contract: \`=\` and \`contains\` on TEXT fields work; all range operators and every operator\n` +
  `on date-typed columns answer HTTP 200 wrapping INTERNAL SERVER ERROR; the Time column\n` +
  `normalizes ISO to \`YYYY/MM/DD HH:mm:ss\` on read-back. Evidence history:\n` +
  `zoho-probe-since1-results.md, zoho-probe-since2-3-results.md.\n\n| check | ok | detail |\n|---|---|---|\n` +
  results.map((x) => `| ${x.name} | ${x.ok ? 'yes' : '**NO**'} | ${(x.detail || '').replaceAll('|', '\\|').slice(0, 150)} |`).join('\n') +
  `\n\n## Raw wire log\n\n\`\`\`json\n${JSON.stringify(wire, null, 2)}\n\`\`\`\n`)

const failed = results.filter((x) => !x.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall checks passed — the contract holds')
process.exit(failed.length ? 1 : 0)
