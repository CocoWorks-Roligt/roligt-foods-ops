/**
 * The D1 write engine — the Zoho commit's semantics, one preflight read batch
 * and one atomic write batch.
 *
 * Every verdict a commit renders is engine-neutral (commitGates.ts — the same
 * file the Zoho engine imports, so the two cannot drift): the permission
 * ladder, the config per-key diff, the counter jump ceiling, the expect
 * preflight. This arm supplies only what a verdict needs as evidence — one
 * batch reading meta, the counters and every touched row — and then what the
 * Zoho engine spent a dozen conditional writes on: ONE batch, atomic (pinned
 * by the Phase-0 probe), where a missed guard refuses the whole commit before
 * any of its sibling statements survive.
 *
 * The guard is the row's integer version. Zoho's CAS wrote a "<id>:<n>" token
 * through a version column; on D1 the integer IS the token's n, observed at
 * preflight (0 = expected absent — a version column never holds 0, so a rival
 * insert at 1 cannot slip past the guard) and asked of SQLite as the upsert's
 * conflict condition. The write itself is followed by
 * `INSERT INTO _assert_changed VALUES (changes())` — the CHECK table that
 * turns a silent no-op (changes() = 0: the guard missed) into a batch-wide
 * rollback, which this engine hands back as the same 409 the preflight
 * produces. Per-table fidelity with the Zoho engine:
 *
 *   collections + ledger — guarded upsert + assert (Zoho stamped and
 *     CAS-guarded every row through versionPlan; ledger is NOT special there);
 *   audits — INSERT … ON CONFLICT DO NOTHING, never asserted (Zoho's
 *     insert-only skip makes an existing id a no-op; an in-window duplicate is
 *     swallowed the same way, and history is never rewritten);
 *   removes — a plain DELETE by key, never asserted (Zoho's deleteRecord never
 *     consulted the version; a row a rival already removed IS the outcome the
 *     caller asked for);
 *   counters — no assert either: the forward-only belt
 *     (`WHERE excluded.next > counters.next`) refuses a stale write against a
 *     rival's later landing silently, where the Zoho engine would have
 *     REWOUND the number. The refusal self-heals on the caller's next poll.
 *
 * The revision bump is the batch's LAST statement, in SQL:
 * `CAST(CAST(value AS INTEGER) + 1 AS TEXT) || ':' || <nonce>` — strictly
 * monotonic under D1's single-writer serialization, where the Zoho engine had
 * to read-modify-write across instances. Nothing landed (the idempotent
 * retry of one's own writes, every row jsonEq-skipped) never batches at all
 * and answers with the unchanged token, no bump — the contract the offline
 * client's queue drains depend on.
 */
import { D1ApiError, type D1Client } from './d1.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import { COLLECTIONS } from '../../src/lib/tables.js'
import type { CommitResult } from './commit.js'
import { noteD1Revision } from './d1Snapshot.js'
import {
  Conflict,
  detectRowConflicts,
  expectedPeriodOf,
  gateAuditRemove,
  gateAuditRide,
  gateConfigKeys,
  gateCounterJumps,
  gateTablePermissions,
  jsonEq,
  provenanceDetails,
  type RowConflict,
} from './commitGates.js'

/** The batch's per-statement rows, loosely typed — each SELECT fills its own columns. */
interface PreflightRow {
  setting?: unknown
  value?: unknown
  series?: unknown
  next?: unknown
  id?: unknown
  json?: unknown
  version?: unknown
}

interface StoredRow {
  json: string
  version: number
}

// One write statement per shape the engine needs — the guarded upsert's WHERE
// is the CAS: the conflict arm runs only against the version the preflight
// observed, so a row that moved in the window matches nothing and leaves
// changes() at zero for the assert to refuse.
const SQL_DELETE_ASSERT_HEAD = 'DELETE FROM _assert_changed'
const SQL_ASSERT = 'INSERT INTO _assert_changed VALUES (changes())'
const SQL_UPSERT_GUARDED = `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at
  WHERE documents.version = ?`
const SQL_INSERT_AUDIT = `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(collection, id) DO NOTHING`
const SQL_DELETE_ROW = 'DELETE FROM documents WHERE collection = ? AND id = ?'
const SQL_UPSERT_COUNTER_FORWARD = `INSERT INTO counters(series, next) VALUES (?, ?)
  ON CONFLICT(series) DO UPDATE SET next = excluded.next WHERE excluded.next > counters.next`
const SQL_UPSERT_COUNTER_RESET = `INSERT INTO counters(series, next) VALUES (?, ?)
  ON CONFLICT(series) DO UPDATE SET next = excluded.next`
const SQL_UPSERT_META = `INSERT INTO meta(setting, value) VALUES (?, ?)
  ON CONFLICT(setting) DO UPDATE SET value = excluded.value`
// The bump reads its own row's integer, adds one, and re-suffixes a fresh
// nonce — CAST('12:ab3' AS INTEGER) is 12, so any token this engine (or the
// dump import, from Zoho's tokens) ever wrote parses. The schema seeds the
// row ('0'), and the dump imports it, so the UPDATE always has a row.
const SQL_BUMP_REVISION = `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) || ':' || ?
  WHERE setting = 'app_revision' RETURNING value`

/** The revision bump as a ready statement — every D1 write path appends it
 *  last (the commit engine, the admin audit); one home so the token grammar
 *  cannot drift between them. */
export function bumpStatement(): { sql: string; params: unknown[] } {
  return { sql: SQL_BUMP_REVISION, params: [Math.random().toString(36).slice(2, 8)] }
}

export async function commitChangesD1(d1: D1Client, caller: Caller, changes: StateChanges): Promise<CommitResult> {
  // 1. the permission ladder — pure, shared verbatim with the Zoho engine.
  const rides = gateTablePermissions(caller, changes)

  // 2. the preflight — ONE read batch: the stored config (the config gate's
  //    evidence and the period arithmetic's), the counters, and every touched
  //    row whose observed version becomes the write's guard. The Zoho engine
  //    spreads these reads across the gate order; the verdicts below still
  //    fire in ITS order, so a refusal is identical down to the throw.
  const rowStmts: { table: string }[] = []
  const stmts = [
    { sql: 'SELECT setting, value FROM meta' },
    { sql: 'SELECT series, next FROM counters' },
    ...changes.tables.flatMap((change) => {
      const ids = [...change.upsert.map((row) => String(row.id)), ...change.remove.map((id) => String(id))]
      if (!ids.length) return [] // no rows touched — no statement (IN () is not SQL)
      rowStmts.push({ table: change.table })
      return [
        {
          sql: `SELECT id, json, version FROM documents WHERE collection = ? AND id IN (${ids.map(() => '?').join(',')})`,
          params: [change.table, ...ids],
        },
      ]
    }),
  ]
  const preflight = await d1.batch<PreflightRow>(stmts)

  const storedConfig = new Map<string, string>()
  for (const r of preflight[0].results) {
    const setting = String(r.setting ?? '')
    if (setting) storedConfig.set(setting, String(r.value ?? ''))
  }
  const storedNext = new Map<string, number>()
  for (const r of preflight[1].results) {
    const series = String(r.series ?? '')
    if (series) storedNext.set(series, Number(r.next) || 0)
  }
  const existingByTable = new Map<string, Map<string, StoredRow>>()
  for (let i = 0; i < rowStmts.length; i++) {
    // a changes payload may name the same table twice (each entry its own rows —
    // the Zoho engine read per-entry, so the shape is legal); MERGE, never
    // replace, or one entry's statement would erase what another's just read
    let byId = existingByTable.get(rowStmts[i].table)
    if (!byId) {
      byId = new Map<string, StoredRow>()
      existingByTable.set(rowStmts[i].table, byId)
    }
    for (const r of preflight[2 + i].results) {
      byId.set(String(r.id ?? ''), { json: typeof r.json === 'string' ? r.json : '', version: Number(r.version) || 0 })
    }
  }

  // 3. the gates whose evidence just landed — the Zoho engine's exact order.
  const ownsConfigChange = gateConfigKeys(changes, storedConfig, rides.held)
  gateAuditRide(rides, ownsConfigChange)
  gateAuditRemove(changes, rides.held)
  const seriesKeys = Object.keys(changes.counters).filter((k) => !k.startsWith('period:'))
  if (seriesKeys.length) gateCounterJumps(changes.counters, storedNext, rides.admin)

  // 4. the whole-commit refusal — the expect preflight, engine-neutral, fed by
  //    the batch's own rows (a row that fails to parse counts as unparsable,
  //    never as a conflict — the Zoho engine's storedPayload contract).
  const conflicts = detectRowConflicts(changes, (table, id) => {
    const stored = existingByTable.get(table)?.get(id)
    if (!stored) return undefined
    try {
      return JSON.parse(stored.json) as Record<string, unknown>
    } catch {
      return null
    }
  })
  if (conflicts.length) throw new Conflict(conflicts)

  // 5. the write batch. `wrote` carries the Zoho engine's idempotence
  //    contract: a commit whose every write was already exactly what it
  //    carries (jsonEq, row for row) reaches the end false and never batches —
  //    no bump, the unchanged token goes back.
  const writes: { sql: string; params?: unknown[] }[] = [{ sql: SQL_DELETE_ASSERT_HEAD }]
  /** Every guarded upsert, for the Conflict a batch assert-trip synthesizes. */
  const guarded: RowConflict[] = []
  let wrote = false
  const now = new Date().toISOString()

  for (const change of changes.tables) {
    const spec = COLLECTIONS.find((c) => c.table === change.table) ?? null
    const byId = existingByTable.get(change.table) ?? new Map<string, StoredRow>()

    for (const row of change.upsert) {
      const appId = String(row.id)
      const stored = byId.get(appId)
      if (change.table === 'audits' && stored) continue // insert-only: never rewrite an audit row
      const stamped =
        change.table === 'audits' ? { ...row, actor: caller.email, details: provenanceDetails(row, caller.email) } : row
      const incoming = spec ? ((stamped as { data?: Record<string, unknown> }).data ?? {}) : stamped
      // idempotent retry: the row is already exactly this — no write, no bump
      if (stored) {
        try {
          const storedDoc = JSON.parse(stored.json) as unknown
          if (jsonEq(storedDoc, incoming)) continue
        } catch {
          // an unparsable stored row cannot prove identity — the write replaces it
        }
      }
      // the stored document is what the wire carries: the collection's data,
      // the ledger's flat row, the audit's stamped row (the Zoho engine's
      // JSON.stringify choice row for row — the snapshot reads it back through
      // the same fromRow decoders)
      const json = JSON.stringify(incoming)
      const observed = stored?.version ?? 0
      if (change.table === 'audits') {
        writes.push({ sql: SQL_INSERT_AUDIT, params: [change.table, appId, json, now] })
      } else {
        writes.push({ sql: SQL_UPSERT_GUARDED, params: [change.table, appId, json, observed + 1, now, observed] })
        writes.push({ sql: SQL_ASSERT })
        guarded.push({ table: change.table, id: appId, kind: observed === 0 ? 'exists' : 'changed' })
      }
      wrote = true
    }

    for (const id of change.remove) {
      // an id with no row is already gone — the outcome the caller asked for
      if (!byId.get(String(id))) continue
      writes.push({ sql: SQL_DELETE_ROW, params: [change.table, String(id)] })
      wrote = true // the attempt itself, even where a rival's delete already landed it
    }
  }

  // 6. counters — periods in meta, numbers in counters, the Zoho engine's
  //    skip ladder intact (echo, forged/stale period, unchanged, stale
  //    regression), and the one genuine exception — a period reset — writes
  //    its number unconditionally instead of through the forward belt.
  const unlocksReset = (series: string): boolean => {
    const periodKey = `period:${series}`
    const newPeriod = changes.counters[periodKey]
    return (
      newPeriod !== undefined &&
      String(newPeriod) !== (storedConfig.get(periodKey) ?? '') &&
      String(newPeriod) === expectedPeriodOf(storedConfig, series)
    )
  }
  for (const [series, value] of Object.entries(changes.counters)) {
    if (series.startsWith('period:')) {
      const stored = storedConfig.get(series)
      const claimed = String(value)
      if (stored !== undefined && stored === claimed) continue // unchanged — nothing to write
      if (claimed !== expectedPeriodOf(storedConfig, series.slice('period:'.length))) {
        continue // not this series' period: forged, stale, or merely current — write nothing
      }
      writes.push({ sql: SQL_UPSERT_META, params: [series, claimed] })
      wrote = true
      continue
    }
    const incoming = Number(value) || 0
    const stored = storedNext.get(series)
    if (stored !== undefined) {
      if (incoming === stored) continue // unchanged — nothing to write
      if (incoming < stored && !unlocksReset(series)) continue // stale regression: the insert gate and the next sync heal it
    }
    writes.push({ sql: stored !== undefined && incoming < stored ? SQL_UPSERT_COUNTER_RESET : SQL_UPSERT_COUNTER_FORWARD, params: [series, incoming] })
    wrote = true
  }

  // 7. config — written only when a key genuinely moved (the gate's verdict).
  if (changes.config && ownsConfigChange) {
    writes.push({ sql: SQL_UPSERT_META, params: ['app_config', JSON.stringify(changes.config)] })
    wrote = true
  }

  // 8. the idempotent short-circuit — nothing landed, nothing batches.
  if (!wrote) return { token: storedConfig.get('app_revision') ?? '0', wrote: false }

  // 9. the bump, last, then the one round trip. A guard that missed rolls the
  //    whole batch back (the assert's CHECK) and surfaces as the provider's
  //    own constraint error — which this engine answers with the 409 the
  //    preflight would have produced, naming its guarded rows.
  writes.push(bumpStatement())
  let token: string
  try {
    const out = await d1.batch<{ value?: unknown }>(writes)
    const row = out[out.length - 1].results[0]
    token = typeof row?.value === 'string' ? row.value : ''
  } catch (e) {
    if (e instanceof D1ApiError && /_assert_changed/i.test(e.message)) {
      throw new Conflict(guarded)
    }
    throw e
  }
  if (!token) throw new Error('The revision bump returned no token — the commit was refused whole.')
  noteD1Revision(token)
  return { token, wrote: true }
}
