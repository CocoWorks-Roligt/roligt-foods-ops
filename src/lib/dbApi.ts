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
  if (res.status === 429 || res.status === 503) {
    // The commit/snapshot throttles (429) and the Zoho lock (503) both answer
    // with the seconds they want the client to wait — the queue's retry honours
    // the server's own hint instead of probing on a fixed half-minute.
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
  /**
   * State keys the server dropped because THIS caller may not read them (the
   * BFF's per-caller projection). The client restores those keys from its own
   * previous view before installing — sync.ts restoreWithheld — so a partial
   * snapshot never reads as "never written" to the seeding or as a wipe to the
   * three-way merge.
   */
  withheld?: string[]
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
 * so collection rows are held back to open the tail chunks — the queue never
 * ends in ledger-only commits an operator would be refused for. One document's
 * save often carries a ledger too long for the collection rows it has, so the
 * reserved rows wrap and vouch again: an already-landed row re-sent as a
 * voucher is skipped server-side as an idempotent no-op, costing a read, never
 * a write.
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
  const tail = rides.length + tailWrites

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

  if (tail === 0) {
    // nothing rides behind the rows — plain chunking
    for (const item of items) {
      addRow(item)
      if (used >= size) flush()
    }
    flush()
    return chunks
  }

  if (gateRows.length === 0) {
    // Nothing can vouch for a tail here — a masters save (masters tables carry
    // no page) or a ledger-only diff from an unscoped caller. One queue, rows
    // in order — and the rides (audits, counters, config) NEVER travel alone:
    // the BFF's ride-along gate refuses a commit whose only content is a ride,
    // and one refused chunk re-sends with every later save, wedging the device
    // (the lone "Edited item" audit of a change-nothing edit, 2026-10-07).
    // Rows chunk at the write pace; rides then take seats in a chunk that
    // already carries rows — the 16-row ceiling validateChanges grants leaves
    // every 12-row chunk four spare seats, and a save with more audits than
    // seats spills them into earlier chunks the same way. Counters and config
    // ride the same host: they cost no row, and a boundary that used to strand
    // them alone (the dropped-mint 409) now cannot. A re-sent host row is an
    // idempotent no-op server-side, the voucher trick with a masters row, so
    // even the pathological all-chunks-full save keeps its rides accompanied.
    const auditRows = items.filter((i) => i.table === 'audits')
    const rowItems = items.filter((i) => i.table !== 'audits')
    for (const item of rowItems) {
      addRow(item)
      if (used >= size) flush()
    }
    if (!rowItems.length) {
      // rides without any row of their own (an audits-only diff saveDb drops
      // before chunking; a ledger-only diff keeps its ledger rows above) —
      // unreachable from the app, kept whole for direct callers
      for (const item of auditRows) addRow(item)
      for (const key of counterKeys) current.counters[key] = changes.counters[key]!
      if (changes.config) current.config = changes.config
      flush()
      return chunks.length ? chunks : [changes]
    }
    const rowsOf = (c: StateChanges) => c.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0)
    const host: StateChanges = used > 0 ? current : chunks[chunks.length - 1]!
    const seated = [...auditRows]
    // last-to-first over closed chunks, then the host, until every audit sits
    const seatAll = (chunk: StateChanges) => {
      while (seated.length && rowsOf(chunk) < 16) {
        const item = seated.shift()!
        let table = chunk.tables.find((t) => t.table === item.table)
        if (!table) {
          table = { table: item.table, upsert: [], remove: [] }
          chunk.tables.push(table)
        }
        if (item.kind === 'upsert') {
          table.upsert.push(item.row)
          if (item.expect) (table.expect ??= {})[String(item.row.id)] = item.expect
        } else table.remove.push(item.id)
      }
    }
    for (let i = chunks.length - 1; i >= 0 && seated.length; i--) seatAll(chunks[i]!)
    seatAll(host)
    if (seated.length) {
      // every seat taken (only possible with more audits than four per chunk,
      // a shape no honest save produces): a fresh chunk opens by re-sending
      // the host's first stored upsert — identical to what is stored, so the
      // BFF skips it as an idempotent no-op, the voucher trick with a masters
      // row — and the remaining audits ride it
      const hostTable = host.tables.find((t) => t.upsert.length)
      const voucher = hostTable?.upsert[0] as Record<string, unknown> | undefined
      const fresh: StateChanges = { tables: [], counters: {}, empty: false }
      if (voucher) {
        const id = String((voucher as { id: unknown }).id)
        const expect = hostTable!.expect?.[id]
        fresh.tables.push({ table: hostTable!.table, upsert: [voucher], remove: [], ...(expect ? { expect: { [id]: expect } } : {}) })
      }
      while (seated.length) {
        const item = seated.shift()!
        let table = fresh.tables.find((t) => t.table === item.table)
        if (!table) {
          table = { table: item.table, upsert: [], remove: [] }
          fresh.tables.push(table)
        }
        table.upsert.push((item as { kind: 'upsert'; row: Record<string, unknown> }).row)
      }
      chunks.push(fresh)
      for (const key of counterKeys) fresh.counters[key] = changes.counters[key]!
      if (changes.config) fresh.config = changes.config
      return chunks
    }
    for (const key of counterKeys) host.counters[key] = changes.counters[key]!
    if (changes.config) host.config = changes.config
    host.empty = false
    flush()
    return chunks
  }

  // Voucher layout: every tail chunk opens with a collection row so the
  // ride-along gate admits it. One document's save often carries a ledger too
  // long for the collection rows it has (a packing run's 14 consume and output
  // lines behind one packing_runs row), so the reserved pool wraps — a voucher
  // re-sent after its chunk landed is skipped server-side as an idempotent
  // no-op (the row already matches what is stored). Chunks POST strictly in
  // order, so a wrapped voucher has always landed before it vouches again.
  const tailChunks = Math.max(1, Math.ceil(tail / (size - 1)))
  const voucherCount = Math.min(tailChunks, gateRows.length)
  const frontCount = gateRows.length - voucherCount

  // front: pure collection rows at full size
  for (const item of gateRows.slice(0, frontCount)) {
    addRow(item)
    if (used >= size) flush()
  }
  flush()

  // tail: each chunk opens with its voucher, then its share of the ride rows,
  // counter keys and — in the very last chunk, after everything else — the config
  const share = (i: number) => Math.floor(tail / tailChunks) + (i < tail % tailChunks ? 1 : 0)
  let rideIdx = 0
  let counterIdx = 0
  let configTaken = false
  for (let c = 0; c < tailChunks; c++) {
    addRow(gateRows[frontCount + (c % voucherCount)]!)
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
    // An edit that changed nothing diffs to its audit row alone ("Edited item"
    // is filed on every save-dialog submit, values or not). A lone audit is a
    // ride the BFF's ride-along gate refuses — and the refused row would ride
    // in every later save from this device, wedging its whole queue. Nothing
    // happened, so nothing is filed: the save reads the revision like the
    // empty diff always did and reports success.
    const auditsOnly =
      changes.tables.every((t) => t.table === 'audits') &&
      Object.keys(changes.counters).length === 0 &&
      !changes.config
    if (changes.empty || auditsOnly) {
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
