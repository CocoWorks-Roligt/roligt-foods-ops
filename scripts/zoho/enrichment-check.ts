/**
 * Live check of the Plan 2 column enrichment, two passes:
 *
 *   pass 1 — commits one clearly-marked TEST document per table through the REAL
 *            commit path. Masters and their children land together, so the link
 *            columns are EXPECTED empty here: link maps are built before the
 *            writes, and the targets do not exist yet.
 *   pass 2 — re-saves only the link-carrying rows (batch, product, dispatch,
 *            shift) with a marker field and an `expect` of what pass 1 stored —
 *            exactly the shape the honest client sends on an edit. The maps now
 *            hold the masters, so the link columns must fill.
 *
 * Then reads every row back and prints what actually landed in the real columns,
 * choice labels resolved off the live field metadata, link values cross-checked
 * against the target rows' record ids.
 *
 * usage: npx tsx scripts/zoho/enrichment-check.ts [--keep]
 * Scratch base only; hard-refuses production. Without --keep the TEST rows are
 * deleted again at the end.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..')
const KEEP = process.argv.includes('--keep')

const readEnv = (f: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )

const env = { ...readEnv(join(CW, '.zoho.env')), ...readEnv(join(CW, '.env')) }
const PRODUCTION_BASE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const base = env.ZOHO_BASE_ID ?? ''
if (base === PRODUCTION_BASE) {
  console.error('REFUSING: this check writes TEST rows — it never runs against the production base.')
  process.exit(1)
}
console.log(`enrichment check against base ${base} (${base === 'dhorj90a2ded0152a4f1d94ae8ce4ece09a5c' ? 'scratch' : 'WARNING: not the known scratch base'})`)

const { ZohoClient } = await import('../../api/_lib/zoho.js')
const { commitChanges } = await import('../../api/_lib/commit.js')
const { T, TABLE_FOR } = await import('../../api/_lib/baseSchema.js')
const { rowToDoc } = await import('../../api/_lib/mappers.js')
const { PERMISSIONS } = await import('../../src/lib/permissions.js')
import type { Caller } from '../../api/_lib/auth.js'
import type { StateChanges } from '../../src/lib/sync.js'

const zoho = new ZohoClient({ env })
const admin: Caller = { email: 'enrichment-check@roligt.local', permissions: [...PERMISSIONS] }

// One TEST doc per table, shaped exactly as the app writes them. Links cross rows:
// dispatch → customer (id), batch (id), product (name); batch → location (name);
// product → item (name); shift → staff (id).
const DOCS: Record<string, Record<string, unknown>> = {
  storage_locations: { id: 'TEST-LOC-1', name: 'Test Freezer', label: 'Test Freezer', holds: 'enrichment check rows', type: 'Cold Room', status: 'Active' },
  items: { id: 'TEST-ITEM-1', name: 'Test Coconut Water', type: 'Raw', uom: 'Litre', lotControlled: true, reorder: 10, costMethod: 'FIFO' },
  customers: { id: 'TEST-CUST-1', name: 'Test Hotel', shipTo: '12 Test Lane', gst: '29TESTGST1234F1Z5', status: 'Active', phone: '+91 98450 11122', email: 'test@example.in', contactPerson: 'Test Person', notes: 'column enrichment check' },
  products: { id: 'TEST-PROD-1', name: 'Test 250ml BiB', type: 'BiB', size: 250, unit: 'ml', packVolume: 0.25, shelfLifeDays: 365, mrp: 40, bulkItem: 'Test Coconut Water' },
  batches: { id: 'TEST-BTH-1', date: '2026-10-06', kind: 'Extraction', spoiled: 3, costPerL: 18.5, status: 'Released', location: 'Test Freezer' },
  dispatches: { id: 'TEST-DSP-1', customerId: 'TEST-CUST-1', customerName: 'Test Hotel', batchId: 'TEST-BTH-1', sku: 'Test 250ml BiB', qty: 10, expiry: '2027-10-06', challan: 'TEST-CH-1', vehicle: 'TEST-KA-01', dispatchTime: '2026-10-06T08:30:00.000Z', status: 'Dispatched', pod: 'Test POD' },
  staff: { id: 'TEST-STF-1', name: 'Test Worker', role: 'Operator', phone: '98450 11122', status: 'Active', addedOn: '2026-10-06' },
  shifts: { id: 'TEST-STF-1|2026-10-06', staffId: 'TEST-STF-1', date: '2026-10-06', shift: 'Morning', line: 'Extraction', note: 'enrichment check' },
  stock_issues: { id: 'TEST-ISS-1', date: '2026-10-06', reason: 'Lab / testing', recipient: 'Test Lab', lines: [{ item: 'Test 250ml BiB', itemType: 'Finished', lot: 'TEST-BTH-1', location: 'Test Freezer', status: 'Released', uom: 'Pack', qty: 2, unitCost: 40, expiry: '2027-10-06' }], value: 80 },
}
// pass 2 re-saves these with a marker (the doc must genuinely change or the
// idempotent skip leaves the columns as pass 1 wrote them)
const LINK_CARRYING = ['batches', 'products', 'dispatches', 'shifts']

console.log('\n── pass 1: create every TEST row (links expected empty — targets do not exist yet)')
const pass1 = await commitChanges(zoho, admin, {
  empty: false,
  tables: Object.entries(DOCS).map(([table, doc]) => ({ table, upsert: [{ id: String(doc.id), data: doc }], remove: [] })),
  counters: {},
} as StateChanges)
console.log(`pass 1 ${pass1.wrote ? 'wrote' : 'wrote NOTHING'} — revision ${pass1.token}`)

console.log('\n── pass 2: re-save the link-carrying rows, expect = what pass 1 stored')
const pass2 = await commitChanges(zoho, admin, {
  empty: false,
  tables: LINK_CARRYING.map((table) => {
    const doc = { ...DOCS[table], enrichPass: 2 }
    return { table, upsert: [{ id: String(DOCS[table]!.id), data: doc }], remove: [], expect: { [String(DOCS[table]!.id)]: { data: DOCS[table] } } }
  }),
  counters: {},
} as StateChanges)
console.log(`pass 2 ${pass2.wrote ? 'wrote' : 'wrote NOTHING'} — revision ${pass2.token}`)

// Live field metadata: choice option ids → labels, so type-21 columns read as names.
const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + 300_000 > Date.now()) return tok.access_token as string
  const p = new URLSearchParams({ refresh_token: env.refresh_token, client_id: env.client_id, client_secret: env.client_secret, grant_type: 'refresh_token' })
  const j = await (await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })).json()
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token as string
}
const choiceLabels = new Map<string, Map<string, string>>() // tableId → optionID → label
const linkFields = new Map<string, Set<string>>()            // tableId → OWNED link column field ids
const linkMirrors = new Map<string, Set<string>>()           // tableId → MIRROR link field ids
for (const baseName of new Set(Object.values(TABLE_FOR))) {
  const t = T[baseName]
  const j = (await (await fetch(`https://${env.ZOHO_DC ?? 'tables.zoho.in'}/api/v1/fields?base_id=${base}&table_id=${t.id}`, { headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })).json()) as {
    fields?: { fetched?: { fieldID: string; type: string; typeComponents?: { relationshipDirection?: number | string } }[] }
    selectionOptions?: { fetched?: { fieldID: string; options: { optionID: string; name: string }[] }[] }
  }
  const opts = new Map<string, string>()
  for (const sel of j.selectionOptions?.fetched ?? []) for (const o of sel.options) opts.set(o.optionID, o.name)
  if (opts.size) choiceLabels.set(t.id, opts)
  // direction 1 = the owned, writable side; direction 2 = the MIRROR Zoho auto-fills
  // when the owned side lands — read-only proof, never something the app writes.
  // (The direction lives in typeComponents, not on the field itself.)
  const links = new Set(
    (j.fields?.fetched ?? []).filter((f) => f.type === '30' && String(f.typeComponents?.relationshipDirection ?? '1') !== '2').map((f) => f.fieldID),
  )
  if (links.size) linkFields.set(t.id, links)
  const mirrors = new Set(
    (j.fields?.fetched ?? []).filter((f) => f.type === '30' && String(f.typeComponents?.relationshipDirection ?? '1') === '2').map((f) => f.fieldID),
  )
  if (mirrors.size) linkMirrors.set(t.id, mirrors)
}

// Read back: rows by table, appId → recordID for link cross-checks, columns by name.
const recordIds = new Map<string, string>() // 'table:appId' → zoho recordID
const rowsByTable = new Map<string, { recordID: string; data: Record<string, unknown> }[]>()
for (const table of Object.keys(DOCS)) {
  const t = T[TABLE_FOR[table]!]
  const rows = await zoho.fetchAll(t.id)
  rowsByTable.set(table, rows)
  for (const r of rows) recordIds.set(`${table}:${String(r.data[t.appId])}`, r.recordID)
}
/** What a link column SHOULD hold, if it resolved. */
const expectLink: Record<string, Record<string, string>> = {
  batches: { Location: 'storage_locations:TEST-LOC-1' },
  products: { 'Bulk Item': 'items:TEST-ITEM-1' },
  dispatches: { Customer: 'customers:TEST-CUST-1', SKU: 'products:TEST-PROD-1', Batch: 'batches:TEST-BTH-1' },
  shifts: { Staff: 'staff:TEST-STF-1' },
}

console.log('\n── read-back after pass 2, real columns by name (choice labels resolved)')
let fails = 0
for (const [table, doc0] of Object.entries(DOCS)) {
  const baseName = TABLE_FOR[table]!
  const t = T[baseName]
  const row = (rowsByTable.get(table) ?? []).find((r) => String(r.data[t.appId]) === String(doc0.id))
  if (!row) {
    console.log(`\n✗ ${baseName}: row ${String(doc0.id)} NOT FOUND`)
    fails++
    continue
  }
  const names = Object.fromEntries(Object.entries(t.fields).map(([name, id]) => [id, name]))
  const labels = choiceLabels.get(t.id)
  const links = linkFields.get(t.id)
  console.log(`\n● ${baseName} — ${String(doc0.id)} (record ${row.recordID})`)
  for (const [fid, v] of Object.entries(row.data)) {
    const name = names[fid] ?? fid
    if (name === 'Data JSON' || fid === t.appId) continue
    const raw = v === undefined || v === null || v === '' ? '' : String(v)
    if (!raw) { console.log(`    ${name.padEnd(22)} (empty)`); continue }
    if (labels?.has(raw)) { console.log(`    ${name.padEnd(22)} ${labels.get(raw)}  [choice ok]`); continue }
    // a MIRROR link column (the reverse side, auto-filled by Zoho) — its value is
    // proof the forward link landed, printed but never judged
    if (linkMirrors.get(t.id)?.has(fid)) { console.log(`    ${name.padEnd(22)} ${raw}  [mirror]`); continue }
    if (links?.has(fid)) {
      const want = expectLink[table]?.[name]
      const wantId = want ? recordIds.get(want) : undefined
      const ok = wantId !== undefined && (raw === wantId || raw.includes(wantId))
      console.log(`    ${name.padEnd(22)} ${raw}  [link ${ok ? 'ok' : 'UNEXPECTED — wanted ' + String(wantId)}]`)
      if (!ok) fails++
      continue
    }
    console.log(`    ${name.padEnd(22)} ${raw.length > 60 ? raw.slice(0, 57) + '…' : raw}`)
  }
  const expectedDoc = LINK_CARRYING.includes(table) ? { ...doc0, enrichPass: 2 } : doc0
  const same = JSON.stringify(rowToDoc(t, row)) === JSON.stringify(expectedDoc)
  console.log(`    Data JSON round-trip: ${same ? 'exact' : 'MISMATCH'}`)
  if (!same) fails++
}
console.log(`\n${fails === 0 ? '✓ all columns, choices, links and round-trips verified' : `✗ ${fails} problem(s) above`}`)
if (fails) process.exitCode = 1

if (!KEEP) {
  console.log('\n── cleanup (--keep to leave the TEST rows in the base)')
  for (const [table, doc] of Object.entries(DOCS)) {
    const t = T[TABLE_FOR[table]!]
    const row = (rowsByTable.get(table) ?? []).find((r) => String(r.data[t.appId]) === String(doc.id))
    if (row) {
      await zoho.deleteRecord(t.id, row.recordID)
      console.log(`    deleted ${TABLE_FOR[table]} ${String(doc.id)}`)
    }
  }
  const { bumpRevisionTo } = await import('../../api/_lib/commit.js')
  console.log(`    revision now ${await bumpRevisionTo(zoho, parseInt(pass2.token, 10) || 0)}`)
} else {
  console.log('\nTEST rows left in the base — find them by the TEST- prefix in Zoho Tables.')
}
