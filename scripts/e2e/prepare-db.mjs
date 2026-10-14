#!/usr/bin/env node
/**
 * Builds the E2E database file — a fresh, disposable, prod-LIKE local copy.
 *
 *   1. fresh sqlite from scripts/d1/dump-prod-export-2026-10-12.sql (a complete
 *      post-cutover export: it carries its own DDL, incl. documents.version —
 *      never load schema.sql on top of it),
 *   2. the Phase-2 backfill applied in its own --db local mode (item flags,
 *      storage zones, spoilage_reasons, counters, flags seeded OFF, app_config),
 *   3. the two UI flags the journey needs flipped ON: shell_nav + pipeline.
 *      Everything else stays at the rollback position (OFF), and batch_v2 /
 *      qc_gate_v2 stay OFF per STATE (mass-balance decision open).
 *
 * Real vendor/customer names ride along from the committed dump — no new
 * exposure, but E2E screenshots inherit them (noted in QA_REPORT.md).
 *
 * usage: node scripts/e2e/prepare-db.mjs [--db <file>]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const root = fileURLToPath(new URL('../..', import.meta.url))
const args = process.argv.slice(2)
const dbArg = args.indexOf('--db')
const dbPath = dbArg >= 0 ? args[dbArg + 1] : join(root, 'scripts/e2e/.tmp/e2e.sqlite')

mkdirSync(join(root, 'scripts/e2e/.tmp'), { recursive: true })
rmSync(dbPath, { force: true })
rmSync(`${dbPath}-wal`, { force: true })
rmSync(`${dbPath}-shm`, { force: true })

const db = new Database(dbPath)
db.exec(readFileSync(join(root, 'scripts/d1/dump-prod-export-2026-10-12.sql'), 'utf8'))
const count = (collection) =>
  db.prepare('SELECT COUNT(*) AS n FROM documents WHERE collection = ?').get(collection).n
const before = ['items', 'melanges', 'customers', 'batches', 'stock', 'orders']
console.log(`[prepare-db] dump loaded — ${before.map((c) => `${c}:${count(c)}`).join(' ')}`)

// Phase-2 backfill, local-file mode (insert-only/idempotent by design).
execFileSync(
  'npx',
  ['tsx', 'scripts/overhaul/backfill-phase2.mjs', '--db', dbPath, '--apply'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
console.log('[prepare-db] phase-2 backfill applied')

const flip = db.prepare(
  `UPDATE documents
     SET json = json_set(json, '$.enabled', json('true'))
   WHERE collection = 'flags' AND id IN ('shell_nav', 'pipeline')`,
)
const flipped = flip.run().changes
if (flipped !== 2) throw new Error(`expected 2 flag rows, updated ${flipped}`)

const activeMelanges = db
  .prepare("SELECT id, json_extract(json, '$.name') AS name FROM documents WHERE collection = 'melanges' AND lower(json_extract(json, '$.status')) = 'active'")
  .all()
console.log(`[prepare-db] flags shell_nav+pipeline ON (${flipped} rows); active melanges: ${activeMelanges.map((m) => `${m.id} ${m.name}`).join(', ') || 'NONE — journey needs recipe inserts'}`)

/**
 * The journey's coconut-milk recipe — the ONE piece of reference data the
 * plant's live masters lack (AUDIT: malai goes straight into blends; no milk
 * intermediate exists). Journey A's Section-9 criterion needs milk as its own
 * intermediate lot, so this seeds a live-shaped melange + its bulk item
 * (cribbed from SF-MLG-0001/ABC Melange). Status is the CONTRACT's lowercase
 * 'active' — the post-backfill spelling — which the blend form must accept.
 */
const seedDoc = db.prepare(
  "INSERT INTO documents (collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)",
)
const now = new Date().toISOString()
const e2eSeeds = [
  {
    collection: 'items',
    id: 'SF-MLG-E2E-MILK',
    json: {
      id: 'SF-MLG-E2E-MILK', name: 'Coconut Milk (E2E bulk)', type: 'Semi Finished',
      uom: 'Litre', lotControlled: true, reorder: 0, costMethod: 'Batch Actual',
      procurementForm: 'READY_EXTRACT', requiresGrading: false, requiresExtraction: false,
      storageCondition: 'cold', densityKgPerL: 1,
    },
  },
  {
    collection: 'melanges',
    id: 'MLG-E2E-MILK',
    json: {
      id: 'MLG-E2E-MILK', name: 'Coconut Milk (E2E)', outputItem: 'SF-MLG-E2E-MILK',
      uom: 'Litre', components: [{ item: 'SF-0003', share: 50 }, { item: 'SF-0002', share: 50 }],
      description: 'E2E seed: the Section-9 milk intermediate (malai + water).',
      status: 'active',
    },
  },
]
for (const s of e2eSeeds) {
  seedDoc.run(s.collection, s.id, JSON.stringify(s.json), now)
}
console.log('[prepare-db] E2E seeds: SF-MLG-E2E-MILK item + MLG-E2E-MILK recipe (malai 50 + water 50)')
db.close()
console.log(`[prepare-db] ready — ${dbPath}`)
