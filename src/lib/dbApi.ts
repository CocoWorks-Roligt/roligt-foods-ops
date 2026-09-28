/**
 * Reading and writing the plant — Zoho Tables edition.
 *
 * Everything the Supabase version did through its SDK now goes over three BFF
 * endpoints; the shapes are unchanged (`fetchDb` returns the same DbSnapshot,
 * `saveDb` the same SaveResult), so AppContext, the offline queue and the diff
 * engine keep working untouched. The BFF holds the Zoho credentials; the
 * browser holds no tokens at all — the httpOnly session cookie is the whole
 * credential, refreshed server-side by the BFF on any data request.
 */
import { diffState, type StateChanges } from './sync'
import type { AppState } from '../types'
import { notifyUnauthorized } from './authEvents'
import { WORKOS_CONFIGURED, getDevRole } from './authMode'

/** The BFF refused the session cookie — it is gone. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Your session expired — sign in again.')
  }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin', // the session cookie is the credential
    headers: {
      'content-type': 'application/json',
      // Unconfigured dev harness: the picker's role is the only signal the BFF
      // gets about who is "signed in" (it answers with matching permissions).
      ...(WORKOS_CONFIGURED ? {} : { 'x-dev-role': getDevRole() }),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) {
    // Refresh happens server-side; a 401 that survived it means the session is
    // really dead — no client-side retry exists or is needed.
    notifyUnauthorized() // AuthContext clears the session → login screen
    throw new UnauthorizedError()
  }
  if (res.status === 503) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60
    throw new ThrottledError(retryAfter)
  }
  return res
}

export class ThrottledError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterSec: number) {
    super('The server is busy — your change is saved on this device and will retry.')
    this.retryAfterSec = retryAfterSec
  }
}

/** One row another device saved first, named so the client can adopt its version. */
export interface RowConflict {
  table: string
  id: string
  kind: 'changed' | 'exists'
}

/**
 * The database's change token. It is an opaque string (`<n>:<nonce>`), compared
 * for equality only: every commit writes a fresh one, so two commits landing in
 * the same instant can never leave a reader believing it is current while rows
 * it has never seen are sitting committed above them.
 */
export async function fetchRevision(): Promise<string> {
  const res = await api('/api/revision')
  if (!res.ok) throw new Error(`Failed to read revision: ${await res.text()}`)
  const j = (await res.json()) as { revision: number | string }
  return String(j.revision ?? '')
}

export interface DbSnapshot {
  state: Partial<AppState> | null
  revision: string
  /** The caller's permissions per the BFF — AppContext feeds them to the gating. */
  permissions?: string[]
}

export async function fetchDb(): Promise<DbSnapshot> {
  const res = await api('/api/snapshot')
  if (!res.ok) throw new Error(`Failed to read the plant: ${await res.text()}`)
  return (await res.json()) as DbSnapshot
}

export type SaveResult =
  | { ok: true; revision: string }
  | { ok: false; reason: 'forbidden'; message: string }
  | { ok: false; reason: 'unauthorized'; message: string }
  | {
      ok: false
      reason: 'conflict'
      message: string
      /** The rows the server refused, so the caller can adopt the versions that won. */
      conflicts: RowConflict[]
    }
  | { ok: false; reason: 'error'; message: string }

/**
 * Splits a diff into commits the write budget can carry. Zoho allows roughly 17
 * writes a minute, so a first-run seed or an offline catch-up (a hundred-odd
 * rows in one POST) can never land as a single request — the function would sit
 * in the budget's wait and die at the platform timeout with rows half-written.
 * Each chunk is an independent keyed-upsert commit, so a failure partway is
 * retried as the same writes, never as duplicates.
 */
const WRITES_PER_COMMIT = 12

function chunkChanges(changes: StateChanges, size = WRITES_PER_COMMIT): StateChanges[] {
  const rowWrites = changes.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0)
  if (rowWrites <= size) return [changes]

  const chunks: StateChanges[] = []
  let current: StateChanges = { tables: [], counters: {}, empty: true }
  let used = 0
  const flush = () => {
    if (used > 0) {
      // counters and config are one write each and always travel in the final
      // chunk, after every row they number
      current.empty = false
      chunks.push(current)
      current = { tables: [], counters: {}, empty: true }
      used = 0
    }
  }
  for (const change of changes.tables) {
    const rows = [
      ...change.upsert.map((row) => ({ kind: 'upsert' as const, row })),
      ...change.remove.map((id) => ({ kind: 'remove' as const, id })),
    ]
    let batch: typeof rows = []
    const drain = () => {
      if (!batch.length) return
      const table: typeof change = { table: change.table, upsert: [], remove: [] }
      for (const r of batch) {
        if (r.kind === 'upsert') {
          table.upsert.push(r.row)
          const expected = change.expect?.[String(r.row.id)]
          if (expected) (table.expect ??= {})[String(r.row.id)] = expected
        } else table.remove.push(r.id)
      }
      current.tables.push(table)
      used += batch.length
      batch = []
    }
    for (const r of rows) {
      batch.push(r)
      if (batch.length >= size) {
        drain()
        flush()
      }
    }
    drain()
  }
  flush()
  if (!chunks.length) return [changes] // counters/config only — one commit
  chunks[chunks.length - 1]!.counters = changes.counters
  chunks[chunks.length - 1]!.config = changes.config
  chunks[chunks.length - 1]!.empty =
    !chunks[chunks.length - 1]!.tables.length &&
    !Object.keys(changes.counters).length &&
    !changes.config
  return chunks
}

export async function saveDb(next: AppState, prev: AppState | null): Promise<SaveResult> {
  const changes: StateChanges = diffState(prev, next)
  try {
    if (changes.empty) {
      const revision = await fetchRevision()
      return { ok: true, revision }
    }
    let revision = ''
    for (const chunk of chunkChanges(changes)) {
      if (chunk.empty) continue
      const res = await api('/api/commit', {
        method: 'POST',
        body: JSON.stringify({ changes: chunk }),
      })
      if (res.ok) {
        revision = String(((await res.json()) as { revision: number | string }).revision ?? '')
        continue
      }
      if (res.status === 403) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; table?: string }
        return {
          ok: false,
          reason: 'forbidden',
          message: j.error ?? `You do not have permission to change ${(j.table ?? 'this data').replace(/_/g, ' ')}.`,
        }
      }
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; conflicts?: RowConflict[] }
        const conflicts = j.conflicts ?? []
        return {
          ok: false,
          reason: 'conflict',
          message:
            j.error ??
            (conflicts.length
              ? `Another device saved ${conflicts.map((c) => c.id).join(', ')} first — their version is now shown.`
              : 'Another device saved changes to the same records first.'),
          conflicts,
        }
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      return { ok: false, reason: 'error', message: j.error ?? `commit failed (HTTP ${res.status})` }
    }
    return { ok: true, revision }
  } catch (e) {
    // A dead session is not an outage: the work stays held on this device and
    // is pushed after signing in again. Reporting it as offline would promise a
    // reconnect that never comes.
    if (e instanceof UnauthorizedError) {
      return { ok: false, reason: 'unauthorized', message: e.message }
    }
    throw e
  }
}
