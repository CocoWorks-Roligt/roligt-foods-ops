/**
 * The B4 KPI service — GET /api/kpis/:module's whole verdict (ARCHITECTURE
 * §6). Folds live isomorphically in src/lib/kpis/ and are pure over documents;
 * this side owns everything store-shaped: the RBAC gate (RBAC.md §c — the
 * module's page slug, delivery agents excluded outright), the page-based read
 * withholding (a collection the caller's snapshot withholds is folded without,
 * exactly as search skips it), the revision-keyed per-process memo, and the
 * meta cache (`kpi:<module>`, computed_at + TTL) heavy folds are served from.
 *
 * The meta cache never bumps app_revision — it is a cache, not a document
 * write — so caching cannot churn other readers' memos.
 */
import type { Caller } from './auth.js'
import { DomainError, isDeliveryAgent } from './domain.js'
import { readCollection } from './traceSearch.js'
import { withheldForCaller } from './snapshot.js'
import {
  DEFAULT_STALE_AFTER_SEC,
  KPI_SPECS,
  parseKpiWindow,
  wireCollectionOf,
} from '../../src/lib/kpis/index.ts'
import { canViewPage } from '../../src/lib/pages.ts'
import type {
  Freshness,
  KpiCard,
  KpiChart,
  KpiModule,
  KpiModuleResponse,
} from '../../src/lib/contracts.js'
import type { AppState } from '../../src/types.ts'

/** Served shape before the freshness stamp is computed — what memo and cache
 *  hold, keyed by module+window+revision. */
interface KpiPayloadRow {
  last_updated: string
  cards: KpiCard[]
  charts: KpiChart[]
}

interface MemoEntry {
  revision: string
  payload: KpiPayloadRow
}

/** module → last (revision, payload). Per process; revision is global, so any
 *  write anywhere invalidates — coarse, and exactly right while folds are
 *  cheap. Keyed by `${module}|${from}|${to}`. */
const MEMO = new Map<string, MemoEntry>()

const readRevision = (d1: KpiStore): Promise<string> =>
  d1
    .query<{ value: string }>(`SELECT value FROM meta WHERE setting = 'app_revision'`)
    .then((rows) => rows[0]?.value ?? '0')

/** What the service reads through — everything D1Client is on these two
 *  methods, so the tests' in-memory fake is the same shape. */
export interface KpiStore {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  batch(stmts: { sql: string; params?: unknown[] }[]): Promise<unknown[]>
}

/** Test seam: drop the per-process memo so a cache read is exercised cold. */
export function resetKpiMemo(): void {
  MEMO.clear()
}

const readStaleAfter = async (d1: KpiStore): Promise<number> => {
  const rows = await d1.query<{ value: string }>(`SELECT value FROM meta WHERE setting = 'app_config'`)
  try {
    const config = JSON.parse(rows[0]?.value ?? '{}') as { kpiStaleAfterSec?: number }
    return typeof config.kpiStaleAfterSec === 'number' && config.kpiStaleAfterSec > 0
      ? config.kpiStaleAfterSec
      : DEFAULT_STALE_AFTER_SEC
  } catch {
    return DEFAULT_STALE_AFTER_SEC
  }
}

/** The serving stamp: `stale` is this read's verdict, never cached — the
 *  badge cannot disagree with the data it names. */
function stamped(
  module: KpiModule,
  payload: KpiPayloadRow,
  staleAfterSec: number,
): KpiModuleResponse {
  const ageSec = payload.last_updated ? (Date.now() - Date.parse(payload.last_updated)) / 1000 : Infinity
  const freshness: Freshness = {
    last_updated: payload.last_updated,
    stale_after: staleAfterSec,
    stale: ageSec > staleAfterSec,
  }
  return { module, ...freshness, cards: payload.cards, charts: payload.charts }
}

// ── the meta cache (heavy folds only — KPI.md's cached refresh marks) ───────

interface CacheRow {
  revision: string
  from: string
  to: string
  computed_at: string
  payload: KpiPayloadRow
}

const cacheKeyOf = (module: KpiModule) => `kpi:${module}`

async function readCache(
  d1: KpiStore,
  module: KpiModule,
): Promise<CacheRow | null> {
  const rows = await d1.query<{ value: string }>(`SELECT value FROM meta WHERE setting = ?`, [
    cacheKeyOf(module),
  ])
  if (!rows[0]?.value) return null
  try {
    const row = JSON.parse(rows[0].value) as CacheRow
    return row.payload && typeof row.revision === 'string' ? row : null
  } catch {
    return null
  }
}

/** Best-effort — a cache write that fails serves the computed answer anyway. */
async function writeCache(d1: KpiStore, module: KpiModule, row: CacheRow): Promise<void> {
  try {
    await d1.batch([
      {
        sql: `INSERT INTO meta(setting, value) VALUES(?, ?) ON CONFLICT(setting) DO UPDATE SET value = excluded.value`,
        params: [cacheKeyOf(module), JSON.stringify(row)],
      },
    ])
  } catch {
    // a cache is an optimization; the fold's answer is already in hand
  }
}

const cacheFresh = (row: CacheRow, revision: string, from: string, to: string, ttlSec: number): boolean =>
  row.revision === revision &&
  row.from === from &&
  row.to === to &&
  Date.now() - Date.parse(row.computed_at) < ttlSec * 1000

// ── the fold ────────────────────────────────────────────────────────────────

/** The module's documents, minus what the caller's page-based read withholding
 *  drops — the same collections /api/snapshot projects. Shared with the export
 *  engine (api/_lib/exports.ts), so a withheld collection is withheld from
 *  every fold, not just the KPI one. */
export async function readModuleState(
  d1: KpiStore,
  caller: Caller,
  collections: readonly string[],
): Promise<{ state: Partial<AppState>; read: string[] }> {
  const withheld = new Set(withheldForCaller(caller.permissions))
  const state: Partial<AppState> = {}
  const read: string[] = []
  await Promise.all(
    collections.map(async (key) => {
      if (withheld.has(key)) return
      const wire = wireCollectionOf(key)
      state[key as keyof AppState] = (await readCollection<unknown>(d1, wire)) as never
      read.push(wire)
    }),
  )
  return { state, read }
}

/** max(documents.updated_at) over the collections actually folded — the
 *  payload's last_updated, recomputed only per revision. */
export async function readLastUpdated(d1: KpiStore, wire: readonly string[]): Promise<string> {
  if (!wire.length) return ''
  const rows = await d1.query<{ m: string | null }>(
    `SELECT MAX(updated_at) AS m FROM documents WHERE collection IN (${wire.map(() => '?').join(',')})`,
    [...wire],
  )
  return rows[0]?.m ?? ''
}

// ── the verdict ─────────────────────────────────────────────────────────────

export async function kpisFor(
  d1: KpiStore,
  caller: Caller,
  module: string,
  q: Record<string, unknown>,
): Promise<KpiModuleResponse> {
  if (!(module in KPI_SPECS)) {
    throw new DomainError(404, `No such KPI module: ${module}.`, 'invalid_module')
  }
  const spec = KPI_SPECS[module as KpiModule]
  if (isDeliveryAgent(caller.permissions)) {
    throw new DomainError(403, 'KPIs are not part of the delivery app.', 'role_allowed')
  }
  if (!spec.pages.some((p) => canViewPage(caller.permissions, p))) {
    throw new DomainError(403, 'Your role does not read this module.', 'role_allowed')
  }

  const { from, to } = parseKpiWindow(q)
  const [revision, staleAfterSec] = await Promise.all([readRevision(d1), readStaleAfter(d1)])
  const memoKey = `${module}|${from}|${to}`

  const memo = MEMO.get(memoKey)
  if (memo && memo.revision === revision) {
    return stamped(module as KpiModule, memo.payload, staleAfterSec)
  }

  if (spec.cacheTtlSec) {
    const cached = await readCache(d1, module as KpiModule)
    if (cached && cacheFresh(cached, revision, from, to, spec.cacheTtlSec)) {
      MEMO.set(memoKey, { revision, payload: cached.payload })
      return stamped(module as KpiModule, cached.payload, staleAfterSec)
    }
  }

  // No fold yet (Phase 5 builds the module): the honest answer is empty, and
  // the SHELL renders its empty state — never invented numbers.
  const { state, read } = await readModuleState(d1, caller, spec.collections)
  const today = new Date().toISOString().slice(0, 10)
  const folded = spec.fold
    ? spec.fold(state, { from, to }, today)
    : { cards: [], charts: [] }
  const payload: KpiPayloadRow = {
    last_updated: await readLastUpdated(d1, read),
    cards: folded.cards,
    charts: folded.charts,
  }

  MEMO.set(memoKey, { revision, payload })
  if (spec.cacheTtlSec) {
    await writeCache(d1, module as KpiModule, {
      revision,
      from,
      to,
      computed_at: new Date().toISOString(),
      payload,
    })
  }
  return stamped(module as KpiModule, payload, staleAfterSec)
}
