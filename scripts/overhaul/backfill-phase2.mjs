#!/usr/bin/env node
/**
 * Phase 2 backfill — carries the live plant's documents onto the frozen
 * Phase-1 contracts, additively and idempotently (src/lib/backfillPhase2.ts
 * holds every rule; this script only reads, reports and writes):
 *
 *   items              +procurementForm +requiresGrading +requiresExtraction
 *                      +storageCondition +avgUnitWeight (graded) +densityKgPerL (Litre)
 *   batches            outputLines[] +type (MAIN/BY_PRODUCT/INTERMEDIATE), +stageTimes{}
 *   melanges           +recipeId +version +status (normalised lowercase)
 *   customers          +dispatchPackaging 'ASK'
 *   products           +packFormat +bibSize (parsed from SKU names)
 *   storage_locations  +zone (Cold Room→cold_room, Dry→ambient, Hold→quarantine, NPD→ambient)
 *   NEW spoilage_reasons / carton_specs / flags (insert-only, DO NOTHING on conflict)
 *   NEW counters row 'po' (insert-only)
 *   meta.app_config    merge-add the overhaul's configurable parameters
 *
 * ENVIRONMENT SAFETY (STATE.md): refuses to run in ANY mode when
 * D1_DATABASE_ID is roligt-ops-prod (de8175f2-…) — the overhaul never
 * connects to production. Default mode is DRY-RUN: prints per-collection
 * change counts and sample diffs, writes nothing. Token values are never
 * printed.
 *
 * usage:
 *   npx tsx scripts/overhaul/backfill-phase2.mjs                # dry-run vs D1 (env/.env)
 *   npx tsx scripts/overhaul/backfill-phase2.mjs --apply        # apply to D1 (never prod)
 *   npx tsx scripts/overhaul/backfill-phase2.mjs --db <file>    # vs a local SQLite file
 *   npx tsx scripts/overhaul/backfill-phase2.mjs --db <file> --apply
 *
 * The --db mode is the drill: point it at a file loaded from a dump
 * (scripts/d1/dump-*.sql) and rehearse dry-run → apply → dry-run (0 changes)
 * before the LEAD-sanctioned scratch apply:
 *   npx wrangler d1 execute roligt-ops-scratch --local --file scripts/d1/schema.sql --yes
 *   npx wrangler d1 execute roligt-ops-scratch --local --file <dump>.sql --yes   (or a fresh file)
 * Local application in this slice is fine; remote application happens later
 * on LEAD instruction, never from this slice.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  APP_CONFIG_ADDITIONS,
  PO_COUNTER_SEED,
  backfillBatch,
  backfillCustomer,
  backfillItem,
  backfillMelange,
  backfillProduct,
  backfillStorageLocation,
  backfillDefaults,
  cartonSpecSeedRows,
  flagSeedRows,
  mergeAppConfig,
  spoilageReasonSeedRows,
} from '../../src/lib/backfillPhase2.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CW = join(HERE, '..', '..')

// ── target & safety ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const dbFlag = argv.indexOf('--db')
const DB_FILE = dbFlag !== -1 ? argv[dbFlag + 1] : undefined

/** STATE.md: roligt-ops-prod — never execute against it, in any mode. */
const PROD_DATABASE_ID = 'de8175f2-567d-492f-b2f4-63736fb1d402'

if (!DB_FILE) {
  if (existsSync(join(CW, '.env'))) {
    for (const line of readFileSync(join(CW, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}
const { D1_ACCOUNT_ID: ACCOUNT, D1_API_TOKEN: TOKEN, D1_DATABASE_ID: DATABASE } = process.env

if (!DB_FILE && DATABASE === PROD_DATABASE_ID) {
  console.error('[backfill-phase2] REFUSED: D1_DATABASE_ID is roligt-ops-prod — the overhaul never connects to production (STATE.md).')
  console.error('[backfill-phase2] Point .env at roligt-ops-scratch, or drill locally with --db <file>.')
  process.exit(1)
}

/** The two engines this script runs against: D1's REST query endpoint
 *  (views.mjs's plain-fetch client) and a local better-sqlite3 file (the
 *  drill). Both expose query()/batch() so nothing else knows the difference. */
const target = DB_FILE
  ? await localTarget(DB_FILE)
  : remoteTarget()

async function localTarget(file) {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  const hasDocuments = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").get()
  if (!hasDocuments) db.exec(readFileSync(join(CW, 'scripts/d1/schema.sql'), 'utf8'))
  const run = (sql, params) => {
    const stmt = db.prepare(sql)
    return stmt.reader ? { rows: stmt.all(...params), changes: 0 } : { rows: [], changes: stmt.run(...params).changes }
  }
  return {
    label: `local file ${file}`,
    async query(sql, params = []) {
      return run(sql, params).rows
    },
    async batch(stmts) {
      const out = []
      db.transaction(() => {
        for (const s of stmts) {
          const r = run(s.sql, s.params ?? [])
          out.push({ results: r.rows, meta: { changes: r.changes } })
        }
      })()
      return out
    },
  }
}

function remoteTarget() {
  if (!ACCOUNT || !TOKEN || !DATABASE) {
    console.error('[backfill-phase2] D1_ACCOUNT_ID / D1_API_TOKEN / D1_DATABASE_ID are required (env or .env), or pass --db <file>.')
    process.exit(1)
  }
  const url = `${process.env.D1_API_BASE || 'https://api.cloudflare.com'}/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`
  const post = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!json?.success) {
      throw new Error(`query refused (HTTP ${res.status}): ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`)
    }
    return json.result
  }
  return {
    label: `D1 database ${DATABASE}`,
    async query(sql, params = []) {
      return (await post({ sql, params }))[0].results ?? []
    },
    async batch(stmts) {
      if (stmts.length === 0) return []
      return (await post({ batch: stmts.map((s) => ({ sql: s.sql, params: s.params ?? [] })) })).map((r) => ({
        results: r.results ?? [],
        meta: { changes: r.meta?.changes ?? 0 },
      }))
    },
  }
}

// ── read ─────────────────────────────────────────────────────────────────────
const MERGE_COLLECTIONS = ['items', 'batches', 'melanges', 'customers', 'products', 'storage_locations']
const TRANSFORMS = {
  items: backfillItem,
  batches: backfillBatch,
  melanges: backfillMelange,
  customers: backfillCustomer,
  products: backfillProduct,
  storage_locations: backfillStorageLocation,
}

const rowsByCollection = {}
for (const collection of MERGE_COLLECTIONS) {
  rowsByCollection[collection] = await target.query(
    'SELECT id, json, version FROM documents WHERE collection = ? ORDER BY id',
    [collection],
  )
}
const [configRow] = await target.query("SELECT value FROM meta WHERE setting = 'app_config'")
const existingSeeds = await target.query(
  "SELECT collection, id FROM documents WHERE collection IN ('spoilage_reasons', 'carton_specs', 'flags')",
)
const [poCounter] = await target.query("SELECT next FROM counters WHERE series = 'po'")

// ── plan (pure; the same transforms the unit tests pin) ─────────────────────
const storedConfig = configRow?.value ? JSON.parse(configRow.value) : null
const mergedConfig = mergeAppConfig(storedConfig)
const defaults = backfillDefaults(mergedConfig)

const plans = MERGE_COLLECTIONS.map((collection) => {
  const transform = TRANSFORMS[collection]
  const changed = []
  for (const row of rowsByCollection[collection]) {
    const before = JSON.parse(row.json)
    const after = transform(before, defaults)
    if (after !== before) changed.push({ id: row.id, version: row.version, before, after })
  }
  return { collection, total: rowsByCollection[collection].length, changed }
})

const heldSeeds = new Set(existingSeeds.map((r) => `${r.collection}:${r.id}`))
const seedPlans = [
  { collection: 'spoilage_reasons', rows: spoilageReasonSeedRows() },
  { collection: 'carton_specs', rows: cartonSpecSeedRows() },
  { collection: 'flags', rows: flagSeedRows(new Date().toISOString()) },
].map((p) => ({ ...p, changed: p.rows.filter((r) => !heldSeeds.has(`${p.collection}:${r.id}`)) }))

const configChanged = mergedConfig !== storedConfig
const counterNeeded = poCounter === undefined

// ── report (dry-run output; also printed before an apply) ───────────────────
const addedKeys = (before, after) => Object.keys(after).filter((k) => !(k in before))
const fmt = (v) => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 48 ? `${s.slice(0, 45)}…` : s
}

console.log(`[backfill-phase2] target: ${target.label} — ${APPLY ? 'APPLY' : 'DRY-RUN (writes nothing; pass --apply to apply)'}`)
let work = 0
for (const plan of plans) {
  if (plan.changed.length === 0) {
    console.log(`${plan.collection}: ${plan.total} docs, no change`)
    continue
  }
  work += plan.changed.length
  const keyTally = {}
  for (const c of plan.changed) {
    for (const k of addedKeys(c.before, c.after)) keyTally[k] = (keyTally[k] ?? 0) + 1
    if (plan.collection === 'batches') {
      const typed = (c.before.outputLines ?? []).filter((l) => l.type === undefined).length
      if (typed > 0) keyTally['outputLines[].type'] = (keyTally['outputLines[].type'] ?? 0) + typed
    }
    // the melange status normalisation is a value change, not a new key —
    // tally it separately so the report doesn't under-count the change
    if (plan.collection === 'melanges' && c.before.status !== c.after.status) {
      keyTally['status~'] = (keyTally['status~'] ?? 0) + 1
    }
  }
  const tally = Object.entries(keyTally)
    .map(([k, n]) => `+${k} ×${n}`)
    .join(', ')
  console.log(`${plan.collection}: ${plan.total} docs, ${plan.changed.length} to change (${tally})`)
  for (const c of plan.changed.slice(0, 3)) {
    const adds = addedKeys(c.before, c.after).map((k) => `+${k}=${fmt(c.after[k])}`).join(' ')
    const lineTyping =
      plan.collection === 'batches' && Array.isArray(c.before.outputLines)
        ? ` outputLines[].type=${(c.after.outputLines ?? []).map((l) => l.type).join('/')}`
        : ''
    console.log(`  ${c.id}: ${adds}${lineTyping}`)
  }
  if (plan.changed.length > 3) console.log(`  … and ${plan.changed.length - 3} more`)
}
for (const plan of seedPlans) {
  if (plan.changed.length === 0) {
    console.log(`${plan.collection}: ${plan.rows.length} seed rows, all present`)
    continue
  }
  work += plan.changed.length
  console.log(
    `${plan.collection}: insert ${plan.changed.length} of ${plan.rows.length} seed rows (${plan.rows.length - plan.changed.length} already present) — ${plan.changed.map((r) => r.id).join(', ')}`,
  )
}
if (configChanged) {
  work += 1
  const adding = Object.entries(APP_CONFIG_ADDITIONS)
    .filter(([k]) => !(k in (storedConfig ?? {})))
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(', ')
  console.log(`meta.app_config: merge-add ${adding}`)
} else {
  console.log('meta.app_config: all keys present, no change')
}
if (counterNeeded) {
  work += 1
  console.log(`counters: insert series '${PO_COUNTER_SEED.series}' at next=${PO_COUNTER_SEED.next}`)
} else {
  console.log(`counters: series '${PO_COUNTER_SEED.series}' present at next=${poCounter.next}, no change`)
}
if (work === 0) console.log('[backfill-phase2] nothing to do — database already carries the Phase-2 keys')

// ── apply — one atomic batch, with the audit trail and the poll bump ────────
if (APPLY) {
  if (work === 0) {
    console.log('[backfill-phase2] --apply with nothing to do: no writes, no revision bump.')
  } else {
    const now = new Date().toISOString()
    const stmts = []
    for (const plan of plans) {
      for (const c of plan.changed) {
        stmts.push({
          sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at`,
          params: [plan.collection, c.id, JSON.stringify(c.after), c.version + 1, now],
        })
      }
    }
    for (const plan of seedPlans) {
      for (const r of plan.changed) {
        stmts.push({
          sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(collection, id) DO NOTHING`,
          params: [plan.collection, r.id, JSON.stringify(r.doc), now],
        })
      }
    }
    if (configChanged) {
      stmts.push({
        sql: `INSERT INTO meta(setting, value) VALUES ('app_config', ?)
          ON CONFLICT(setting) DO UPDATE SET value = excluded.value`,
        params: [JSON.stringify(mergedConfig)],
      })
    }
    if (counterNeeded) {
      stmts.push({
        sql: 'INSERT INTO counters(series, next) VALUES (?, ?) ON CONFLICT(series) DO NOTHING',
        params: [PO_COUNTER_SEED.series, PO_COUNTER_SEED.next],
      })
    }
    // one audit row for the whole run (§6: config edits and state changes are
    // audited) + the revision bump that makes every client re-snapshot —
    // the same last-statement contract the commit engine keeps.
    const audit = {
      id: `AUD-backfill-phase2-${now}`,
      at: now,
      actor: 'system',
      action: 'backfill',
      doc: 'phase2',
      details: `Phase-2 additive backfill: ${plans
        .map((p) => `${p.collection} ${p.changed.length}/${p.total}`)
        .join('; ')}; seeds ${seedPlans.map((p) => `${p.collection} +${p.changed.length}`).join(' ')}; app_config ${configChanged ? 'merged' : 'unchanged'}`,
    }
    stmts.push({
      sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('audits', ?, ?, 1, ?)
        ON CONFLICT(collection, id) DO NOTHING`,
      params: [audit.id, JSON.stringify(audit), now],
    })
    stmts.push({
      sql: `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) || ':' || ?
        WHERE setting = 'app_revision' RETURNING value`,
      params: [Math.random().toString(36).slice(2, 8)],
    })

    const out = await target.batch(stmts)
    const token = out[out.length - 1].results[0]?.value
    console.log(`[backfill-phase2] applied ${stmts.length} statements atomically; revision ${token}`)
    console.log(`[backfill-phase2] audit: ${audit.id}`)
  }
}
