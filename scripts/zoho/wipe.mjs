#!/usr/bin/env node
/**
 * Empty a base's data while keeping its structure: every table keeps its fields,
 * Config keeps its rows (it holds app_revision and the app settings — wiping it
 * would orphan every client's revision poll), and every OTHER table loses all
 * records. Users and roles are untouched — they live in WorkOS, not Zoho.
 *
 * After the deletes it bumps Config's app_revision by one, the same signal a
 * normal commit sends, so every device's next revision poll refetches the
 * snapshot instead of serving the pre-wipe mirror.
 *
 * usage: node scripts/zoho/wipe.mjs <base-id> [--dry-run] [--production <exact-id>]
 * --dry-run lists what would be deleted and touches nothing. The production base
 * refuses without the typed escape hatch; a dry run against it is read-only and
 * allowed. Safe to re-run after a failure: record ids are fetched fresh each run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const hatchIdx = argv.indexOf('--production')
const HATCH = hatchIdx >= 0 ? argv[hatchIdx + 1] : null
const TARGET = argv.filter((a, i) => !a.startsWith('--') && !(hatchIdx >= 0 && i === hatchIdx + 1))[0]
if (!TARGET) {
  console.error('usage: node scripts/zoho/wipe.mjs <base-id> [--dry-run] [--production <exact-id>]')
  process.exit(1)
}
// HARD GUARD: same rule as topup — production takes the id typed out, character
// for character. A wipe is all deletes; the guard is the only brake it has.
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
if (TARGET === PRODUCTION_BASE && !DRY && HATCH !== PRODUCTION_BASE) {
  console.error('REFUSING: target is the PRODUCTION base — re-run with --production ' + PRODUCTION_BASE + ' to confirm')
  process.exit(1)
}
console.log(
  `wipe target: ${TARGET}` +
    (TARGET === SCRATCH_BASE ? ' (scratch)' : TARGET === PRODUCTION_BASE ? ' (PRODUCTION)' : ' (WARNING: not a known base id)') +
    (DRY ? ' — DRY RUN, nothing will be written' : ''),
)

// the ONLY table whose rows survive — Config carries app_revision, app_config
// and the counter periods. Its other rows (Creator-era settings like the COA
// address) are inert to the app — snapshot.ts reads only those three kinds —
// so keeping them changes nothing the app shows while preserving real factory
// constants as reference.
const KEEP = new Set(['Config'])

const readEnv = (f) =>
  Object.fromEntries(
    readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
const ENV = readEnv(join(CW, '.zoho.env'))

// table ids come from the sync state — a wipe only runs on a base that was
// topup-synced, so the ids are known-good and the file must name this base
const STATE_F = join(ROOT, `topup-state.${TARGET.slice(0, 8)}.json`)
if (!existsSync(STATE_F)) {
  console.error(`REFUSING: ${STATE_F} not found — the base was never synced, so its table ids are unknown`)
  process.exit(1)
}
const state = JSON.parse(readFileSync(STATE_F, 'utf8'))
if (state.base !== TARGET) {
  console.error(`REFUSING: ${STATE_F} records base ${state.base ?? '(none)'} but the target is ${TARGET}`)
  process.exit(1)
}
const configT = state.tables['Config']
if (!configT?.fields?.['Setting'] || !configT?.fields?.['Value']) {
  console.error('REFUSING: Config field ids unknown from state — app_revision could not be bumped after the wipe')
  process.exit(1)
}

const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({ refresh_token: ENV.refresh_token, client_id: ENV.client_id,
    client_secret: ENV.client_secret, grant_type: 'refresh_token' })
  const j = await (await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })).json()
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j))
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastMut = 0
let lastRead = 0
// a wipe's only writes are the deletes and the one revision bump — a dry run
// refuses them at the transport, not by trusting every call site to remember
const WRITES = new Set(['PUT /records', 'DELETE /records'])
async function api(method, path, params = {}) {
  if (DRY && WRITES.has(`${method} ${path}`)) throw new Error(`dry run attempted a write: ${method} ${path}`)
  const isRead = method === 'GET' || path === '/fetchRecordsWithCriteria'
  if (isRead) {
    const rgap = 2500 - (Date.now() - lastRead)
    if (rgap > 0) await sleep(rgap)
    lastRead = Date.now()
  }
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && path !== '/fetchRecordsWithCriteria' && gap > 0) await sleep(gap)
  if (method !== 'GET' && path !== '/fetchRecordsWithCriteria') lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`) }
  const e = j?.error || Object.values(j || {}).map((n) => n && n.error).find(Boolean)
  if (e) throw new Error(`${method} ${path}: ${JSON.stringify(e)}`)
  return j
}

// every record in a table, paged by cursor; the seen-filter stops the loop even
// if the endpoint ignores the cursor and keeps returning the same page
async function allRecords(tableId) {
  const out = []
  const seen = new Set()
  let cursor
  for (let page = 0; page < 100; page++) {
    const r = await api('POST', '/fetchRecordsWithCriteria', {
      base_id: TARGET, table_id: tableId, count: 100,
      ...(cursor ? { reference_record_id: cursor } : {}),
    })
    const recs = (r.records?.fetched ?? r.records?.data ?? []).filter((x) => x.recordID ?? x.recordId)
    const fresh = recs.filter((x) => !seen.has(x.recordID ?? x.recordId))
    for (const x of fresh) seen.add(x.recordID ?? x.recordId)
    out.push(...fresh)
    if (recs.length < 100 || fresh.length === 0) break
    cursor = recs[recs.length - 1].recordID ?? recs[recs.length - 1].recordId
  }
  return out
}

// plan: every non-Config table's records to delete, plus Config's rows (kept,
// and the source of the current revision token)
const names = Object.keys(state.tables).sort((a, b) => (a === 'Config' ? 1 : b === 'Config' ? -1 : a.localeCompare(b)))
const plan = []
for (const name of names) {
  const recs = await allRecords(state.tables[name].id)
  if (KEEP.has(name)) {
    const settingId = configT.fields['Setting']
    const valueId = configT.fields['Value']
    // records come back {recordID, data: {fieldId: value}} — the settings live in .data
    const rows = recs.map((rec) => ({
      rid: rec.recordID ?? rec.recordId,
      setting: String(rec.data?.[settingId] ?? ''),
      value: String(rec.data?.[valueId] ?? ''),
    }))
    plan.push({ name, keep: true, rows })
    console.log(`  = ${name}: ${rows.length} row(s) kept`)
  } else {
    const ids = recs.map((rec) => rec.recordID ?? rec.recordId)
    plan.push({ name, ids })
    console.log(`  - ${name}: ${ids.length} row(s)`)
  }
}

// the revision value is a token '<n>:<nonce>' compared by equality everywhere
// (commit.ts bumpRevisionTo) — the wipe must mint a fresh one, never a bare number
const revRow = plan.find((p) => p.name === 'Config')?.rows?.find((r) => r.setting === 'app_revision')
const revNumberOf = (v) => parseInt(String(v ?? ''), 10) || 0
const nextToken = () => `${revNumberOf(revRow?.value) + 1}:${Math.random().toString(36).slice(2, 8)}`
let total = 0
for (const p of plan) if (!p.keep) total += p.ids.length

if (DRY) {
  const kept = plan.find((p) => p.name === 'Config').rows.length
  console.log(`\ndry run against ${TARGET} — nothing was written.`)
  console.log(`would delete ${total} record(s) across ${plan.filter((p) => !p.keep).length} table(s); Config keeps its ${kept} row(s)`)
  console.log(`app_revision is ${revRow?.value || '(absent)'} → would become ${nextToken()}`)
  process.exit(0)
}

// execute: delete every planned id, one request each, paced inside the write budget
let done = 0
for (const p of plan) {
  if (p.keep) continue
  for (const rid of p.ids) {
    await api('DELETE', '/records', { base_id: TARGET, table_id: state.tables[p.name].id, record_id: rid })
    done++
    if (done % 10 === 0) console.log(`  … ${done}/${total}`)
  }
  console.log(`  × ${p.name}: ${p.ids.length} deleted`)
}

// the commit-path signal, sent by hand: a fresh revision token so every client
// refetches (and so the server reports "ever written" — a bare '0' revision
// makes the snapshot layer treat the base as never-used and clients keep
// serving their pre-wipe mirrors)
const settingId = configT.fields['Setting']
const valueId = configT.fields['Value']
const revToken = nextToken()
await api('PUT', '/records', {
  base_id: TARGET, table_id: configT.id,
  data: JSON.stringify({ [settingId]: 'app_revision', [valueId]: revToken }),
  criteria: `"Setting" = "app_revision"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
})
console.log(`\nwipe complete: ${done} record(s) deleted, Config kept, app_revision ${revRow?.value || '(absent)'} → ${revToken}`)
