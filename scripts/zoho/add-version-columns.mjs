#!/usr/bin/env node
/**
 * Adds the S2-5 Version column (single-line text, type 23) to every EDITABLE
 * table of a base — additive only: create where absent (POST /fields + PUT
 * rename), skip where present, touch nothing else. The probe
 * (probe-version.mjs, 2026-10-07) pinned the semantics this column enables: the
 * criteria grammar is single-condition text equality, `is_upsert_needed: false`
 * is honored (match → records.updated[<row>], no-match → records.updated: []
 * with HTTP 200), and upsert-true on a non-matching criteria MINTS A DUPLICATE —
 * so the column holds the composite token "<AppID>:<n>" and the conditional
 * write is one equality on it, update-only.
 *
 * Tables (21): every TABLE_FOR collection a client can edit. Skipped by design:
 * Vendor Types and Order Lines (not client-writable), Sticker Prints
 * (immutable), Ledger and Audit Log (insert-only — nothing to version),
 * Config (app_revision is its OCC) and Counters (COUNTER_JUMP_MAX + period
 * gates).
 *
 * Target is the SCRATCH base by default. `--production` opts into the
 * production base — the one deliberate schema change on the live plant, run
 * only after scratch verified clean. Anything else on either flag combination
 * is refused.
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
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const TARGET = process.argv.includes('--production') ? PRODUCTION_BASE : SCRATCH_BASE
if (process.argv.some((a) => a.startsWith('--base'))) { console.error('no --base flag — scratch (default) or --production'); process.exit(1) }
console.log(`target base: ${TARGET} (${TARGET === PRODUCTION_BASE ? 'PRODUCTION' : 'scratch'})`)
if (TARGET === PRODUCTION_BASE && !process.argv.includes('--production')) { console.error('unreachable'); process.exit(1) }

const EDITABLE = [
  'Vendors', 'Customers', 'Purchase Products', 'Storage Locations', 'Items', 'Products',
  'Melanges', 'GRNs', 'Batches', 'Packing Runs', 'Orders', 'QC Records', 'Dispatches',
  'Stock Issues', 'Lab Reports', 'Test Parameters', 'Sticker Templates', 'Staff',
  'Shifts', 'Attendance', 'Production Plans',
]

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
let lastMut = 0
async function api(method, path, params) {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* opaque */ }
  if (!res.ok || (json && json.error)) throw new Error(`${method} ${path} → ${text.slice(0, 200)}`)
  return json
}
const fid = (f) => f.fieldID
const fname = (f) => f.name

const tables = (await api('GET', '/tables', { base_id: TARGET })).tables.fetched
const byName = new Map(tables.map((t) => [t.name, t]))
const summary = []
for (const name of EDITABLE) {
  const t = byName.get(name)
  if (!t) { console.error(`MISSING TABLE: ${name} — refusing to continue`); process.exit(1) }
  const fields = (await api('GET', '/fields', { base_id: TARGET, table_id: t.tableID })).fields.fetched
  const existing = fields.find((f) => fname(f) === 'Version')
  if (existing) {
    summary.push(`${name}: Version already present (${fid(existing)})`)
    console.log(`  ${name}: already present (${fid(existing)})`)
    continue
  }
  const created = (await api('POST', '/fields', { base_id: TARGET, table_id: t.tableID, type: 23 })).fields.created[0]
  const renamed = (await api('PUT', '/fields', {
    base_id: TARGET, table_id: t.tableID, field_id: fid(created), field_name: 'Version', type: 23,
  }))
  if (renamed.error) { console.error(`${name}: rename refused — ${JSON.stringify(renamed)}`); process.exit(1) }
  summary.push(`${name}: Version created (${fid(created)})`)
  console.log(`  ${name}: created ${fid(created)}`)
}
const missing = EDITABLE.filter((n) => !summary.some((s) => s.startsWith(n + ':')))
console.log(`\n${EDITABLE.length - missing.length}/${EDITABLE.length} tables carry a Version column on ${TARGET}`)
if (missing.length) { console.error('MISSING: ' + missing.join(', ')); process.exit(1) }
console.log('\nnext: node scripts/zoho/topup.mjs ' + TARGET + '  (re-syncs the state file and regenerates api/_lib/baseSchema.ts)')
