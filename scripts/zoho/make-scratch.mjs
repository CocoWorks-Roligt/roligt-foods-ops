#!/usr/bin/env node
/**
 * Scratch-base bootstrap for the Roligt-on-Zoho-Tables fork.
 *
 * Modes:
 *   node scripts/zoho/make-scratch.mjs --create-base
 *       Attempts to create an empty base named "Roligt Fork Scratch" via the
 *       API, in the same workspace as the production base:
 *         attempt 1 — documented create: POST /bases?portal_id&workspace_id&base_name
 *         attempt 2 — duplicate-style variant (only if 1 fails):
 *                     POST /bases?base_id=<prod>&base_name&is_duplicate_with_records=false
 *       A base is considered created when a GET /bases list shows an id that
 *       was not there before (the POST payloads are unreliable narrators).
 *       The new id is recorded in scratch-state.json under "_base". This mode
 *       does NOT duplicate tables — run the normal mode for that.
 *
 *   node scripts/zoho/make-scratch.mjs <scratch-base-id>
 *       Duplicates the 30 built tables (structure only, no records) from the
 *       production base — used strictly as a READ-ONLY source — into the
 *       scratch base. Resumable via scratch-state.json ("=" skip, "!" found
 *       already present, "+" duplicated). Aborts before any write if the
 *       target id equals the production base id.
 */
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
const SOURCE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const STATE_F = join(ROOT, 'scratch-state.json')
const state = existsSync(STATE_F) ? JSON.parse(readFileSync(STATE_F, 'utf8')) : {}
const save = () => writeFileSync(STATE_F, JSON.stringify(state, null, 2))

const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({
    refresh_token: ENV.refresh_token, client_id: ENV.client_id,
    client_secret: ENV.client_secret, grant_type: 'refresh_token',
  })
  const r = await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })
  const j = await r.json()
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
  try { return JSON.parse(text) } catch { throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`) }
}
/** Same as api() but never throws on failure — returns status + raw text for evidence. */
async function apiRaw(method, path, params = {}) {
  const gap = 3600 - (Date.now() - lastMut)
  if (gap > 0) await sleep(gap)
  lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON error body — keep raw */ }
  return { status: res.status, text, json }
}

/* ---------- mode: --create-base ---------- */
async function createBase() {
  const NAME = 'Roligt Fork Scratch'
  const portals = await api('GET', '/portals')
  const pid = portals?.portals?.fetched?.[0]?.portalID
  if (!pid) throw new Error('no portal found: ' + JSON.stringify(portals).slice(0, 200))
  const ws = await api('GET', '/workspaces', { portal_id: pid })
  const wid = ws?.workspaces?.fetched?.[0]?.workspaceID
  if (!wid) throw new Error('no workspace found: ' + JSON.stringify(ws).slice(0, 200))
  console.log(`portal ${pid} / workspace ${wid}`)
  const listBases = async () =>
    ((await api('GET', '/bases', { portal_id: pid, workspace_id: wid }))?.bases?.fetched ?? [])
  const before = await listBases()
  const beforeIds = new Set(before.map((b) => b.baseID))
  if (!beforeIds.has(SOURCE)) throw new Error('production base not found in workspace — refusing to continue')
  const findNew = async () => (await listBases()).find((b) => !beforeIds.has(b.baseID))

  const attempts = [
    ['create', { portal_id: pid, workspace_id: wid, base_name: NAME }],
    ['duplicate-variant', { base_id: SOURCE, base_name: NAME, is_duplicate_with_records: false }],
  ]
  for (const [via, params] of attempts) {
    const r = await apiRaw('POST', '/bases', params)
    console.log(`\n[${via}] POST /bases?${new URLSearchParams(params).toString()}`)
    console.log(`→ HTTP ${r.status}: ${r.text.slice(0, 400)}`)
    const nb = await findNew()
    if (nb) {
      state._base = { id: nb.baseID, name: nb.name, via }
      save()
      console.log(`\nscratch base created (${via}): ${nb.baseID} "${nb.name}" — recorded in scratch-state.json`)
      console.log(`next: node scripts/zoho/make-scratch.mjs ${nb.baseID}`)
      return
    }
  }
  console.error('\nall base-creation attempts failed — no new base appeared in the workspace')
  process.exit(1)
}

/* ---------- mode: duplicate tables into <scratch-base-id> ---------- */
const TARGET = process.argv[2]
if (TARGET === '--create-base') {
  await createBase()
} else {
  if (!TARGET) {
    console.error('usage: node scripts/zoho/make-scratch.mjs <scratch-base-id>   (or: --create-base)')
    process.exit(1)
  }
  console.log('source (READ-ONLY):', SOURCE)
  console.log('target base id:   ', TARGET)
  if (TARGET === SOURCE) {
    console.error('ABORT: target base id equals the production base id')
    process.exit(1)
  }

  const tablesState = JSON.parse(readFileSync(join(ROOT, 'tables-state.json'), 'utf8')).tables
  const names = Object.keys(tablesState)
  const existing = (await api('GET', '/tables', { base_id: TARGET })).tables.fetched.map((t) => t.name)
  for (const name of names) {
    if (state[name]) { console.log(`= ${name}`); continue }
    if (existing.includes(name)) { console.log(`! ${name} already in scratch`); state[name] = true; save(); continue }
    const src = tablesState[name].id
    const j = await api('POST', '/tables', {
      base_id: TARGET, table_id: src, table_name: name, is_duplicate_with_records: false,
    })
    const e = j?.error || j?.tables?.error
    if (e) throw new Error(`${name}: ${JSON.stringify(e)}`)
    state[name] = true
    save()
    console.log(`+ ${name}`)
  }
  console.log('done — scratch base ready:', TARGET)
}
