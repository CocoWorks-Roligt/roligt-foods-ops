#!/usr/bin/env node
/**
 * One-off data correction: vanilla arrives already extracted.
 *
 * On 3 Oct the plant booked an extraction, BAT-2026-0009, that "pressed" 0.01 L of
 * bought vanilla extract (RM-PP-0008, lot RFTC-20261008-008) into a bulk, Vanilla
 * Bean Extract (SF-0008), and the Vanilla Smoothie run MEL-2026-0007 then drew that
 * bulk. Nothing was ever extracted — the material is used as bought (directUse) — so
 * the history is restated as it happened: the blend run drew the raw lot directly.
 *
 * In one atomic batch:
 *   - the extraction's raw-material draw becomes the blend run's draw (same lot,
 *     place, status and quantity — only its type, document and time change), so the
 *     raw lot's balance is untouched;
 *   - MEL-2026-0007's blend line names the raw lot instead of the bulk lot;
 *   - the bulk's output and consume lines, the extraction and SF-0008 are removed;
 *   - an audit entry records the correction, and the revision is bumped so every
 *     open device adopts it on its next poll.
 * Every update is version-guarded; a document that moved since it was read rolls
 * the whole batch back. Preconditions are checked first and a re-run finds nothing
 * to do.
 *
 * Needed twice: on scratch (the preview), and on prod after the cutover import —
 * the extraction is in the production Zoho base the dump is taken from.
 *
 * usage: node scripts/d1/fix-vanilla-direct-use.mjs [--apply]
 *   (without --apply it prints the plan and changes nothing)
 * Reads D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID from the environment or .env.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CW = join(HERE, '..', '..')
if (existsSync(join(CW, '.env'))) {
  for (const line of readFileSync(join(CW, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const APPLY = process.argv.includes('--apply')
const { D1_ACCOUNT_ID: ACCOUNT, D1_API_TOKEN: TOKEN, D1_DATABASE_ID: DATABASE } = process.env
if (!ACCOUNT || !TOKEN || !DATABASE) {
  console.error('D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID are required (env or .env).')
  process.exit(1)
}
const URL_QUERY = `${process.env.D1_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`

const BULK = 'SF-0008'
const RAW = 'RM-PP-0008'
const EXTRACTION = 'BAT-2026-0009'
const BLEND_RUN = 'MEL-2026-0007'

async function post(body) {
  const res = await fetch(URL_QUERY, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!json?.success) throw new Error(`refused (HTTP ${res.status}): ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`)
  return json.result
}
const query = async (sql, params = []) => (await post({ sql, params }))[0].results ?? []

const docs = async (where, params) =>
  (await query(`SELECT collection, id, version, json FROM documents WHERE ${where}`, params)).map((r) => ({
    ...r,
    doc: JSON.parse(r.json),
  }))

const fail = (msg) => {
  console.error(`not applied: ${msg}`)
  process.exit(1)
}

// --- read everything the correction touches ---------------------------------
const [bulk] = await docs(`collection = 'items' AND id = ?`, [BULK])
const [extraction] = await docs(`collection = 'batches' AND id = ?`, [EXTRACTION])
const [blendRun] = await docs(`collection = 'batches' AND id = ?`, [BLEND_RUN])
const bulkLines = await docs(
  `collection = 'ledger' AND (json_extract(json, '$.item') = ? OR json_extract(json, '$.lot') = ? OR json_extract(json, '$.doc') = ?)`,
  [BULK, EXTRACTION, EXTRACTION],
)

if (!bulk && !extraction && !bulkLines.length) {
  console.log(`nothing to do — ${BULK} and ${EXTRACTION} are already gone.`)
  process.exit(0)
}
if (!bulk || !extraction || !blendRun) fail(`expected ${BULK}, ${EXTRACTION} and ${BLEND_RUN} to exist together.`)

// --- preconditions: the history is exactly the one this script restates -----
const rawDraw = bulkLines.filter((l) => l.doc.type === 'Production Consume' && l.doc.doc === EXTRACTION)
const output = bulkLines.filter((l) => l.doc.type === 'Production Output' && l.doc.doc === EXTRACTION)
const blendDraw = bulkLines.filter((l) => l.doc.type === 'Melange Consume' && l.doc.doc === BLEND_RUN)
if (rawDraw.length !== 1 || rawDraw[0].doc.item !== RAW) fail(`${EXTRACTION} should draw ${RAW} on exactly one line.`)
if (output.length !== 1 || output[0].doc.item !== BULK) fail(`${EXTRACTION} should book ${BULK} on exactly one line.`)
if (blendDraw.length !== 1 || blendDraw[0].doc.item !== BULK) fail(`${BLEND_RUN} should draw ${BULK} on exactly one line.`)
if (bulkLines.length !== 3) {
  fail(`${BULK} / ${EXTRACTION} has ${bulkLines.length} ledger lines, expected 3 — it moved since this was written: ${bulkLines.map((l) => `${l.id} ${l.doc.type}`).join(', ')}`)
}
const qty = rawDraw[0].doc.qty_out
if (Math.abs(output[0].doc.qty_in - qty) > 1e-9 || Math.abs(blendDraw[0].doc.qty_out - qty) > 1e-9) {
  fail(`quantities disagree: drawn ${qty}, booked ${output[0].doc.qty_in}, blended ${blendDraw[0].doc.qty_out}.`)
}
const blendLineIdx = (blendRun.doc.blendLines || []).findIndex((b) => b.item === BULK && b.lot === EXTRACTION)
if (blendLineIdx < 0) fail(`${BLEND_RUN} has no blend line for ${BULK} lot ${EXTRACTION}.`)
const refs = await query(
  `SELECT collection, id FROM documents
    WHERE collection NOT IN ('audits', 'ledger') AND NOT (collection = 'items' AND id = ?)
      AND NOT (collection = 'batches' AND id IN (?, ?))
      AND (json LIKE ? OR json LIKE ?)`,
  [BULK, EXTRACTION, BLEND_RUN, `%"${BULK}"%`, `%"${EXTRACTION}"%`],
)
if (refs.length) fail(`still referenced by ${refs.map((r) => `${r.collection}/${r.id}`).join(', ')} — clear those first.`)

// --- the restated documents --------------------------------------------------
const now = new Date().toISOString()
const blendTime = blendDraw[0].doc.at
const movedDraw = { ...rawDraw[0].doc, type: 'Melange Consume', doc: BLEND_RUN, at: blendTime }
const blendLines = blendRun.doc.blendLines.map((b, i) =>
  i === blendLineIdx
    ? { item: RAW, lot: rawDraw[0].doc.lot, uom: rawDraw[0].doc.uom, qty: b.qty, unitCost: rawDraw[0].doc.unit_cost }
    : b,
)
const restatedRun = { ...blendRun.doc, blendLines }
const audit = {
  id: `AUD-FIX-${now.replace(/\D/g, '').slice(0, 14)}`,
  at: now,
  actor: 'data correction (scripts/d1/fix-vanilla-direct-use.mjs)',
  action: 'Corrected history',
  doc: BLEND_RUN,
  details: `Vanilla is used as bought: ${BLEND_RUN} now draws ${RAW} lot ${rawDraw[0].doc.lot} (${qty} ${rawDraw[0].doc.uom}) directly; extraction ${EXTRACTION} and bulk ${BULK} (${bulk.doc.name}) removed.`,
}

const upd = (row, json) => [
  {
    sql: `UPDATE documents SET json = ?, version = version + 1, updated_at = ? WHERE collection = ? AND id = ? AND version = ?`,
    params: [JSON.stringify(json), now, row.collection, row.id, row.version],
  },
  { sql: 'INSERT INTO _assert_changed VALUES (changes())' },
]
const del = (row) => [
  { sql: 'DELETE FROM documents WHERE collection = ? AND id = ? AND version = ?', params: [row.collection, row.id, row.version] },
  { sql: 'INSERT INTO _assert_changed VALUES (changes())' },
]
const batch = [
  { sql: 'DELETE FROM _assert_changed' },
  ...upd(rawDraw[0], movedDraw),
  ...upd(blendRun, restatedRun),
  ...del(output[0]),
  ...del(blendDraw[0]),
  ...del(extraction),
  ...del(bulk),
  {
    sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('audits', ?, ?, 1, ?)`,
    params: [audit.id, JSON.stringify(audit), now],
  },
  {
    sql: `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) || ':' || ? WHERE setting = 'app_revision' RETURNING value`,
    params: [Math.random().toString(36).slice(2, 8)],
  },
]

console.log(`database ${DATABASE}`)
console.log(`  ledger ${rawDraw[0].id}: Production Consume ${EXTRACTION} -> Melange Consume ${BLEND_RUN} (${RAW} ${rawDraw[0].doc.lot}, ${qty} ${rawDraw[0].doc.uom})`)
console.log(`  batch  ${BLEND_RUN}: blend line ${BULK}/${EXTRACTION} -> ${RAW}/${rawDraw[0].doc.lot}`)
console.log(`  remove ledger ${output[0].id} (Production Output ${BULK}), ${blendDraw[0].id} (Melange Consume ${BULK})`)
console.log(`  remove batch ${EXTRACTION}, item ${BULK} (${bulk.doc.name})`)
console.log(`  audit  ${audit.id}`)
if (!APPLY) {
  console.log('dry run — re-run with --apply to write it.')
  process.exit(0)
}
const result = await post({ batch: batch.map((s) => ({ sql: s.sql, params: s.params ?? [] })) })
console.log(`applied; revision now ${result.at(-1).results?.[0]?.value}`)
