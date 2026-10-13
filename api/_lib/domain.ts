/**
 * The B3 domain-endpoint toolkit — the shapes every dedicated endpoint
 * (ARCHITECTURE §5-6) shares: one typed refusal the routes answer as an
 * ApiError, the permission read-outs RBAC.md's matrix spells per endpoint, and
 * the statement builders that keep every write in ONE atomic D1 batch with the
 * revision bump last (the d1Commit contract).
 *
 * Nothing here does I/O: the services fetch their evidence, then compose
 * statements from these builders so the guarded-upsert grammar (observed
 * version + assert) cannot drift between endpoints.
 */
import type { D1Client } from './d1.js'
import { D1ApiError } from './d1.js'
import type { Caller } from './auth.js'
import { bumpStatement } from './d1Commit.js'
import { isAdminPermissions } from '../../src/lib/permissions.js'
import { ledgerToRow } from '../../src/lib/tables.js'
import type { LedgerEntry } from '../../src/types.js'

/**
 * A refusal the route answers with its own status and ApiError body —
 * contracts §5: prose `error`, stable `code` the UI branches on, field-level
 * `details` for body validation.
 */
export class DomainError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: Record<string, string>
  constructor(status: number, error: string, code?: string, details?: Record<string, string>) {
    super(error)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The guards SQLite's named CHECK self-identifies by (d1Commit's 409 story). */
const ASSERT_TRIP_RE = /_assert_changed/i

/** True when a refused write batch is the CAS story — a guarded row moved. */
export function isCasTrip(e: unknown): e is D1ApiError {
  return e instanceof D1ApiError && ASSERT_TRIP_RE.test(e.message)
}

// ── RBAC read-outs (RBAC.md §b-§c) ──────────────────────────────────────────

/**
 * An action slug (`can.<action>`). `sessionPermissions` grants admins the page
 * catalog only — action slugs must be held explicitly — so admin-ness is read
 * separately: the full catalog in hand IS the admin (isAdminPermissions).
 */
export function holdsAction(held: readonly string[], slug: string): boolean {
  return held.includes(slug) || isAdminPermissions(held)
}

/** A page slug: held explicitly, or the admin's whole-catalog grant. */
export function holdsPage(held: readonly string[], slug: string): boolean {
  return held.includes(slug) || isAdminPermissions(held)
}

/** The page slugs RBAC.md's close matrix names as the owning pages. */
export const CLOSE_OWN_PAGES = ['page.production', 'page.packing'] as const

/** can.close_run AND an owning page (production|packing) — RBAC.md §c. */
export function mayCloseRun(held: readonly string[]): boolean {
  return holdsAction(held, 'can.close_run') && CLOSE_OWN_PAGES.some((p) => holdsPage(held, p))
}

/**
 * The delivery agent: RBAC.md §(a) — `page.my-deliveries` ONLY. The slug is
 * not in PAGE_CATALOG, so pageScope cannot see it; the string test is the
 * honest read. Any other page in hand means the caller is more than an agent.
 * Search and genealogy answer every other signed-in caller.
 */
export function isDeliveryAgent(held: readonly string[]): boolean {
  return held.includes('page.my-deliveries') && held.every((p) => p === 'page.my-deliveries' || p.startsWith('can.'))
}

// ── statement builders — every write batch shares d1Commit's grammar ────────

export type Stmt = { sql: string; params?: unknown[] }

const SQL_DELETE_ASSERT_HEAD = 'DELETE FROM _assert_changed'
const SQL_ASSERT = 'INSERT INTO _assert_changed VALUES (changes())'
const SQL_UPSERT_GUARDED = `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at
  WHERE documents.version = ?`
const SQL_INSERT_ONCE = `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(collection, id) DO NOTHING`
const SQL_UPSERT_COUNTER_FORWARD = `INSERT INTO counters(series, next) VALUES (?, ?)
  ON CONFLICT(series) DO UPDATE SET next = excluded.next WHERE excluded.next > counters.next`

/** The batch's opening statement — clears the assert trip-wire (d1Commit). */
export function assertHead(): Stmt {
  return { sql: SQL_DELETE_ASSERT_HEAD }
}

/** A guarded collection/document upsert. `observed` 0 = expected absent. */
export function upsertDoc(collection: string, id: string, doc: unknown, observed: number, now: string): Stmt[] {
  return [
    { sql: SQL_UPSERT_GUARDED, params: [collection, id, JSON.stringify(doc), observed + 1, now, observed] },
    { sql: SQL_ASSERT },
  ]
}

/** An insert-only row (audit, spoilage record, idempotency receipt). */
export function insertOnce(collection: string, id: string, doc: unknown, now: string): Stmt {
  return { sql: SQL_INSERT_ONCE, params: [collection, id, JSON.stringify(doc), now] }
}

/** A ledger line — the flat wire row (ledgerToRow), a fresh document id. */
export function ledgerStmt(line: Omit<LedgerEntry, 'id'> & { id?: string }, now: string): Stmt {
  const withId = line.id ? (line as LedgerEntry) : { ...line, id: `LED-${now}-${Math.random().toString(36).slice(2, 10)}` }
  return insertOnce('ledger', withId.id, ledgerToRow(withId), now)
}

/** The forward-only counter belt — a stale write is silently refused (D1 heals). */
export function counterStmt(series: string, next: number): Stmt {
  return { sql: SQL_UPSERT_COUNTER_FORWARD, params: [series, next] }
}

/** An audits row in the writeAdminAuditD1 shape. */
export function auditStmt(row: { id: string; at: string; actor: string; action: string; doc: string; details: string }): Stmt {
  return insertOnce('audits', row.id, row, row.at)
}

/** A deterministic audit id — the second close can never collide (CAS first). */
export function auditId(action: string, doc: string, at: string): string {
  return `AUD-${action}-${doc}-${at.replace(/[^0-9]/g, '')}`
}

/** The revision bump, LAST, plus the statement that reads its token back. */
export function revisionBump(): Stmt[] {
  const bump = bumpStatement()
  return [{ sql: bump.sql, params: bump.params }]
}

// ── the numbering/grn helpers, api-side ─────────────────────────────────────
//
// src/lib/{numbering,grn,stockIds}.ts are not api-compilable (their internal
// imports are extensionless; the rules module's own note explains the seam), so
// the endpoints carry the same arithmetic inline — small, self-contained, and
// documented in the B3 handoff so a divergence would be found, not inherited.

/** The built-in shapes the dispatch and challan series carry (numbering.ts). */
const SERIES_DEFAULTS: Record<string, { prefix: string; pattern: string; pad: number }> = {
  dispatch: { prefix: 'DSP', pattern: '{P}-{YYYY}-{N}', pad: 4 },
  challan: { prefix: 'DC', pattern: '{P}{N}/{YYYY}', pad: 4 },
}

/** The stored rule shape off meta.app_config.numbering (numbering.ts ruleFor). */
export interface StoredNumbering {
  prefix?: string
  pattern?: string
  pad?: number
}

/**
 * A series' document number — the saved rule over the built-in shape, formatted
 * with numbering.ts's token grammar ({P},{N},{YYYY},{YY},{YYYYMMDD},{MM},{DD}).
 */
export function formatSeries(
  saved: readonly StoredNumbering[] | undefined,
  series: string,
  n: number,
  when = new Date(),
): string {
  const base = SERIES_DEFAULTS[series] ?? { prefix: series.toUpperCase(), pattern: '{P}-{N}', pad: 4 }
  const rule = saved?.find((r) => (r as { key?: unknown }).key === series)
  const prefix = String(rule?.prefix ?? '').trim() || base.prefix
  const pattern = String(rule?.pattern ?? '').trim() || base.pattern
  const pad = Number(rule?.pad) > 0 ? Math.min(9, Math.round(Number(rule?.pad))) : base.pad
  const y = when.getUTCFullYear()
  const tokens: Record<string, string> = {
    P: prefix,
    PREFIX: prefix,
    N: String(Math.max(1, Math.round(n))).padStart(pad, '0'),
    NUM: String(Math.max(1, Math.round(n))).padStart(pad, '0'),
    YYYY: String(y),
    YY: String(y).slice(-2),
    YYYYMMDD: `${y}${String(when.getUTCMonth() + 1).padStart(2, '0')}${String(when.getUTCDate()).padStart(2, '0')}`,
    MM: String(when.getUTCMonth() + 1).padStart(2, '0'),
    DD: String(when.getUTCDate()).padStart(2, '0'),
  }
  return pattern.replace(/\{([A-Za-z]+)\}/g, (_, t: string) => tokens[t.toUpperCase()] ?? t)
}

/** A batch output's stock id — stockIds.ts stockIdFor. */
export const stockIdFor = (doc: string, n: number): string => `${doc}/${n}`

/** Produce counted by the piece (the graded intake) — grn.ts gradedUnit. */
export const isGradedUnit = (uom?: string): boolean => (uom || 'Piece').trim().toLowerCase() === 'piece'

/** grn.ts priceGrn's grade arithmetic, minus the form validations the endpoint
 *  re-checks itself — the staged receipt already answered those at the gate. */
export function gradeMath(input: {
  total: number
  free: number
  a: number
  b: number
  c: number
  reject: number
  rate: number
  transport: number
}): { accepted: number; material: number; landed: number; grossCost: number; usableCost: number } {
  const accepted = input.a + input.b + input.c
  const material = (input.total - input.free) * input.rate
  const landed = material + input.transport
  return {
    accepted,
    material,
    landed,
    grossCost: landed / input.total,
    usableCost: landed / accepted,
  }
}

// ── read helpers ─────────────────────────────────────────────────────────────

/** A parse-or-null document read — unparsable rows read as absent, never fatal. */
export function parseDoc<T>(json: unknown): T | null {
  try {
    const doc = JSON.parse(typeof json === 'string' ? json : '') as T
    return doc && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

/** One collection's documents, parsed; the endpoint reads only what it names. */
export async function readDocs<T>(d1: D1Client, collection: string): Promise<T[]> {
  const rows = await d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = ?`, [collection])
  const out: T[] = []
  for (const r of rows) {
    const doc = parseDoc<T>(r.json)
    if (doc) out.push(doc)
  }
  return out
}

/** meta as a setting → value map (app_config, periods). */
export async function readMeta(d1: D1Client): Promise<Map<string, string>> {
  const rows = await d1.query<{ setting?: unknown; value?: unknown }>('SELECT setting, value FROM meta')
  const out = new Map<string, string>()
  for (const r of rows) {
    const setting = String(r.setting ?? '')
    if (setting) out.set(setting, String(r.value ?? ''))
  }
  return out
}

/** The counters table as series → next. */
export async function readCounters(d1: D1Client): Promise<Map<string, number>> {
  const rows = await d1.query<{ series?: unknown; next?: unknown }>('SELECT series, next FROM counters')
  const out = new Map<string, number>()
  for (const r of rows) {
    const series = String(r.series ?? '')
    if (series) out.set(series, Number(r.next) || 0)
  }
  return out
}

/** The app_config object off meta, parsed — null when absent/unparsable. */
export function appConfigOf(meta: Map<string, string>): Record<string, unknown> | null {
  return parseDoc<Record<string, unknown>>(meta.get('app_config'))
}

/** One POST's write batch, in the engine's order: head, writes, bump last. */
export async function writeBatch(
  d1: D1Client,
  writes: Stmt[],
): Promise<string> {
  const stmts = [assertHead(), ...writes, ...revisionBump()]
  const out = await d1.batch<{ value?: unknown }>(stmts)
  const token = out[out.length - 1].results[0]?.value
  if (typeof token !== 'string' || !token) {
    throw new DomainError(500, 'The revision bump returned no token — the write was refused whole.')
  }
  return token
}

/** The caller as the audits row's actor — email, never a secret. */
export function actorOf(caller: Caller): string {
  return caller.email
}

/** The routes' one error ladder — ApiError shapes, secrets never in a body. */
export function errorBody(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof DomainError) {
    return {
      status: e.status,
      body: { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.details ? { details: e.details } : {}) },
    }
  }
  console.error('[b3]', e)
  return { status: 500, body: { error: 'The server could not complete this — nothing was written.' } }
}
