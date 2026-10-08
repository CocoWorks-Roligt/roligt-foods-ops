#!/usr/bin/env node
/**
 * The one-time exporter: every real table of a Zoho base → one SQL dump ready
 * for `wrangler d1 execute --remote --file`, plus a manifest (per-table counts
 * + SHA-256 of the canonicalized rows) that scripts/d1/verify.mjs checks the
 * loaded database against.
 *
 * 27 tables: the 24 synced collections of TABLE_FOR minus the two link-machinery
 * tables the app never read back (Vendor Types, Order Lines — they existed so
 * Zoho link columns resolved), plus Counters, Config and Compliance Documents.
 * Field ids come from the same per-base topup-state files the generated schema
 * uses, so nothing is discovered live.
 *
 * usage: node scripts/d1/dump-from-zoho.mjs <base-id> [--production <exact-id>]
 * Paced like every other Zoho script (2.5 s between reads); read-only.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CW = join(HERE, '..', '..')

const argv = process.argv.slice(2)
const hatchIdx = argv.indexOf('--production')
const HATCH = hatchIdx >= 0 ? argv[hatchIdx + 1] : null
const TARGET = argv.filter((a, i) => !a.startsWith('--') && !(hatchIdx >= 0 && i === hatchIdx + 1))[0]
if (!TARGET) {
  console.error('usage: node scripts/d1/dump-from-zoho.mjs <base-id> [--production <exact-id>]')
  process.exit(1)
}
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
if (TARGET === PRODUCTION_BASE && HATCH !== PRODUCTION_BASE) {
  console.error(`REFUSING: target is the PRODUCTION base — re-run with --production ${PRODUCTION_BASE} to confirm`)
  process.exit(1)
}
console.log(`dumping ${TARGET === SCRATCH_BASE ? 'scratch' : TARGET === PRODUCTION_BASE ? 'PRODUCTION' : TARGET}`)

const readEnv = (f) =>
  Object.fromEntries(
    readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
const ENV = readEnv(join(CW, '.zoho.env'))

const STATE_F = join(HERE, '..', 'zoho', `topup-state.${TARGET.slice(0, 8)}.json`)
if (!existsSync(STATE_F)) {
  console.error(`no topup-state for ${TARGET} — expected ${STATE_F}`)
  process.exit(1)
}
const state = JSON.parse(readFileSync(STATE_F, 'utf8'))
if (state.base !== TARGET) {
  console.error(`REFUSING: ${STATE_F} records base ${state.base ?? '(none)'} but the target is ${TARGET}`)
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
let lastRead = 0
async function api(method, path, params = {}) {
  const rgap = 2500 - (Date.now() - lastRead)
  if (rgap > 0) await sleep(rgap)
  lastRead = Date.now()
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

const recordsFrom = (j) => j.records?.fetched ?? j.records?.data ?? j.data?.records ?? []

/** Paged full read, the app client's own cursor shape. */
async function fetchAll(tableId) {
  const out = []
  let cursor
  for (;;) {
    const j = await api('POST', '/fetchRecordsWithCriteria', {
      base_id: TARGET, table_id: tableId, count: 1000,
      ...(cursor ? { reference_record_id: cursor } : {}),
    })
    const page = recordsFrom(j)
    out.push(...page)
    if (page.length < 1000) return out
    cursor = page[page.length - 1].recordID
  }
}

// wire collection name → Zoho table name (TABLE_FOR minus the link-machinery tables)
const DUMP_TABLES = {
  vendors: 'Vendors', customers: 'Customers', purchase_products: 'Purchase Products',
  storage_locations: 'Storage Locations', items: 'Items', products: 'Products', melanges: 'Melanges',
  grns: 'GRNs', batches: 'Batches', packing_runs: 'Packing Runs', orders: 'Orders',
  qcs: 'QC Records', dispatches: 'Dispatches', stock_issues: 'Stock Issues',
  lab_reports: 'Lab Reports', test_parameters: 'Test Parameters',
  sticker_templates: 'Sticker Templates', sticker_prints: 'Sticker Prints', staff: 'Staff',
  shifts: 'Shifts', attendance: 'Attendance', production_plans: 'Production Plans',
  ledger: 'Ledger', audits: 'Audit Log', compliance: 'Compliance Documents',
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const versionOf = (appId, token) => {
  const m = token && token.startsWith(appId + ':') ? /^(\d+)$/.exec(token.slice(appId.length + 1)) : null
  return m ? Number(m[1]) : 1
}

const date = new Date().toISOString().slice(0, 10)
const out = []
const manifest = { base: TARGET, generatedAt: new Date().toISOString(), tables: {} }

/** Multi-row INSERT statements, each kept under the 100 KB statement cap. */
function rowsToStatements(prefix, rowsSql) {
  const stmts = []
  let cur = []
  let bytes = 0
  for (const r of rowsSql) {
    if (cur.length && bytes + r.length > 48_000) {
      stmts.push(`${prefix}\n  ${cur.join(',\n  ')}`)
      cur = []
      bytes = 0
    }
    cur.push(r)
    bytes += r.length
  }
  if (cur.length) stmts.push(`${prefix}\n  ${cur.join(',\n  ')}`)
  return stmts
}

const stamped = new Date().toISOString()

for (const [collection, tableName] of Object.entries(DUMP_TABLES)) {
  const st = state.tables[tableName]
  // `done` only exists on tables topup itself built; the honest readiness signal
  // for every table is that topup recorded its App ID / Data JSON field ids
  if (!st?.appId || !st?.dataJson) {
    console.warn(`! ${tableName} has no recorded App ID / Data JSON for this base — skipped (run topup first)`)
    continue
  }
  const rows = await fetchAll(st.id)
  const rowsSql = []
  const canonical = []
  for (const r of rows) {
    const id = String(r.data[st.appId] ?? '')
    const json = String(r.data[st.dataJson] ?? '')
    if (!id || !json) continue // hand-staged row with no document
    const version = versionOf(id, String(r.data[st.fields['Version']] ?? ''))
    rowsSql.push(`${q(collection)},${q(id)},${q(json)},${version},${q(stamped)}`)
    canonical.push(`${id} ${json}`)
  }
  out.push(...rowsToStatements('INSERT OR REPLACE INTO documents(collection,id,json,version,updated_at) VALUES', rowsSql))
  canonical.sort()
  manifest.tables[tableName] = {
    collection,
    count: rowsSql.length,
    sha256: createHash('sha256').update(canonical.join('\n')).digest('hex'),
  }
  console.log(`= ${tableName} → ${collection}: ${rowsSql.length} rows`)
}

// Counters → counters
{
  const st = state.tables['Counters']
  const rows = await fetchAll(st.id)
  const valid = rows
    .map((r) => `${q(String(r.data[st.fields['Series']] ?? ''))},${Number(r.data[st.fields['Next']] ?? 0)}`)
    .filter((sql) => !sql.includes("''")) // a series with no key is not a counter
  out.push(...rowsToStatements('INSERT OR REPLACE INTO counters(series,next) VALUES', valid))
  manifest.tables['Counters'] = { collection: 'counters', count: valid.length,
    sha256: createHash('sha256').update(valid.sort().join('\n')).digest('hex') }
  console.log(`= Counters: ${valid.length} series`)
}

// Config → meta (app_revision / app_config / period:* verbatim; Notes dropped)
{
  const st = state.tables['Config']
  const rows = await fetchAll(st.id)
  const valid = rows
    .map((r) => ({ setting: String(r.data[st.fields['Setting']] ?? ''), value: String(r.data[st.fields['Value']] ?? '') }))
    .filter((r) => r.setting)
  out.push(...rowsToStatements('INSERT OR REPLACE INTO meta(setting,value) VALUES',
    valid.map((r) => `${q(r.setting)},${q(r.value)}`)))
  manifest.tables['Config'] = { collection: 'meta', count: valid.length,
    sha256: createHash('sha256').update(valid.map((r) => `${r.setting} ${r.value}`).sort().join('\n')).digest('hex') }
  console.log(`= Config: ${valid.length} settings`)
}

const outFile = join(HERE, `dump-${TARGET.slice(0, 8)}-${date}.sql`)
const manifestFile = join(HERE, `dump-${TARGET.slice(0, 8)}-${date}.manifest.json`)
writeFileSync(outFile, out.join(';\n') + ';\n')
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
console.log(`\nwrote ${outFile} (${out.length} statements) and ${manifestFile}`)
console.log('next: npx wrangler d1 execute <database> --remote --file scripts/d1/schema.sql --yes, then the same with this dump, then scripts/d1/verify.mjs')
