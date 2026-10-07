#!/usr/bin/env node
/**
 * Live probe of the version-column OCC contracts against the SCRATCH base —
 * the S2-5 decision probe. Three questions decide the write path the commit
 * takes when a Version column exists:
 *
 *  1. does a COMPOUND criteria (`"AppID" = "X" AND "Version" = "N"`) work on
 *     fetchRecordsWithCriteria and on the upsert — field-ID string form,
 *     is_ids_used_in_params, exactly as api/_lib/zoho.ts sends today?
 *  2. what does an UPDATE-ONLY upsert (is_upsert_needed: false) answer when the
 *     criteria matches nothing — the row moved, so this is the conflict signal
 *     the commit needs to parse?
 *  3. does is_upsert_needed: TRUE with a non-matching criteria CREATE a
 *     duplicate row (the duplicate-mint hazard that would forbid that shape)?
 *
 * Creates a `Version` text field on scratch Vendors if absent (type 23 — text,
 * because criteria equality is only proven on text columns), seeds one
 * PROBE-OCC row, and deletes it after. Prints PASS/FAIL per check and writes
 * docs/zoho-version-probe-results.md with the raw wire log.
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
const BASE = process.env.ZOHO_BASE_ID || 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
// HARD GUARD: the probe writes rows and creates fields — it must never touch production.
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
if (BASE === PRODUCTION_BASE) { console.error('REFUSING: ZOHO_BASE_ID is the PRODUCTION base'); process.exit(1) }
if (BASE !== SCRATCH_BASE) { console.error(`REFUSING: ${BASE} is not the expected scratch base`); process.exit(1) }
console.log(`probe base: ${BASE} (scratch ✓)`)

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
const wire = []
/** One raw call, params on the query string (the library's own transport for writes of this size). */
async function raw(method, path, params) {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* opaque */ }
  wire.push({ method, path: url.pathname, status: res.status, params: JSON.stringify(params).slice(0, 300), body: text.slice(0, 400) })
  return { status: res.status, json, text }
}
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const fid = (f) => f.fieldID ?? f.fieldid ?? f.id
const fname = (f) => f.fieldName ?? f.name
const errOf = (j) => {
  for (const node of [j, ...Object.values(j || {})]) {
    const e = node && node.error
    if (e) return `${e.code || ''} ${e.message || JSON.stringify(e)}`
  }
  return null
}
const rowsOf = (j) => j?.records?.fetched ?? j?.records?.data ?? []

// ---- scratch Vendors: the app's own wire shape (App ID key column + text fields) ----
const tables = (await raw('GET', '/tables', { base_id: BASE })).json.tables.fetched
const vendors = tables.find((t) => t.name === 'Vendors')
if (!vendors) { console.error('no Vendors table on scratch'); process.exit(1) }
let vfields = (await raw('GET', '/fields', { base_id: BASE, table_id: vendors.tableID })).json.fields.fetched
const appIdField = vfields.find((f) => fname(f) === 'App ID')
const nameField = vfields.find((f) => f.isPrimary) ?? vfields[0]
if (!appIdField) { console.error('Vendors has no App ID column — sync the scratch base first (topup.mjs)'); process.exit(1) }
const APP = fid(appIdField)

// ---- the Version field: create if absent (type 23 = single-line text) ----
let versionField = vfields.find((f) => fname(f) === 'Version')
let createdNow = false
if (!versionField) {
  const created = (await raw('POST', '/fields', { base_id: BASE, table_id: vendors.tableID, type: 23 })).json
  const row = (created?.fields?.created ?? [])[0]
  if (!row) { console.error('field create refused: ' + JSON.stringify(created).slice(0, 200)); process.exit(1) }
  const renamed = (await raw('PUT', '/fields', {
    base_id: BASE, table_id: vendors.tableID, field_id: fid(row), field_name: 'Version', type: 23,
  })).json
  if (errOf(renamed)) { console.error('field rename refused: ' + errOf(renamed)); process.exit(1) }
  vfields = (await raw('GET', '/fields', { base_id: BASE, table_id: vendors.tableID })).json.fields.fetched
  versionField = vfields.find((f) => fname(f) === 'Version')
  createdNow = true
}
if (!versionField || !fid(versionField)) { console.error('Version field missing after create/rename'); process.exit(1) }
const VER = fid(versionField)
console.log(`vendors ${vendors.tableID}: AppID ${APP}, Name ${fid(nameField)}, Version ${VER} (created now: ${createdNow ? 'yes' : 'already present'})`)

const KEY = 'PROBE-OCC-2'
const cas = (n) => `${KEY}:${n}` // the composite CAS token: row identity + version in ONE value
const fetchBy = async (criteria) =>
  (await raw('POST', '/fetchRecordsWithCriteria', {
    base_id: BASE, table_id: vendors.tableID, criteria, count: 10, is_ids_used_in_params: true,
  }))
const rowsForKey = async () => rowsOf((await fetchBy(`"${APP}" = "${KEY}"`)).json)

try {
  // round 1, 2026-10-07 09:39: EVERY AND criteria (fetch and upsert alike) answers
  // {"error":{"code":500}} — zoho.ts's grammar note was right, the criteria language
  // is single-condition only. Round 2 asks the shape that CAN work: one text
  // equality whose VALUE is the composite token "<AppID>:<n>", plus the
  // is_upsert_needed:false semantics that make the write conditional. A cheap
  // parenthesized-AND try rides along in case the 500 was a parser quirk.

  // seed: one row at token 1 — today's keyed upsert, unchanged
  let r = await raw('PUT', '/records', {
    base_id: BASE, table_id: vendors.tableID,
    data: JSON.stringify({ [APP]: KEY, [fid(nameField)]: 'probe occ', [VER]: cas(1) }),
    criteria: `"${APP}" = "${KEY}"`,
    is_upsert_needed: true, is_ids_used_in_data: true, is_ids_used_in_params: true,
  })
  check('seed-keyed-upsert', r.json?.status === 'success', JSON.stringify(r.json).slice(0, 140))

  // 0. the parser-quirk try: parenthesized AND (two reads, harmless if it 500s)
  r = await fetchBy(`("${APP}" = "${KEY}" AND "${VER}" = "${cas(1)}")`)
  check('and-parenthesized-fetch', !errOf(r.json) && rowsOf(r.json).length === 1,
    `err ${errOf(r.json) ?? 'none'}, rows ${rowsOf(r.json).length}`)

  // 1a. the composite token on the READ: single text equality, colon inside the value
  r = await fetchBy(`"${VER}" = "${cas(1)}"`)
  check('token-fetch-hit', !errOf(r.json) && rowsOf(r.json).length === 1,
    `err ${errOf(r.json) ?? 'none'}, rows ${rowsOf(r.json).length}`)

  // 1b. the miss side: a moved row answers zero rows, success — the conflict read
  r = await fetchBy(`"${VER}" = "${cas(2)}"`)
  check('token-fetch-miss', !errOf(r.json) && rowsOf(r.json).length === 0,
    `err ${errOf(r.json) ?? 'none'}, rows ${rowsOf(r.json).length}`)

  // 2a. THE pivotal call: update-only (is_upsert_needed FALSE), token criteria MATCHES
  r = await raw('PUT', '/records', {
    base_id: BASE, table_id: vendors.tableID,
    data: JSON.stringify({ [APP]: KEY, [fid(nameField)]: 'probe occ v2', [VER]: cas(2) }),
    criteria: `"${VER}" = "${cas(1)}"`,
    is_upsert_needed: false, is_ids_used_in_data: true, is_ids_used_in_params: true,
  })
  check('update-only-hit', r.json?.status === 'success', `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`)

  // 2b. did the conditional write land — and stamp the NEXT token?
  r = await rowsForKey()
  check('update-only-hit-landed', r.length === 1 && String(r[0]?.data?.[VER]) === cas(2),
    `rows ${r.length}, Version ${JSON.stringify(r[0]?.data?.[VER])}`)

  // 2c. the conflict signal: update-only, token matches NOTHING (row sits at 2, we claim 999)
  r = await raw('PUT', '/records', {
    base_id: BASE, table_id: vendors.tableID,
    data: JSON.stringify({ [APP]: KEY, [fid(nameField)]: 'SHOULD NEVER LAND', [VER]: cas(999) }),
    criteria: `"${VER}" = "${cas(999)}"`,
    is_upsert_needed: false, is_ids_used_in_data: true, is_ids_used_in_params: true,
  })
  check('update-only-miss-answered', true, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`)

  // 2d. the miss truly wrote nothing — still token 2, still 'probe occ v2', ONE row
  r = await rowsForKey()
  check('update-only-miss-wrote-nothing',
    r.length === 1 && String(r[0]?.data?.[VER]) === cas(2) && JSON.stringify(r[0]?.data?.[fid(nameField)]).includes('v2'),
    `rows ${r.length}, Version ${JSON.stringify(r[0]?.data?.[VER])}, Name ${JSON.stringify(r[0]?.data?.[fid(nameField)])}`)

  // 3. the hazard, now testable on a single condition: is_upsert_needed TRUE with a
  // non-matching token — a duplicate row would FORBID upsert-true CAS writes
  r = await raw('PUT', '/records', {
    base_id: BASE, table_id: vendors.tableID,
    data: JSON.stringify({ [APP]: KEY, [fid(nameField)]: 'DUPLICATE', [VER]: cas(998) }),
    criteria: `"${VER}" = "${cas(998)}"`,
    is_upsert_needed: true, is_ids_used_in_data: true, is_ids_used_in_params: true,
  })
  r = await rowsForKey()
  check('upsert-true-miss-duplicates', r.length > 1,
    r.length > 1 ? `CONFIRMED: ${r.length} rows share App ID ${KEY} — upsert-true CAS is forbidden` : `no duplicate (${r.length} row) — safer than assumed`)

  // cleanup: every PROBE-OCC row goes
  for (const row of await rowsForKey()) {
    await raw('DELETE', '/records', { base_id: BASE, table_id: vendors.tableID, record_id: row.recordID ?? row.recordId })
  }
  r = await rowsForKey()
  check('cleanup', r.length === 0, `rows left ${r.length}`)
} finally {
  writeFileSync(join(CW, 'docs', 'zoho-version-probe-results.md'),
    `# Version-column probe — ${new Date().toISOString()}\n\nbase: ${BASE} (scratch); Vendors table ${vendors.tableID}; AppID ${APP}, Version ${VER}\n\n| check | ok | detail |\n|---|---|---|\n` +
    results.map((x) => `| ${x.name} | ${x.ok ? 'yes' : '**NO**'} | ${(x.detail || '').replaceAll('|', '\\|').slice(0, 180)} |`).join('\n') +
    `\n\n## Raw wire log\n\n\`\`\`json\n${JSON.stringify(wire, null, 2)}\n\`\`\`\n`)
}

const failed = results.filter((x) => !x.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall checks passed')
process.exit(failed.length ? 1 : 0)
