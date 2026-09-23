#!/usr/bin/env node
/** Live probe of the read/upsert contracts against the SCRATCH base. Prints PASS/FAIL per check. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..', '..')
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const BASE = process.env.ZOHO_BASE_ID || (existsSync(join(ROOT, '..', '..', '.env'))
  ? Object.fromEntries(readFileSync(join(ROOT, '..', '..', '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])).ZOHO_BASE_ID
  : '')
if (!BASE) { console.error('set ZOHO_BASE_ID (scratch!) first'); process.exit(1) }
// HARD GUARD: the probe must never touch production.
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
if (BASE === PRODUCTION_BASE) { console.error('REFUSING: ZOHO_BASE_ID is the PRODUCTION base'); process.exit(1) }
console.log(`probe base: ${BASE}${BASE === SCRATCH_BASE ? ' (scratch ✓)' : ' (⚠ NOT the expected scratch id — continuing is unsafe)'}`)
if (BASE !== SCRATCH_BASE) process.exit(1)

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
const wire = [] // raw evidence log: every request/response pair, for the report
/**
 * One raw call. transport picks where params go:
 *  - 'query': everything in the URL query string (what the library does today)
 *  - 'json':  params as an application/json request body (base_id/table_id included)
 *  - 'form':  params as an x-www-form-urlencoded request body
 */
async function raw(method, path, params, transport = 'query') {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
  const headers = { Authorization: 'Zoho-oauthtoken ' + (await token()) }
  let url = new URL('https://tables.zoho.in/api/v1' + path)
  let body
  const flat = {}
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null) flat[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (transport === 'query') {
    for (const [k, v] of Object.entries(flat)) url.searchParams.set(k, v)
  } else if (transport === 'json') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(flat)
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(flat).toString()
  }
  const res = await fetch(url, { method, headers, body })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* opaque */ }
  wire.push({ method, path: url.pathname, transport, status: res.status, body: text.slice(0, 400) })
  return { status: res.status, json, text }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// scratch Vendors table id + its primary field (Name) — read live
const tables = (await raw('GET', '/tables', { base_id: BASE })).json.tables.fetched
const vendors = tables.find((t) => t.name === 'Vendors')
const vfields = (await raw('GET', '/fields', { base_id: BASE, table_id: vendors.tableID })).json.fields.fetched
// NOTE: this API's field objects carry no isPrimary flag — the primary field is the first listed.
const nameField = vfields.find((f) => f.isPrimary) ?? vfields[0]
const fid = (f) => f.fieldID ?? f.fieldid ?? f.id
const fname = (f) => f.fieldName ?? f.name
const phoneField = vfields.find((f) => fname(f) === 'Phone')
// Large payloads go to a plain text field (Notes) — Phone (type 17) silently drops plain strings.
const blobField = vfields.find((f) => fname(f) === 'Notes') ?? phoneField ?? nameField
console.log(`vendors table: ${vendors.tableID}; primary: ${fname(nameField)} (${fid(nameField)}); phone: ${phoneField ? fname(phoneField) + ' (' + fid(phoneField) + ')' : 'none'}; blob: ${fname(blobField)} (${fid(blobField)})`)

// 1. upsert by criteria on the PRIMARY field (string criteria, field NAME)
let r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(nameField)]: 'PROBE VENDOR', ...(phoneField ? { [fid(phoneField)]: '99999 00000' } : {}) }),
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
})
check('upsert-by-name-criteria', r.json?.status === 'success', JSON.stringify(r.json).slice(0, 160))

// 2. fetch it back via criteria
r = await raw('POST', '/fetchRecordsWithCriteria', {
  base_id: BASE, table_id: vendors.tableID,
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`, count: 10,
})
const fetched = r.json?.records?.fetched ?? r.json?.records?.data
check('fetch-by-criteria', Array.isArray(fetched) && fetched.length >= 1, JSON.stringify(r.json).slice(0, 200))

// 3. fetch page shape without criteria + cursor continuation.
// Scratch Vendors starts EMPTY (the UI duplicate copied structure, not rows) — so page
// through the table with the most live records (reads only, no writes to it).
const pagingTable = tables.reduce((a, b) => ((b.recordsCount || 0) > (a.recordsCount || 0) ? b : a))
console.log(`paging table: ${pagingTable.name} (${pagingTable.recordsCount} records)`)
r = await raw('POST', '/fetchRecordsWithCriteria', { base_id: BASE, table_id: pagingTable.tableID, count: 2 })
const page1 = r.json?.records?.fetched ?? r.json?.records?.data
check('fetch-page-shape', Array.isArray(page1), `table ${pagingTable.name}; page1 keys: ${JSON.stringify(Object.keys(r.json?.records || {}))}; page1 len: ${Array.isArray(page1) ? page1.length : 'n/a'}`)
if (Array.isArray(page1) && page1.length === 2) {
  const r2 = await raw('POST', '/fetchRecordsWithCriteria', {
    base_id: BASE, table_id: pagingTable.tableID, count: 2,
    reference_record_id: page1[1].recordID ?? page1[1].recordId,
  })
  const page2 = r2.json?.records?.fetched ?? r2.json?.records?.data
  const first = (page1[0].recordID ?? page1[0].recordId)
  const p2first = Array.isArray(page2) && page2.length ? (page2[0].recordID ?? page2[0].recordId) : null
  check('cursor-continuation', p2first && p2first !== first, `page2 first: ${p2first}`)
}

// 4. large payload through a query param (~8 KB) on the upsert data
const big = 'x'.repeat(8192)
r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(blobField)]: big }),
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
})
check('large-query-payload', r.json?.status === 'success', `HTTP ${r.status}${r.json ? ' ' + JSON.stringify(r.json).slice(0, 120) : ''}`)

// 4b. characterize the query-param ceiling (~4 KB)
r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(blobField)]: 'x'.repeat(4096) }),
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
})
check('large-query-payload-4k', r.json?.status === 'success', `HTTP ${r.status}`)

// 4c. large payload (~8 KB) with params in an application/json request BODY
r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(blobField)]: big }),
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
}, 'json')
check('large-body-payload-json', r.json?.status === 'success', `HTTP ${r.status}${r.json ? ' ' + JSON.stringify(r.json).slice(0, 160) : ''}`)

// 4d. fallback: same via x-www-form-urlencoded body
if (r.json?.status !== 'success') {
  r = await raw('PUT', '/records', {
    base_id: BASE, table_id: vendors.tableID,
    data: JSON.stringify({ [fid(blobField)]: big }),
    criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
    is_upsert_needed: true, is_ids_used_in_data: true,
  }, 'form')
  check('large-body-payload-form', r.json?.status === 'success', `HTTP ${r.status}${r.json ? ' ' + JSON.stringify(r.json).slice(0, 160) : ''}`)
}

// 5. read the record back and confirm the big value survived (truncated print)
r = await raw('POST', '/fetchRecordsWithCriteria', {
  base_id: BASE, table_id: vendors.tableID, criteria: `"${fname(nameField)}" = "PROBE VENDOR"`, count: 1,
})
const rec = ((r.json?.records?.fetched ?? r.json?.records?.data) || [])[0]
const dataStr = JSON.stringify(rec?.data ?? rec ?? {})
check('large-payload-roundtrip', dataStr.includes('xxxx'), dataStr.slice(0, 160))

// 6. EXTRA: does the library's ARRAY-shaped criteria (`JSON.stringify([fieldId, '=', value])`,
//    sent with is_ids_used_in_params: true, exactly as api/_lib/zoho.ts upsertByKey does) work as-is?
r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(nameField)]: 'PROBE VENDOR', ...(phoneField ? { [fid(phoneField)]: '99999 00000' } : {}) }),
  criteria: JSON.stringify([fid(nameField), '=', 'PROBE VENDOR']),
  is_upsert_needed: true, is_ids_used_in_data: true, is_ids_used_in_params: true,
})
check('criteria-array-shape', r.json?.status === 'success', JSON.stringify(r.json).slice(0, 200))

// 7. the shape the FIXED library would send: STRING criteria built from the field ID,
//    with is_ids_used_in_params: true and is_ids_used_in_data: true.
r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(nameField)]: 'PROBE VENDOR' }),
  criteria: `"${fid(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true, is_ids_used_in_params: true,
})
check('criteria-fieldid-string', r.json?.status === 'success', JSON.stringify(r.json).slice(0, 200))

// 8. side observation: Phone (type 17) silently dropped the spaced string in check 1 —
//    retry with a digits-only value and read it back.
if (phoneField) {
  r = await raw('PUT', '/records', {
    base_id: BASE, table_id: vendors.tableID,
    data: JSON.stringify({ [fid(phoneField)]: '9999900000' }),
    criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
    is_upsert_needed: true, is_ids_used_in_data: true,
  })
  const r2 = await raw('POST', '/fetchRecordsWithCriteria', {
    base_id: BASE, table_id: vendors.tableID, criteria: `"${fname(nameField)}" = "PROBE VENDOR"`, count: 1,
  })
  const pr = ((r2.json?.records?.fetched ?? r2.json?.records?.data) || [])[0]
  check('phone-digits-persist', JSON.stringify(pr?.data ?? {}).includes('9999900000'),
    `write HTTP ${r.status}; read back: ${JSON.stringify(pr?.data?.[fid(phoneField)] ?? null)}`)
}

writeFileSync(join(ROOT, '..', '..', 'docs', 'zoho-fork-probe-results.md'),
  `# Probe results — ${new Date().toISOString()}\n\nbase: ${BASE} (scratch)\n\n| check | ok | detail |\n|---|---|---|\n` +
  results.map((x) => `| ${x.name} | ${x.ok ? 'yes' : '**NO**'} | ${(x.detail || '').replaceAll('|', '\\|').slice(0, 150)} |`).join('\n') +
  `\n\n## Raw wire log (truncated bodies)\n\n\`\`\`json\n${JSON.stringify(wire, null, 2)}\n\`\`\`\n\n## Raw first-record shape (PROBE VENDOR after large-payload roundtrip)\n\n\`\`\`json\n${JSON.stringify(rec, null, 2).slice(0, 2000)}\n\`\`\`\n`)

const failed = results.filter((x) => !x.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall checks passed')
process.exit(failed.length ? 1 : 0)
