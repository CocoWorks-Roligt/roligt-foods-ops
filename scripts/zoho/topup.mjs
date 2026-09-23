#!/usr/bin/env node
/**
 * Top-up for the fork: App ID + Data JSON on every table, a Sticker Prints table,
 * and the revision/config rows. Resumable via topup-state.json.
 *
 * usage: node scripts/zoho/topup.mjs <base-id>
 * Target the SCRATCH base first. The production run is Task 12, on explicit user go.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..', '..')
const TARGET = process.argv[2]
if (!TARGET) { console.error('usage: node scripts/zoho/topup.mjs <base-id>'); process.exit(1) }
// HARD GUARD: never touch production. The production top-up is Task 12, on explicit user go.
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const SCRATCH_BASE = 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c'
if (TARGET === PRODUCTION_BASE) { console.error('REFUSING: target is the PRODUCTION base'); process.exit(1) }
console.log(`topup target: ${TARGET}${TARGET === SCRATCH_BASE ? ' (scratch)' : ' (WARNING: not the expected scratch id)'}`)
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const STATE_F = join(ROOT, 'topup-state.json')
const state = existsSync(STATE_F) ? JSON.parse(readFileSync(STATE_F, 'utf8')) : { tables: {} }
const save = () => writeFileSync(STATE_F, JSON.stringify(state, null, 2))

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
async function api(method, path, params = {}) {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
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
const fid = (f) => f.fieldID ?? f.fieldid ?? f.id
const fname = (f) => f.fieldName ?? f.name

async function fieldsOf(tableId) {
  const fs = (await api('GET', '/fields', { base_id: TARGET, table_id: tableId })).fields.fetched
  return fs
}
async function ensureTextField(tableId, tableName, label) {
  const st = state.tables[tableName]
  if (st.fields[label]) return st.fields[label]
  const created = (await api('POST', '/fields', { base_id: TARGET, table_id: tableId, type: 23 })).fields.created[0]
  const id = fid(created)
  await api('PUT', '/fields', { base_id: TARGET, table_id: tableId, field_id: id, field_name: label, type: 23 })
  st.fields[label] = id
  save()
  console.log(`  + ${tableName}.${label}`)
  return id
}

const listing = (await api('GET', '/tables', { base_id: TARGET })).tables.fetched

// 1. App ID + (missing) Data JSON on every existing table
for (const t of listing) {
  if (!state.tables[t.name]) state.tables[t.name] = { id: t.tableID, fields: {} }
  const st = state.tables[t.name]
  const fs = await fieldsOf(t.tableID)
  for (const f of fs) {
    const n = fname(f)
    if (n && !st.fields[n]) st.fields[n] = fid(f)
  }
  save()
  if (!st.appId) st.appId = await ensureTextField(t.tableID, t.name, 'App ID')
  if (!['Counters', 'Config'].includes(t.name)) {
    // tables duplicated from production may already carry Data JSON (Batches, Packing Runs,
    // Ledger do) — reuse that field id instead of creating a duplicate one.
    st.dataJson = st.fields['Data JSON'] ?? (await ensureTextField(t.tableID, t.name, 'Data JSON'))
  }
  save()
  console.log(`= ${t.name}`)
}

// 2. Sticker Prints table (fork-owned, absent from the base). Resumable via the done flag —
//    a bare "is it in the listing?" check would skip a half-built table on re-run.
if (!state.tables['Sticker Prints']?.done) {
  let st = state.tables['Sticker Prints']
  if (!st) {
    const created = (await api('POST', '/tables', { base_id: TARGET, table_name: 'Sticker Prints' })).tables.created[0]
    st = state.tables['Sticker Prints'] = { id: created.tableID, fields: {} }
    save()
    console.log('+ Sticker Prints table')
  }
  const LABELS = ['Doc No', 'Stage', 'Title', 'Printed At', 'Qty']
  // A fresh POST /tables ships auto-named default fields ("Field N") and ~10 empty starter
  // records (observed during the base build): claim the first default as the leading column,
  // drop the other defaults, create the rest.
  const fs = await fieldsOf(st.id)
  // don't record the auto-named defaults — they get claimed/renamed or dropped below
  for (const f of fs) {
    const n = fname(f)
    if (n && !st.fields[n] && !/^field/i.test(n)) st.fields[n] = fid(f)
  }
  const defaults = fs.filter((f) => /^field/i.test(fname(f) || ''))
  if (defaults.length) {
    const prim = defaults[0]
    await api('PUT', '/fields', { base_id: TARGET, table_id: st.id, field_id: fid(prim), field_name: LABELS[0], type: 23 })
    delete st.fields[fname(prim)]
    st.fields[LABELS[0]] = fid(prim)
    st.primary = fid(prim)
    save()
    console.log(`  ~ Sticker Prints.${LABELS[0]} (claimed default ${fname(prim)})`)
    for (const d of defaults.slice(1)) {
      await api('DELETE', '/fields', { base_id: TARGET, table_id: st.id, field_id: fid(d) })
      delete st.fields[fname(d)]
      console.log(`  - Sticker Prints: dropped default ${fname(d)}`)
    }
    save()
  }
  for (const label of LABELS) {
    if (st.fields[label]) continue
    const c = (await api('POST', '/fields', { base_id: TARGET, table_id: st.id, type: 23 })).fields.created[0]
    await api('PUT', '/fields', { base_id: TARGET, table_id: st.id, field_id: fid(c), field_name: label, type: 23 })
    st.fields[label] = fid(c)
    save()
    console.log(`  + Sticker Prints.${label}`)
  }
  st.appId = await ensureTextField(st.id, 'Sticker Prints', 'App ID')
  st.dataJson = st.fields['Data JSON'] = await ensureTextField(st.id, 'Sticker Prints', 'Data JSON')
  // best-effort sweep of the starter rows — cosmetic, never fatal
  try {
    const r = await api('POST', '/fetchRecordsWithCriteria', { base_id: TARGET, table_id: st.id, count: 100 })
    const recs = r.records?.fetched ?? r.records?.data ?? []
    const ids = recs.map((x) => x.recordID ?? x.recordId).filter(Boolean)
    for (const rid of ids) {
      await api('DELETE', '/records', { base_id: TARGET, table_id: st.id, record_id: rid })
    }
    if (ids.length) console.log(`  - Sticker Prints: swept ${ids.length} starter records`)
  } catch (e) {
    console.log(`  ! Sticker Prints starter-record sweep skipped: ${String(e.message || e).slice(0, 140)}`)
  }
  st.done = true
  save()
}

// 3. Config rows: app_revision / app_config — upsert by the string criteria form
//    (the array-shaped criteria errors; pinned by the Task 4 probe).
const cfg = state.tables['Config']
const settingId = cfg.fields['Setting']
const valueId = cfg.fields['Value']
const seedRow = async (setting, value) => {
  await api('PUT', '/records', {
    base_id: TARGET, table_id: cfg.id,
    data: JSON.stringify({ [settingId]: setting, [valueId]: value }),
    criteria: `"Setting" = "${setting}"`,
    is_upsert_needed: true, is_ids_used_in_data: true,
  })
  console.log(`= Config row ${setting}`)
}
await seedRow('app_revision', '0')
await seedRow('app_config', '{}')
save()
console.log('top-up complete →', STATE_F)
