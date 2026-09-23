#!/usr/bin/env node
/**
 * Live-builds the Roligt Plant Ops database in Zoho Tables (IN DC, direct REST —
 * bypasses the broken MCP gate). Schema: docs/zoho-build-pack.md §2–3 and
 * docs/zoho-rebuild-blueprint.md §2.
 *
 * The v1 REST contracts this script is built on (verified live 2026-09-20):
 *   - POST /tables?base_id&table_name            → new table, 3 default text fields + 10 starter records
 *   - POST /tables?base_id&table_id&table_name&is_duplicate_with_records=false → structure-only copy
 *   - PUT  /tables?base_id&table_id&table_name   → rename
 *   - POST /fields?base_id&table_id&type=<int>&<components>  → typed field, auto-named "Field N"
 *     (NO name param exists at create; unknown query params hard-reject with 400)
 *   - PUT  /fields?base_id&table_id&field_id&field_name&type=<int>&<components> → rename/retype
 *     (type is mandatory; components MUST be re-passed or they reset)
 *   - POST /selectionOptions?base_id&table_id&field_id&selection_option_name
 *   - POST /records?base_id&table_id&field_ids_with_values={"<fieldID>": value}
 *     (query-param JSON, field IDs as keys — names are ignored)
 *   - DELETE /records is single-record only; starter rows are shed via table duplication instead
 *   - POST /workspaces and POST /bases 500 server-side → build inside the existing base
 *
 * Phases (each resumable; state in ./tables-state.json):
 *   tables | fields-m | fields-t | dedup | options | links | seed | cleanup | verify
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..', '..')
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const STATE_F = join(ROOT, 'tables-state.json')
const state = existsSync(STATE_F) ? JSON.parse(readFileSync(STATE_F, 'utf8')) : {}
const save = () => writeFileSync(STATE_F, JSON.stringify(state, null, 2))

const API = 'https://tables.zoho.in/api/v1'
// workspace/base creation is broken server-side; build in the base the team created tonight
const BASE = { id: 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d', name: 'Zoho production analytics' }

/* ---------- token ---------- */
const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({
    refresh_token: ENV.refresh_token,
    client_id: ENV.client_id,
    client_secret: ENV.client_secret,
    grant_type: 'refresh_token',
  })
  const r = await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })
  const j = await r.json()
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j))
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token
}

/* ---------- throttled API: writes <= ~17/min (limits are 20/min, breach locks for 5 min) ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastMut = 0
async function api(method, path, params = {}) {
  const go = async (params) => {
    const url = new URL(API + path)
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    if (method !== 'GET') {
      const gap = 3600 - (Date.now() - lastMut)
      if (gap > 0) await sleep(gap)
      lastMut = Date.now()
    }
    let res
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
      } catch (e) {
        if (attempt) throw e
        await sleep(2500)
        continue
      }
      if (res.status !== 401) break
      tok = null
    }
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 150)}`)
    }
  }
  let j = await go(params)
  // date-only fields: time_format=0 is rejected on some builds — retry without it
  if (errOf(j) && 'time_format' in params) {
    const p2 = { ...params }
    delete p2.time_format
    j = await go(p2)
  }
  return j
}
function errOf(j) {
  for (const node of [j, ...Object.values(j || {})]) {
    const e = node && node.error
    if (e) return `${e.code || ''} ${e.message || JSON.stringify(e)}`
  }
  return null
}
function arr(j, kind, action) {
  const e = errOf(j)
  if (e) throw new Error(e)
  const a = j?.[kind]?.[action]
  if (!Array.isArray(a)) throw new Error(`${kind}.${action}: ` + JSON.stringify(j).slice(0, 200))
  return a
}
const fid = (f) => f.fieldID ?? f.fieldid ?? f.id
const fname = (f) => f.fieldName ?? f.name

/* ---------- schema ---------- */
const F = {
  txt: (n) => ({ n, t: 23, c: {} }),
  num: (n, p = 0) => ({ n, t: 15, c: { precision: p, thousand_separator: 2 } }),
  money: (n) => ({ n, t: 6, c: { symbol: 10, symbol_position: 0, precision: 2, thousand_separator: 2 } }),
  date: (n) => ({ n, t: 7, c: { date_format: 4, time_format: 0 } }),
  time: (n) => ({ n, t: 7, c: { date_format: 4, time_format: 1 } }),
  sel: (n, opts) => ({ n, t: 21, c: {}, opts }),
  chk: (n) => ({ n, t: 4, c: {} }),
  email: (n) => ({ n, t: 9, c: {} }),
  phone: (n) => ({ n, t: 17, c: {} }),
  attach: (n) => ({ n, t: 2, c: {} }),
  auto: (n) => ({ n, t: 3, c: {} }),
  link: (n, to, multi = false) => ({ n, link: { to, multi } }),
}
const STATUS = ['Active', 'Inactive']

const TABLES = [
  // ---- masters ----
  { name: 'Vendor Types', fields: [F.txt('Name'), F.sel('Source Kind', ['Farmer', 'Vendor', 'Other']), F.txt('Description'), F.sel('Status', STATUS)] },
  { name: 'Vendors', fields: [F.txt('Name'), F.link('Vendor Type', 'Vendor Types'), F.phone('Phone'), F.txt('Area'), F.txt('Payment Terms'), F.sel('Status', STATUS), F.email('Email'), F.txt('Notes')] },
  { name: 'Customers', fields: [F.txt('Name'), F.txt('Ship To'), F.txt('GSTIN'), F.sel('Status', STATUS), F.phone('Phone'), F.email('Email'), F.txt('Contact Person'), F.txt('Notes')] },
  { name: 'Items', fields: [F.txt('Name'), F.sel('Type', ['Raw Material', 'Semi Finished', 'Packing Material', 'Finished Goods']), F.sel('UOM', ['Piece', 'Kg', 'Litre', 'Pack', 'Bottle']), F.chk('Lot Controlled'), F.num('Reorder Level'), F.sel('Cost Method', ['Lot Actual', 'Batch Actual', 'By-product', 'Weighted Avg'])] },
  { name: 'Purchase Products', fields: [F.txt('Name'), F.link('Item', 'Items'), F.txt('Default UOM'), F.link('Linked Vendors', 'Vendors', true)] },
  { name: 'Storage Locations', fields: [F.txt('Name'), F.txt('Label'), F.txt('Holds'), F.sel('Type', ['Cold Room', 'Dry Store', 'Hold Area']), F.sel('Status', STATUS)] },
  { name: 'Test Categories', fields: [F.txt('Title'), F.sel('Format', ['Results', 'Scored']), F.chk('Required for Release'), F.num('Pass Score'), F.num('Minor Score'), F.txt('Signatory'), F.sel('Status', STATUS)] },
  { name: 'Test Parameters', fields: [F.txt('Name'), F.link('Category', 'Test Categories'), F.txt('Method'), F.txt('Unit')] },
  { name: 'Products', fields: [F.txt('Name'), F.txt('Format'), F.num('Size', 2), F.txt('Unit'), F.num('Pack Volume', 2), F.num('Shelf Life Days'), F.num('Chilled Shelf Life Days'), F.money('MRP'), F.link('Bulk Item', 'Items'), F.sel('Medium', ['Water', 'Malai'])] },
  { name: 'BOM Lines', fields: [F.auto('Line'), F.link('Product', 'Products'), F.link('Item', 'Items'), F.num('Qty per Pack', 2)] },
  { name: 'Melanges', fields: [F.txt('Name'), F.sel('Status', STATUS), F.link('Output Item', 'Items')] },
  { name: 'Melange Components', fields: [F.auto('Line'), F.link('Melange', 'Melanges'), F.link('Item', 'Items'), F.num('Share', 2)] },
  { name: 'Counters', fields: [F.txt('Series'), F.txt('Prefix'), F.txt('Pattern'), F.num('Pad'), F.num('Next')] },
  { name: 'Config', fields: [F.txt('Setting'), F.txt('Value'), F.txt('Notes')] },
  { name: 'Staff', fields: [F.txt('Staff No'), F.txt('Name'), F.txt('Role'), F.phone('Phone'), F.sel('Status', STATUS), F.date('Added On')] },
  // ---- transactional ----
  { name: 'GRNs', fields: [F.txt('Doc No'), F.date('Date'), F.link('Product', 'Purchase Products'), F.txt('UOM'), F.link('Location', 'Storage Locations'), F.link('Vendor', 'Vendors'), F.txt('Area'), F.date('Harvested On'), F.num('Total', 2), F.num('Accepted', 2), F.num('Free', 2), F.num('Grade A', 2), F.num('Grade B', 2), F.num('Grade C', 2), F.num('Reject', 2), F.money('Rate'), F.money('Other Charges'), F.sel('Status', ['Draft', 'Posted']), F.txt('Notes')] },
  { name: 'Batches', fields: [F.txt('Batch No'), F.date('Date'), F.sel('Kind', ['Extraction', 'Melange']), F.link('Location', 'Storage Locations'), F.num('Spoiled', 2), F.money('Cost per Unit'), F.sel('Status', ['Awaiting QC', 'Released', 'On Hold', 'Rejected']), F.txt('Data JSON')] },
  { name: 'Packing Runs', fields: [F.txt('Run No'), F.date('Date'), F.link('Batch', 'Batches'), F.link('Bulk Item', 'Items'), F.num('Drawn', 2), F.link('Location', 'Storage Locations'), F.sel('Status', ['Draft', 'Posted']), F.txt('Data JSON')] },
  { name: 'QC Records', fields: [F.txt('Doc No'), F.link('Batch', 'Batches'), F.link('Item', 'Items'), F.sel('Disposition', ['Awaiting', 'Released', 'On Hold', 'Rejected']), F.txt('Tests JSON'), F.attach('Attachments')] },
  { name: 'Lab Reports', fields: [F.txt('Report No'), F.link('Category', 'Test Categories'), F.link('Batch', 'Batches'), F.date('Sample Date'), F.link('Customer', 'Customers'), F.date('Issue Date'), F.txt('Scores JSON'), F.txt('Decision'), F.attach('Attachment')] },
  { name: 'Orders', fields: [F.txt('Order No'), F.link('Customer', 'Customers'), F.date('Date'), F.sel('Status', ['Open', 'Dispatched', 'Cancelled']), F.txt('Notes')] },
  { name: 'Order Lines', fields: [F.auto('Line'), F.link('Order', 'Orders'), F.link('SKU', 'Products'), F.num('Qty', 2)] },
  { name: 'Dispatches', fields: [F.txt('Challan No'), F.date('Date'), F.link('Customer', 'Customers'), F.link('SKU', 'Products'), F.link('Batch', 'Batches'), F.link('Location', 'Storage Locations'), F.date('Expiry'), F.num('Qty', 2), F.txt('Vehicle'), F.sel('Status', ['Dispatched', 'In Transit', 'Delivered']), F.attach('POD')] },
  { name: 'Stock Issues', fields: [F.txt('Doc No'), F.date('Date'), F.sel('Reason', ['Spoilage', 'Sample', 'Internal Use', 'Return to Vendor', 'Other']), F.txt('Issued To'), F.txt('Lines JSON'), F.money('Value')] },
  { name: 'Production Plans', fields: [F.txt('Plan No'), F.date('Day'), F.sel('Stage', ['Extraction', 'Melange', 'Packing']), F.txt('Product'), F.num('Qty', 2), F.sel('UOM', ['Litre', 'Kg', 'Packs']), F.txt('Note'), F.sel('Status', ['Planned', 'In progress', 'Done', 'Cancelled'])] },
  { name: 'Shifts', fields: [F.txt('Key'), F.link('Staff', 'Staff'), F.date('Date'), F.sel('Shift', ['Morning', 'Evening', 'General']), F.txt('Line'), F.txt('Note')] },
  { name: 'Attendance', fields: [F.txt('Key'), F.link('Staff', 'Staff'), F.date('Date'), F.sel('Status', ['Present', 'Absent', 'Leave', 'Half day']), F.txt('Note')] },
  { name: 'Ledger', fields: [F.txt('Doc'), F.txt('Type'), F.link('Item', 'Items'), F.txt('Lot'), F.link('Location', 'Storage Locations'), F.txt('Status'), F.num('Qty In', 2), F.num('Qty Out', 2), F.money('Unit Cost'), F.date('Expiry'), F.time('Time'), F.txt('Data JSON')] },
  { name: 'Audit Log', fields: [F.txt('Doc'), F.txt('Action'), F.txt('Details'), F.txt('Actor'), F.time('Time')] },
  { name: 'Sticker Templates', fields: [F.txt('Name'), F.sel('Stage', ['Extraction', 'Melange', 'Packing', 'Dispatch']), F.txt('Template JSON')] },
]
const M_COUNT = 15

/* ---------- helpers ---------- */
async function listFields(tableName) {
  const st = state.tables[tableName]
  const fs = arr(await api('GET', '/fields', { base_id: BASE.id, table_id: st.id }), 'fields', 'fetched')
  st.fields = Object.fromEntries(fs.map((f) => [fname(f), fid(f)]))
  const prim = fs.find((f) => f.isPrimary)
  st.primary = prim ? fid(prim) : fid(fs[0])
  save()
  return fs
}
async function renameField(tableName, fieldId_, f) {
  const st = state.tables[tableName]
  const j = await api('PUT', '/fields', {
    base_id: BASE.id,
    table_id: st.id,
    field_id: fieldId_,
    field_name: f.n,
    type: f.t,
    ...f.c,
  })
  const e = errOf(j)
  if (e) throw new Error(`rename ${tableName}.${f.n}: ${e}`)
  delete st.fields[Object.keys(st.fields).find((k) => st.fields[k] === fieldId_)]
  st.fields[f.n] = fieldId_
  save()
}
async function createField(tableName, f) {
  const st = state.tables[tableName]
  const j = await api('POST', '/fields', { base_id: BASE.id, table_id: st.id, type: f.t, ...f.c })
  const created = arr(j, 'fields', 'created')[0]
  const id = fid(created)
  await renameField(tableName, id, f)
  return id
}

/* ---------- phases ---------- */
async function phaseTables() {
  state.tables = state.tables || {}
  const existing = arr(await api('GET', '/tables', { base_id: BASE.id }), 'tables', 'fetched')
  for (const t of TABLES) {
    if (state.tables[t.name]?.id) continue
    const found = existing.find((x) => x.name === t.name)
    if (found) {
      state.tables[t.name] = { id: found.tableID, fields: {} }
      console.log(`  = ${t.name} exists (${found.tableID})`)
    } else {
      const j = await api('POST', '/tables', { base_id: BASE.id, table_name: t.name })
      const created = arr(j, 'tables', 'created')[0]
      state.tables[t.name] = { id: created.tableID, fields: {} }
      console.log(`  + ${t.name} (${created.tableID})`)
    }
    save()
  }
}

async function phaseFields(which) {
  const list = which === 'm' ? TABLES.slice(0, M_COUNT) : TABLES.slice(M_COUNT)
  for (const t of list) {
    if (!state.tables[t.name]) throw new Error(`table ${t.name} missing — run the tables phase first`)
    if (state.tables[t.name].done) {
      console.log(`= ${t.name} fields done`)
      continue
    }
    const fs = await listFields(t.name)
    const plain = t.fields.filter((f) => !f.link)
    const defaults = fs.filter((f) => /^field/i.test(fname(f) || '')).map(fid)
    console.log(`${t.name}: ${plain.length} fields (${defaults.length} defaults to claim)`)
    let i = 0
    // claim the auto-created default fields first (single PUT each)
    for (; i < plain.length && defaults.length; i++) {
      const d = defaults.shift()
      if (plain[i].n in state.tables[t.name].fields) continue // already named (resume)
      await renameField(t.name, d, plain[i])
      console.log(`  ~ ${plain[i].n} (claimed default)`)
    }
    for (; i < plain.length; i++) {
      if (plain[i].n in state.tables[t.name].fields) continue
      await createField(t.name, plain[i])
      console.log(`  + ${plain[i].n}`)
    }
    state.tables[t.name].done = true
    save()
  }
}

async function phaseDedup() {
  // each built table still carries 10 empty starter records — replace it with a
  // structure-only duplicate, then delete the original
  for (const t of TABLES) {
    const st = state.tables[t.name]
    if (!st || st.clean) continue
    // sweep any unclaimed auto-named defaults ("Field N") first — they would survive the copy
    const fs = await listFields(t.name)
    for (const f of fs.filter((x) => /^field/i.test(fname(x) || '') && fid(x) !== st.primary)) {
      const j = await api('DELETE', '/fields', { base_id: BASE.id, table_id: st.id, field_id: fid(f) })
      console.log(`  - ${t.name}: leftover ${fname(f)} ${errOf(j) ? 'kept (' + errOf(j) + ')' : ''}`)
    }
    let j = await api('POST', '/tables', {
      base_id: BASE.id,
      table_id: st.id,
      table_name: t.name,
      is_duplicate_with_records: false,
    })
    let e = errOf(j)
    let dup
    if (e) {
      // same-name duplicate rejected → temp name, rename after deleting the original
      j = await api('POST', '/tables', {
        base_id: BASE.id,
        table_id: st.id,
        table_name: t.name + '~new',
        is_duplicate_with_records: false,
      })
      e = errOf(j)
      dup = j?.tables?.duplicated?.[0]
      if (e || !dup) throw new Error(`dedup ${t.name}: ${e || 'no duplicated node'}`)
      await api('DELETE', '/tables', { base_id: BASE.id, table_id: st.id })
      const rj = await api('PUT', '/tables', { base_id: BASE.id, table_id: dup.tableID, table_name: t.name })
      const re = errOf(rj)
      if (re) throw new Error(`rename back ${t.name}: ${re}`)
    } else {
      dup = j?.tables?.duplicated?.[0]
      if (!dup) throw new Error(`dedup ${t.name}: unexpected ` + JSON.stringify(j).slice(0, 150))
      await api('DELETE', '/tables', { base_id: BASE.id, table_id: st.id })
    }
    const old = st.id
    st.id = dup.tableID
    st.clean = true
    st.done = true
    delete st.fields
    st.fields = {}
    save()
    console.log(`${t.name}: ${old} → ${dup.tableID} (records: ${dup.recordsCount})`)
  }
}

async function phaseOptions() {
  for (const t of TABLES) {
    const st = state.tables[t.name]
    if (!st || !Object.keys(st.fields).length) await listFields(t.name)
    for (const f of t.fields.filter((x) => x.opts)) {
      const fieldId_ = st.fields[f.n]
      if (!fieldId_) {
        console.log(`! ${t.name}.${f.n}: field missing`)
        continue
      }
      for (const opt of f.opts) {
        const j = await api('POST', '/selectionOptions', {
          base_id: BASE.id,
          table_id: st.id,
          field_id: fieldId_,
          selection_option_name: opt,
        })
        const e = errOf(j)
        console.log(e ? `  ! ${t.name}.${f.n} [${opt}]: ${e}` : `  + ${t.name}.${f.n} [${opt}]`)
      }
    }
  }
}

async function phaseLinks() {
  for (const t of TABLES) {
    const st = state.tables[t.name]
    if (!st || !Object.keys(st.fields).length) await listFields(t.name)
    const fs = await listFields(t.name) // fresh — finds orphans from failed renames
    for (const f of t.fields.filter((x) => x.link)) {
      if (f.n in st.fields) {
        console.log(`= ${t.name}.${f.n} exists`)
        continue
      }
      const dest = state.tables[f.link.to]
      if (!dest?.primary || !Object.keys(dest.fields ?? {}).length) await listFields(f.link.to)
      const destPrimary = state.tables[f.link.to].primary
      if (!destPrimary) throw new Error(`destination ${f.link.to} has no primary`)
      const comp = {
        source_table_id: st.id,
        destination_table_id: state.tables[f.link.to].id,
        mirror_field_id: destPrimary,
      }
      if (f.link.multi) comp.multiple_value_support = 1
      // claim an orphaned auto-named link field left by a failed rename, else create
      const orphan = fs.find((x) => /^field/i.test(fname(x) || '') && String(x.type) === '30')
      let id
      if (orphan) {
        id = fid(orphan)
        fs.splice(fs.indexOf(orphan), 1)
      } else {
        const j = await api('POST', '/fields', { base_id: BASE.id, table_id: st.id, type: 30, ...comp })
        const created = j?.fields?.created?.[0]
        if (!created) {
          console.log(`! ${t.name}.${f.n} create: ${errOf(j)}`)
          continue
        }
        id = fid(created)
      }
      let j2 = await api('PUT', '/fields', { base_id: BASE.id, table_id: st.id, field_id: id, field_name: f.n, type: 30, ...comp })
      if (errOf(j2) && f.link.multi) {
        const c2 = { ...comp }
        delete c2.multiple_value_support
        j2 = await api('PUT', '/fields', { base_id: BASE.id, table_id: st.id, field_id: id, field_name: f.n, type: 30, ...c2 })
      }
      const e2 = errOf(j2)
      if (e2) {
        console.log(`! ${t.name}.${f.n} rename: ${e2}`)
        continue
      }
      delete st.fields[Object.keys(st.fields).find((k) => st.fields[k] === id)]
      st.fields[f.n] = id
      save()
      console.log(`+ ${t.name}.${f.n} → ${f.link.to}`)
    }
  }
}

/* ---------- seed ---------- */
const YEARLY = '{P}-{YYYY}-{N}'
const PLAIN = '{P}-{N}'
const SEEDS = [
  {
    table: 'Vendor Types',
    rows: [
      { Name: 'Farmer', 'Source Kind': 'Farmer', Description: 'Produce suppliers', Status: 'Active' },
      { Name: 'Vendor', 'Source Kind': 'Vendor', Description: 'Material and packing suppliers', Status: 'Active' },
    ],
  },
  {
    table: 'Storage Locations',
    rows: [
      { Name: 'RM Store', Label: 'Raw Material Store', Type: 'Dry Store', Holds: 'Produce received from farmers waiting to be pressed', Status: 'Active' },
      { Name: 'PM Store', Label: 'Packaging Store', Type: 'Dry Store', Holds: 'BiBs, cartons, bottles, caps and malai covers', Status: 'Active' },
      { Name: 'Bulk Store', Label: 'Bulk Cold Room', Type: 'Cold Room', Holds: 'Extracted juice, water, malai and melanges waiting to be packed', Status: 'Active' },
      { Name: 'Cold Room', Label: 'Finished Goods Cold Room', Type: 'Cold Room', Holds: 'Frozen finished packs until dispatched', Status: 'Active' },
      { Name: 'Reject Hold', Label: 'Rejected Stock', Type: 'Hold Area', Holds: 'Quality-rejected stock awaiting a decision', Status: 'Active' },
    ],
  },
  {
    table: 'Items',
    rows: [
      ['Tender Coconut', 'Raw Material', 'Piece', 500, 'Lot Actual'],
      ['Coconut Water (bulk)', 'Semi Finished', 'Litre', 0, 'Batch Actual'],
      ['Malai (bulk)', 'Semi Finished', 'Kg', 0, 'By-product'],
      ['Malai Cover', 'Packing Material', 'Piece', 100, 'Weighted Avg'],
      ['5 L BiB', 'Packing Material', 'Piece', 100, 'Weighted Avg'],
      ['5 L C-Box', 'Packing Material', 'Piece', 100, 'Weighted Avg'],
      ['2.5 L BiB', 'Packing Material', 'Piece', 100, 'Weighted Avg'],
      ['2.5 L C-Box', 'Packing Material', 'Piece', 100, 'Weighted Avg'],
      ['250 ml Glass Bottle', 'Packing Material', 'Piece', 500, 'Weighted Avg'],
      ['250 ml Cap', 'Packing Material', 'Piece', 500, 'Weighted Avg'],
      ['OG Tender Coconut Water 5 L', 'Finished Goods', 'Pack', 30, 'Batch Actual'],
      ['OG TCW 2.5 L', 'Finished Goods', 'Pack', 30, 'Batch Actual'],
      ['OG TCW 250 ml', 'Finished Goods', 'Bottle', 200, 'Batch Actual'],
      ['Malai Pack', 'Finished Goods', 'Kg', 10, 'Batch Actual'],
    ].map(([Name, Type, UOM, Reorder, Cost]) => ({ Name, Type, UOM, 'Lot Controlled': true, 'Reorder Level': Reorder, 'Cost Method': Cost })),
  },
  {
    table: 'Products',
    rows: [
      { Name: 'OG TCW 5 L', Format: 'BiB', Size: 5, Unit: 'L', 'Pack Volume': 5, 'Shelf Life Days': 7, 'Bulk Item': 'Coconut Water (bulk)', Medium: 'Water' },
      { Name: 'OG TCW 2.5 L', Format: 'BiB', Size: 2.5, Unit: 'L', 'Pack Volume': 2.5, 'Shelf Life Days': 7, 'Bulk Item': 'Coconut Water (bulk)', Medium: 'Water' },
      { Name: 'OG TCW 250 ml', Format: 'Glass Bottle', Size: 250, Unit: 'ml', 'Pack Volume': 0.25, 'Shelf Life Days': 7, 'Bulk Item': 'Coconut Water (bulk)', Medium: 'Water' },
      { Name: 'Malai Cover 1 kg', Format: 'Cover', Size: 1, Unit: 'kg', 'Pack Volume': 1, 'Shelf Life Days': 7, 'Bulk Item': 'Malai (bulk)', Medium: 'Malai' },
    ],
  },
  {
    table: 'BOM Lines',
    rows: [
      { Product: 'OG TCW 5 L', Item: '5 L BiB', 'Qty per Pack': 1 },
      { Product: 'OG TCW 5 L', Item: '5 L C-Box', 'Qty per Pack': 1 },
      { Product: 'OG TCW 2.5 L', Item: '2.5 L BiB', 'Qty per Pack': 1 },
      { Product: 'OG TCW 2.5 L', Item: '2.5 L C-Box', 'Qty per Pack': 1 },
      { Product: 'OG TCW 250 ml', Item: '250 ml Glass Bottle', 'Qty per Pack': 1 },
      { Product: 'OG TCW 250 ml', Item: '250 ml Cap', 'Qty per Pack': 1 },
      { Product: 'Malai Cover 1 kg', Item: 'Malai Cover', 'Qty per Pack': 1 },
    ],
  },
  {
    table: 'Test Categories',
    rows: [
      { Title: 'Microbiology', Format: 'Results', 'Required for Release': true, Status: 'Active' },
      { Title: 'Pesticide Residues', Format: 'Results', 'Required for Release': true, Status: 'Active' },
      { Title: 'Heavy Metals', Format: 'Results', 'Required for Release': true, Status: 'Active' },
      { Title: 'Physicochemical', Format: 'Results', 'Required for Release': true, Status: 'Active' },
      { Title: 'Sensory Evaluation', Format: 'Scored', 'Required for Release': true, 'Pass Score': 80, 'Minor Score': 60, Status: 'Active' },
    ],
  },
  {
    table: 'Test Parameters',
    rows: [
      { Name: 'Aerobic Plate count', Category: 'Microbiology', Method: 'IS 5402-1:2021', Unit: 'Cfu/mL' },
      { Name: 'Listeria monocytogenes', Category: 'Microbiology', Method: 'IS 14988-1:2020', Unit: '/25mL' },
      { Name: 'Staphylococcus aureus', Category: 'Microbiology', Method: 'IS 5887-2:1976', Unit: '/mL' },
      { Name: 'Vibrio cholerae', Category: 'Microbiology', Method: 'IS 5887-5/Sec-1:2023', Unit: '/25mL' },
      { Name: 'Yeast and Moulds', Category: 'Microbiology', Method: 'IS 5403:1999', Unit: 'Cfu/mL' },
      { Name: 'E. coli', Category: 'Microbiology', Method: 'IS 5887-1:1976', Unit: '/mL' },
      { Name: 'Salmonella spp', Category: 'Microbiology', Method: 'IS 5887-3/Sec-1:2020', Unit: '/25mL' },
    ],
  },
  {
    table: 'Counters',
    rows: [
      ['grn', 'RFTC', '{P}{YYYY}{N}', 4, 1],
      ['lot', 'LOT', '{P}-{YYYYMMDD}-{N}', 3, 1],
      ['batch', 'BAT', YEARLY, 4, 1],
      ['melangeBatch', 'MEL', YEARLY, 4, 1],
      ['packing', 'PKG', YEARLY, 4, 1],
      ['order', 'ORD', YEARLY, 4, 1],
      ['dispatch', 'DSP', YEARLY, 4, 1],
      ['challan', 'DC', '{P}{N}/{YYYY}', 4, 1],
      ['issue', 'ISS', YEARLY, 4, 1],
      ['plan', 'PLN', YEARLY, 4, 1],
      ['pmReceipt', 'PMR', YEARLY, 4, 1],
      ['qc', 'QC', YEARLY, 4, 1],
      ['testReport', 'TR', YEARLY, 4, 1],
      ['sticker', 'STK', YEARLY, 4, 1],
      ['vendor', 'VEN', PLAIN, 5, 1],
      ['vendorType', 'VT', PLAIN, 4, 1],
      ['customer', 'CUS', PLAIN, 5, 1],
      ['purchaseProduct', 'PP', PLAIN, 4, 1],
      ['product', 'FG', PLAIN, 4, 1],
      ['bulkProduct', 'SF', PLAIN, 4, 1],
      ['staff', 'STF', PLAIN, 4, 6],
    ].map(([Series, Prefix, Pattern, Pad, Next]) => ({ Series, Prefix, Pattern, Pad, Next })),
  },
  {
    table: 'Config',
    rows: [
      { Setting: 'yieldTolerance', Value: '12', Notes: 'Pct below estimated output still accepted' },
      { Setting: 'pmTolerance', Value: '5', Notes: 'Pct packing-material variance allowed' },
      { Setting: 'expiryAlertDays', Value: '2', Notes: 'Shelf-life alert window' },
      { Setting: 'lowStockPacks', Value: '50', Notes: 'Finished-goods low-stock threshold' },
      { Setting: 'reportCustomerName', Value: 'Roligt Foods Private Limited', Notes: 'Printed on COA' },
      { Setting: 'reportCustomerAddress', Value: 'Sy No- 617, Pudur village, Medchal Mandal, Hyderabad, Telangana-501401.', Notes: 'Printed on COA' },
      { Setting: 'frozenStorageLine', Value: 'Always store in Cool (-18°C) Dry and Hygiene Place', Notes: 'Sticker' },
      { Setting: 'chilledStorageLine', Value: 'Always store in Cool (4°C) Dry & Hygiene Place', Notes: 'Sticker' },
      { Setting: 'consumeWithinLine', Value: 'Consume within 3 days of opening', Notes: 'Sticker' },
    ],
  },
  {
    table: 'Staff',
    rows: [
      { 'Staff No': 'STF-0001', Name: 'Ramesh Kumar', Role: 'Supervisor', Phone: '98450 11001', Status: 'Active', 'Added On': '2026-01-05' },
      { 'Staff No': 'STF-0002', Name: 'Suresh Naik', Role: 'Extraction operator', Phone: '98450 11002', Status: 'Active', 'Added On': '2026-01-05' },
      { 'Staff No': 'STF-0003', Name: 'Priya Shetty', Role: 'QC analyst', Phone: '98450 11003', Status: 'Active', 'Added On': '2026-01-05' },
      { 'Staff No': 'STF-0004', Name: 'Anita Fernandes', Role: 'Packing line', Phone: '98450 11004', Status: 'Active', 'Added On': '2026-01-05' },
      { 'Staff No': 'STF-0005', Name: 'Mohan Das', Role: 'Driver', Phone: '98450 11005', Status: 'Active', 'Added On': '2026-01-05' },
    ],
  },
]

async function phaseSeed() {
  state.seeded = state.seeded || {}
  for (const s of SEEDS) {
    const st = state.tables[s.table]
    if (!st || !Object.keys(st.fields).length) await listFields(s.table)
    const done = state.seeded[s.table] || 0
    for (let i = done; i < s.rows.length; i++) {
      const values = {}
      let missing = false
      for (const [k, v] of Object.entries(s.rows[i])) {
        const id = st.fields[k]
        if (!id) {
          console.log(`! ${s.table}: no field "${k}" — value dropped`)
          missing = true
          continue
        }
        values[id] = v
      }
      const j = await api('POST', '/records', { base_id: BASE.id, table_id: st.id, field_ids_with_values: values })
      const e = errOf(j)
      if (e) console.log(`! ${s.table}[${i}]: ${e}`)
      state.seeded[s.table] = e ? i : i + 1
      save()
      if (e && missing) break
    }
    console.log(`${s.table}: ${state.seeded[s.table] || 0}/${s.rows.length}`)
  }
}

async function phaseCleanup() {
  const existing = arr(await api('GET', '/tables', { base_id: BASE.id }), 'tables', 'fetched')
  for (const t of existing) {
    if (t.name === 'Table 1' || /^zz-/.test(t.name)) {
      const j = await api('DELETE', '/tables', { base_id: BASE.id, table_id: t.tableID })
      console.log(`- ${t.name} ${errOf(j) ? 'FAILED: ' + errOf(j) : 'deleted'}`)
    }
  }
}

async function phaseVerify() {
  const ts = arr(await api('GET', '/tables', { base_id: BASE.id }), 'tables', 'fetched')
  console.log(`\nBase: ${BASE.name} (${BASE.id})`)
  for (const t of ts.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`  ${t.name.padEnd(20)} ${String(t.fieldsCount).padStart(3)} fields ${String(t.recordsCount).padStart(4)} records  ${t.tableID}`)
}

const phase = process.argv[2]
const phases = {
  tables: phaseTables,
  'fields-m': () => phaseFields('m'),
  'fields-t': () => phaseFields('t'),
  dedup: phaseDedup,
  options: phaseOptions,
  links: phaseLinks,
  seed: phaseSeed,
  cleanup: phaseCleanup,
  verify: phaseVerify,
}
if (!phases[phase]) {
  console.error('usage: node build-tables.mjs tables|fields-m|fields-t|dedup|options|links|seed|cleanup|verify')
  process.exit(1)
}
phases[phase]()
  .then(() => {
    save()
    console.log('\nDONE ' + phase)
  })
  .catch((e) => {
    console.error('FAILED ' + phase + ': ' + e.message)
    process.exit(1)
  })
