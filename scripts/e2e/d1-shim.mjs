#!/usr/bin/env node
/**
 * Local Cloudflare-D1-shaped shim — the E2E stand-in for api.cloudflare.com.
 *
 * api/_lib/d1.ts talks to D1 exclusively through its REST query endpoint and
 * honors D1_API_BASE, so pointing that env at this process gives the real
 * D1Client/engine/snapshot code a local better-sqlite3 to run against: no WAN,
 * no scratch pollution, a disposable per-run database. The wire contract it
 * answers (d1.ts is the spec):
 *
 *   POST /client/v4/accounts/<acct>/d1/database/<db>/query
 *     { sql, params }            — one statement, result[0]
 *     { batch: [{sql, params}] } — one transaction (atomicity is the point),
 *                                  one result per statement
 *   200 {success:true,  result:[{results, meta:{changes}}]}
 *   400 {success:false, errors:[{code, message}]}   — a refused statement; the
 *        engine maps the provider's own message (the schema names its CHECK
 *        constraint `_assert_changed` precisely so the message survives).
 *
 * Param fidelity: D1 binds JSON values; better-sqlite3 accepts null, number,
 * string — booleans never reach a real D1 write (the engine binds 0/1) but are
 * mapped defensively, and undefined → null, so a missed optional never crashes
 * the shim.
 *
 * usage: node scripts/e2e/d1-shim.mjs --db <file> [--port 8111]
 */
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const dbPath = flag('--db', join(root, 'scripts/e2e/.tmp/e2e.sqlite'))
const port = Number(flag('--port', '8111'))

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/** JSON param → a value better-sqlite3 binds. */
const bindable = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v)

/** One statement → the per-statement result slice D1 returns. */
function execStatement({ sql, params = [] }) {
  const stmt = db.prepare(sql)
  const bound = params.map(bindable)
  if (stmt.reader) {
    return { results: stmt.all(...bound), meta: { changes: 0, rows_read: 0, rows_written: 0 } }
  }
  const info = stmt.run(...bound)
  return { results: [], meta: { changes: info.changes, rows_read: 0, rows_written: info.changes } }
}

const runBatch = db.transaction((stmts) => stmts.map(execStatement))

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url || '').startsWith('/health')) {
    res.writeHead(200).end('ok')
    return
  }
  const isQuery =
    req.method === 'POST' && /^\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/.test(req.url || '')
  if (!isQuery) {
    res.writeHead(404).end('not a D1 query endpoint')
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400).end(JSON.stringify({ success: false, errors: [{ message: 'unparsable body' }] }))
      return
    }
    try {
      const result = body.batch ? runBatch(body.batch) : [execStatement(body)]
      res.writeHead(200).end(JSON.stringify({ success: true, result }))
    } catch (e) {
      // A refused statement: the provider's own message is the contract.
      console.error(`[d1-shim] refused: ${e.message}`)
      res.writeHead(400).end(
        JSON.stringify({ success: false, errors: [{ code: 7500, message: e.message }] }),
      )
    }
  })
})

server.listen(port, '127.0.0.1', () =>
  console.log(`d1-shim on http://127.0.0.1:${port} — ${dbPath}`),
)
