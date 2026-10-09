#!/usr/bin/env node
/**
 * Read-only table views over the document store, for people browsing D1.
 *
 * The engine keeps every collection in one `documents` table, one JSON blob a
 * row (schema.sql — the Zoho document shape byte-for-byte), so the Cloudflare
 * dashboard shows four tables and a column of JSON. This creates one VIEW per
 * collection — v_items, v_batches, v_ledger, … — with a column per field,
 * pulled out of the JSON by json_extract. Views hold no data and the engine
 * never reads them: they cannot drift from the documents, and dropping them
 * changes nothing. Nested values (a batch's outputLines, a pack's bom) come
 * out as JSON text.
 *
 * Fields are discovered from the documents themselves, so re-run after a new
 * field or collection appears (and after the cutover import) to pick it up.
 *
 * usage: node scripts/d1/views.mjs [--dry-run] [--drop]
 *   --dry-run  print the SQL instead of applying it
 *   --drop     remove every v_* view this script made
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
const argv = new Set(process.argv.slice(2))
const DRY = argv.has('--dry-run')
const DROP = argv.has('--drop')
const { D1_ACCOUNT_ID: ACCOUNT, D1_API_TOKEN: TOKEN, D1_DATABASE_ID: DATABASE } = process.env
if (!ACCOUNT || !TOKEN || !DATABASE) {
  console.error('D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID are required (env or .env).')
  process.exit(1)
}
const URL_QUERY = `${process.env.D1_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`

async function query(sql, params = []) {
  const res = await fetch(URL_QUERY, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const json = await res.json().catch(() => null)
  if (!json?.success) throw new Error(`query refused (HTTP ${res.status}): ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`)
  return json.result[0].results ?? []
}

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
// a collection name becomes part of an identifier; anything odd is spelled out
const viewName = (c) => `v_${c.replace(/[^A-Za-z0-9_]/g, '_')}`

const existing = (await query(`SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v\\_%' ESCAPE '\\'`)).map((r) => r.name)
const statements = existing.map((v) => `DROP VIEW IF EXISTS ${ident(v)};`)

if (!DROP) {
  const collections = (await query('SELECT collection, COUNT(*) AS n FROM documents GROUP BY collection ORDER BY collection'))
  for (const { collection, n } of collections) {
    // keys in first-seen order across the collection, so the columns read the
    // way the documents are written (id, date, … rather than alphabetically)
    const keys = (
      await query(
        `SELECT j.key AS key, MIN(d.rowid * 1000 + j.id) AS ord
           FROM documents d, json_each(d.json) j
          WHERE d.collection = ? AND json_type(d.json) = 'object'
          GROUP BY j.key ORDER BY ord`,
        [collection],
      )
    ).map((r) => r.key)
    const cols = [
      'd.id AS id',
      ...keys.filter((k) => k !== 'id').map((k) => `json_extract(d.json, ${lit(`$."${k.replace(/"/g, '\\"')}"`)}) AS ${ident(k)}`),
      'd.updated_at AS _updated_at',
    ]
    statements.push(
      `CREATE VIEW ${ident(viewName(collection))} AS SELECT ${cols.join(', ')} FROM documents d WHERE d.collection = ${lit(collection)};`,
    )
    console.error(`${viewName(collection)}: ${keys.length} fields, ${n} rows`)
  }
}

if (DRY) {
  console.log(statements.join('\n'))
} else {
  for (const s of statements) await query(s)
  console.error(DROP ? `dropped ${existing.length} views` : `applied ${statements.length} statements`)
}
