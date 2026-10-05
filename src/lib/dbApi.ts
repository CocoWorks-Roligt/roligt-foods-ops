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
import { COLLECTIONS } from './tables'
import type { AppState } from '../types'
import { notifyUnauthorized } from './authEvents'
import { WORKOS_CONFIGURED, getDevRole } from './authMode'
import { trackEvent } from './apptics'

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
    trackEvent('session_expired')
    throw new UnauthorizedError()
  }
  if (res.status === 503) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60
    trackEvent('db_throttled', { retryAfterSec: retryAfter })
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
 * writes a minute and the BFF fails fast at 45 s of budget wait, so a first-run
 * seed or an offline catch-up (a hundred-odd rows in one POST) can never land
 * as a single request. Each chunk is an independent keyed-upsert commit, so a
 * failure partway is retried as the same writes, never as duplicates.
 *
 * The budget counts every Zoho write, not just rows: each moved counter is one
 * write and the config one more, so they are charged against the same 12 as the
 * rows. A 12-row chunk with a morning of minted numbers riding free is really a
 * 30-write commit that cannot fit one budget minute — the 2026-10-05 catch-up
 * queue that would not drain.
 *
 * Chunks must also be legal on their own: the BFF lets a scoped caller write
 * ledger lines, audit rows and counters only in a commit that also carries a
 * collection row whose page they hold (the ride-along gate in api/_lib/commit.ts),
 * so the last collection rows are held back to open the tail chunks one each —
 * the queue never ends in ledger-only commits an operator would be refused for.
 */
const WRITES_PER_COMMIT = 12

/** Tables whose rows satisfy the ride-along gate — a collection with a page. */
const GATE_TABLES = new Set(COLLECTIONS.filter((c) => c.page).map((c) => c.table))

type RowItem =
  | { kind: 'upsert'; table: string; row: Record<string, unknown>; expect?: Record<string, unknown> | null }
  | { kind: 'remove'; table: string; id: string }

export function chunkChanges(changes: StateChanges, size = WRITES_PER_COMMIT): StateChanges[] {
  const counterKeys = Object.keys(changes.counters)
  const tailWrites = counterKeys.length + (changes.config ? 1 : 0)
  const items: RowItem[] = []
  for (const change of changes.tables) {
    for (const row of change.upsert)
      items.push({ kind: 'upsert', table: change.table, row, expect: change.expect?.[String(row.id)] })
    for (const id of change.remove) items.push({ kind: 'remove', table: change.table, id })
  }
  if (items.length + tailWrites <= size) return [changes]

  // diffState emits collections first, then ledger, then audits — the rows the
  // gate vouches for are exactly the collection rows at the front
  const gateRows = items.filter((i) => GATE_TABLES.has(i.table))
  const rides = items.filter((i) => !GATE_TABLES.has(i.table))
  // each tail chunk carries rides/counters/config plus one reserved collection
  // row, so its ride-along share is at most size − 1 writes
  const tailChunks = Math.max(1, Math.ceil((rides.length + tailWrites) / (size - 1)))
  const spread = gateRows.length >= tailChunks

  const chunks: StateChanges[] = []
  let current: StateChanges = { tables: [], counters: {}, empty: true }
  let used = 0
  const flush = () => {
    if (used > 0) {
      current.empty = false
      chunks.push(current)
      current = { tables: [], counters: {}, empty: true }
      used = 0
    }
  }
  const addRow = (item: RowItem) => {
    let table = current.tables.find((t) => t.table === item.table)
    if (!table) {
      table = { table: item.table, upsert: [], remove: [] }
      current.tables.push(table)
    }
    if (item.kind === 'upsert') {
      table.upsert.push(item.row)
      if (item.expect) (table.expect ??= {})[String(item.row.id)] = item.expect
    } else table.remove.push(item.id)
    used++
  }

  if (!spread) {
    // not enough collection rows to vouch for the tail: keep the pre-spread
    // shape — one queue, rows in order, counters and config riding the final
    // chunk. Ledger-heavy diffs like this do not come out of the UI, and a fat
    // last chunk still converges: every write is a keyed upsert, so a retry
    // after a mid-chunk throttle re-sends the same keys and only writes what
    // has not landed.
    for (const item of items) {
      addRow(item)
      if (used >= size) flush()
    }
    current.counters = changes.counters
    current.config = changes.config
    flush()
    return chunks.length ? chunks : [changes]
  }

  // front: pure collection rows at full size
  const frontCount = gateRows.length - tailChunks
  for (const item of gateRows.slice(0, frontCount)) {
    addRow(item)
    if (used >= size) flush()
  }
  flush()

  // tail: each chunk opens with one reserved collection row (the gate's
  // voucher), then its share of the ride rows, counter keys and — in the very
  // last chunk, after everything else — the config
  const total = rides.length + tailWrites
  const share = (i: number) => Math.floor(total / tailChunks) + (i < total % tailChunks ? 1 : 0)
  let rideIdx = 0
  let counterIdx = 0
  let configTaken = false
  for (let c = 0; c < tailChunks; c++) {
    addRow(gateRows[frontCount + c]!)
    for (let s = 0; s < share(c); s++) {
      if (rideIdx < rides.length) addRow(rides[rideIdx++]!)
      else if (counterIdx < counterKeys.length) {
        const key = counterKeys[counterIdx++]!
        current.counters[key] = changes.counters[key]!
        used++
      } else if (changes.config && !configTaken) {
        current.config = changes.config
        configTaken = true
        used++
      }
    }
    flush()
  }
  return chunks
}

export async function saveDb(next: AppState, prev: AppState | null): Promise<SaveResult> {
  const changes: StateChanges = diffState(prev, next)
  // Apptics usage signal: which document kinds this save carries — every flow
  // (GRN, QC, dispatch, packing…) funnels through this one write path, so the
  // touched tables are the honest per-flow breakdown.
  const tables = changes.tables.map((t) => t.table).join(',')
  const rows = changes.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0)
  const finish = (result: SaveResult): SaveResult => {
    trackEvent('db_commit', { ok: result.ok, reason: result.ok ? 'ok' : result.reason, tables, rows })
    return result
  }
  try {
    if (changes.empty) {
      const revision = await fetchRevision()
      return finish({ ok: true, revision })
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
        return finish({
          ok: false,
          reason: 'forbidden',
          message: j.error ?? `You do not have permission to change ${(j.table ?? 'this data').replace(/_/g, ' ')}.`,
        })
      }
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; conflicts?: RowConflict[] }
        const conflicts = j.conflicts ?? []
        return finish({
          ok: false,
          reason: 'conflict',
          message:
            j.error ??
            (conflicts.length
              ? `Another device saved ${conflicts.map((c) => c.id).join(', ')} first — their version is now shown.`
              : 'Another device saved changes to the same records first.'),
          conflicts,
        })
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      return finish({ ok: false, reason: 'error', message: j.error ?? `commit failed (HTTP ${res.status})` })
    }
    return finish({ ok: true, revision })
  } catch (e) {
    // A dead session is not an outage: the work stays held on this device and
    // is pushed after signing in again. Reporting it as offline would promise a
    // reconnect that never comes.
    if (e instanceof UnauthorizedError) {
      return finish({ ok: false, reason: 'unauthorized', message: e.message })
    }
    throw e
  }
}
