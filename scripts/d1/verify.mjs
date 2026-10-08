#!/usr/bin/env node
/**
 * The loader's checker: after `wrangler d1 execute --file dump.sql`, prove the
 * loaded database matches the dump's manifest — per-table counts first (fast,
 * catches truncation), then a full canonical compare (every row's id + json,
 * hashed the same way the manifest was). Exits non-zero on any mismatch, so
 * the cutover runbook can chain it.
 *
 * usage: node scripts/d1/verify.mjs --manifest scripts/d1/dump-<base8>-<date>.manifest.json
 * Reads D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID from the environment or .env.
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, dirname } from 'node:url'
import { join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CW = join(HERE, '..', '..')
if (existsSync(join(CW, '.env'))) {
  for (const line of readFileSync(join(CW, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
  }
}
const argv = process.argv.slice(2)
const mIdx = argv.indexOf('--manifest')
const MANIFEST = mIdx >= 0 ? argv[mIdx + 1] : null
if (!MANIFEST || !existsSync(MANIFEST)) {
  console.error('usage: node scripts/d1/verify.mjs --manifest <dump .manifest.json>')
  process.exit(1)
}
const { D1_ACCOUNT_ID: ACCOUNT, D1_API_TOKEN: TOKEN, D1_DATABASE_ID: DATABASE } = process.env
if (!ACCOUNT || !TOKEN || !DATABASE) {
  console.error('D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID are required (env or .env).')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const URL_QUERY = `${process.env.D1_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`

async function query(sql) {
  const res = await fetch(URL_QUERY, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params: [] }),
  })
  const json = await res.json().catch(() => null)
  if (!json?.success) throw new Error(`query refused (HTTP ${res.status}): ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`)
  return json.result[0].results ?? []
}

const sha = (lines) => createHash('sha256').update([...lines].sort().join('\n')).digest('hex')

let failures = 0
for (const [tableName, entry] of Object.entries(manifest.tables)) {
  if (entry.collection === 'counters') {
    const rows = await query('SELECT series, next FROM counters')
    const lines = rows.map((r) => `'${r.series}',${r.next}`)
    const ok = rows.length === entry.count && sha(lines) === entry.sha256
    if (!ok) failures++
    console.log(`${ok ? 'OK  ' : 'FAIL'} Counters: ${rows.length}/${entry.count} rows${ok ? '' : ', canonical hash differs'}`)
    continue
  }
  if (entry.collection === 'meta') {
    const rows = await query('SELECT setting, value FROM meta')
    const lines = rows.map((r) => `${r.setting} ${r.value}`)
    const ok = rows.length === entry.count && sha(lines) === entry.sha256
    if (!ok) failures++
    console.log(`${ok ? 'OK  ' : 'FAIL'} Config: ${rows.length}/${entry.count} rows${ok ? '' : ', canonical hash differs'}`)
    continue
  }
  const rows = await query('SELECT id, json FROM documents WHERE collection = ?', [entry.collection])
  // canonical form mirrors the dump: `${id} ${json}` per row, sorted, hashed
  const lines = rows.map((r) => `${r.id} ${r.json}`)
  const ok = rows.length === entry.count && sha(lines) === entry.sha256
  if (!ok) failures++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${tableName} (${entry.collection}): ${rows.length}/${entry.count} rows${ok ? '' : ', canonical hash differs'}`)
}

if (failures) {
  console.error(`\n${failures} table(s) FAILED — do not cut over`)
  process.exit(1)
}
console.log('\nall tables verified against the manifest')
