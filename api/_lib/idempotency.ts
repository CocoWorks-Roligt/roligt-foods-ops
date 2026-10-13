/**
 * The Idempotency-Key helper — contracts §5's blanket rule: every POST the
 * overhaul adds requires an `Idempotency-Key` header, and a retry carrying the
 * same key and the same body is answered with the STORED response (header
 * `Idempotency-Replayed: true`), so a flaky delivery-agent connection cannot
 * post a delivery or burn a challan number twice.
 *
 * The receipt is a document in the `idempotency` collection (server-only, never
 * a changeset table): id `sha256(route + key)` — the lookup key — carrying the
 * hash of key + canonical body, the response snapshot and its created_at. One
 * row per (route, key); a SAME key with a DIFFERENT body is refused 422
 * (`idempotency_key`) rather than replayed — the caller is not retrying, they
 * are reusing the key. Receipts live 48h and are swept lazily: every write
 * batch carries the DELETE of rows past the horizon, so no cron and no
 * unbounded growth.
 *
 * The receipt is written in the SAME atomic batch as the effect it records —
 * the response snapshot can never exist without the writes it answers for, and
 * a crash between the two cannot leave a gap a retry would fall through.
 */
import { createHash } from 'node:crypto'
import type { D1Client } from './d1.js'
import { canonicalJson } from './commitGates.js'
import { DomainError, type Stmt } from './domain.js'

/** How long a receipt is replayed for (§6 standards). */
export const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000

const SQL_DELETE_EXPIRED =
  "DELETE FROM documents WHERE collection = 'idempotency' AND json_extract(json, '$.expires_at') < ?"

/** sha256 hex of the key material — ids and body hashes alike. */
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** The receipt document — one per (route, key). */
export interface IdempotencyReceipt {
  id: string
  route: string
  /** The caller's key, verbatim — audit and diagnosis only. */
  key: string
  /** sha256(key + canonical body) — what a replay must match. */
  bodyHash: string
  status: number
  /** The stored response body, exactly as first answered. */
  response: unknown
  created_at: string
  expires_at: string
}

/** The header every POST must carry — missing means 422 (contracts §5). */
export function requireIdempotencyKey(headers: Record<string, unknown>): string {
  const raw = headers['idempotency-key']
  const key = Array.isArray(raw) ? String(raw[0]) : typeof raw === 'string' ? raw : ''
  if (!key.trim()) {
    throw new DomainError(422, 'An Idempotency-Key header is required on this request.', 'idempotency_key')
  }
  return key.trim()
}

/** hash(key + canonical body) — the replay verdict's other half. */
export function bodyHashOf(key: string, route: string, body: unknown): string {
  return sha256(`${key}\n${route}\n${canonicalJson(body ?? {})}`)
}

/** A stored receipt that is still live, or null — expired rows read as absent. */
export async function findReceipt(
  d1: D1Client,
  route: string,
  key: string,
): Promise<IdempotencyReceipt | null> {
  const id = sha256(`${route}\n${key}`)
  const rows = await d1.query<{ json: unknown }>(
    `SELECT json FROM documents WHERE collection = 'idempotency' AND id = ?`,
    [id],
  )
  if (!rows.length) return null
  try {
    const receipt = JSON.parse(String(rows[0].json)) as IdempotencyReceipt
    if (!receipt || typeof receipt.bodyHash !== 'string') return null
    return Date.parse(receipt.expires_at) > Date.now() ? receipt : null
  } catch {
    return null // a hand-staged row is not a receipt — proceed fresh
  }
}

/** What a found receipt means for this request. */
export interface Replay<T> {
  replay: boolean
  status: number
  body: T
}

/** Replay the stored response, or refuse a reused key whose body changed. */
export function replayOf<T>(receipt: IdempotencyReceipt, bodyHash: string): Replay<T> {
  if (receipt.bodyHash !== bodyHash) {
    throw new DomainError(
      422,
      'This Idempotency-Key was already used with a different request body.',
      'idempotency_key',
    )
  }
  return { replay: true, status: receipt.status, body: receipt.response as T }
}

/** The receipt's own statement — insert-only, riding the effect's batch. */
export function receiptStmt(
  route: string,
  key: string,
  body: unknown,
  status: number,
  response: unknown,
  now: string,
): Stmt {
  const receipt: IdempotencyReceipt = {
    id: sha256(`${route}\n${key}`),
    route,
    key,
    bodyHash: bodyHashOf(key, route, body),
    status,
    response,
    created_at: now,
    expires_at: new Date(Date.parse(now) + IDEMPOTENCY_TTL_MS).toISOString(),
  }
  return {
    sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('idempotency', ?, ?, 1, ?)
      ON CONFLICT(collection, id) DO NOTHING`,
    params: [receipt.id, JSON.stringify(receipt), now],
  }
}

/** The lazy sweep — append to every write batch; TTL-expired rows go quietly. */
export function sweepStmt(now: string): Stmt {
  return { sql: SQL_DELETE_EXPIRED, params: [now] }
}
