/**
 * Reads the base back into the app's own snapshot shape. Reads only ever use
 * App ID + Data JSON, so the fork's read path is byte-for-byte the contract the
 * Supabase client had (id, data) — `migrateState` fills any collection not yet
 * mapped from seed defaults, which is what lets the GRN slice ship before the rest.
 */
import type { ZohoClient, ZohoRecord } from './zoho.js'
import { T, TABLE_FOR } from './baseSchema.js'
import { rowToDoc } from './mappers.js'
import { COLLECTIONS, ledgerFromRow, auditFromRow } from '../../src/lib/tables.js'
import type { AppState } from '../../src/types.js'

export interface Assembled {
  state: Partial<AppState> | null
  /** Opaque change token (`<n>:<nonce>`), compared for equality only — see commit.ts. */
  revision: string
  everWritten: boolean
}

export type SnapshotRows = Record<string, ZohoRecord[]>

/** AppState is keyed by collection KEY (vendorTypes), not table name (vendor_types). */
function stateKeyFor(supa: string): string | null {
  if (supa === 'ledger' || supa === 'audits') return supa
  return COLLECTIONS.find((c) => c.table === supa)?.key ?? null
}

export function assembleState(schema: typeof T, rows: SnapshotRows): Assembled {
  const state: Partial<AppState> = {}
  // collections — including ledger and audits, whose Data JSON already holds the
  // document in its final shape — all read the same way
  for (const [supa, base] of Object.entries(TABLE_FOR)) {
    const table = schema[base]
    const key = stateKeyFor(supa)
    if (!table?.dataJson || !rows[supa] || !key) continue
    // A table read back with ZERO rows was deliberately emptied — emit [] so
    // `migrateState` cannot refill it from seed. Rows that exist but parse to no
    // documents (staged in the base without Data JSON) are a different thing: the
    // collection has never been written, so the key stays absent and seeding runs.
    const wiped = rows[supa].length === 0
    // Ledger and audits are stored in their FLAT row shapes (ledgerToRow/auditToRow —
    // qty_in, item_type, actor, at), so they decode through the same fromRow mappers
    // the Supabase client used; the generic doc decoder would leave qtyIn/itemType
    // undefined and a posted receipt would never show as stock.
    const fromRow = supa === 'ledger' ? ledgerFromRow : supa === 'audits' ? auditFromRow : null
    const docs = wiped
      ? []
      : rows[supa]
          .map((r) => {
            const raw = rowToDoc(table, r)
            if (!raw) return null
            return fromRow ? fromRow(raw) : raw
          })
          .filter((d): d is Record<string, unknown> => d !== null)
    if (wiped || docs.length) (state as Record<string, unknown>)[key] = docs
  }
  // audit reads newest-first, the order the in-memory list has always been kept in
  if (state.audits) state.audits = [...state.audits].sort((a, b) => b.time.localeCompare(a.time))

  const counters: Record<string, number> = {}
  const counterPeriods: Record<string, string> = {}
  const cnt = schema['Counters']
  for (const r of rows.counters ?? []) {
    const key = String(r.data[cnt.fields['Series']] ?? '')
    const value = String(r.data[cnt.fields['Next']] ?? '')
    if (!key) continue
    // Periods live in Config (text Value); a period row here is remnant corruption
    // whose number field dropped the string — reading it would hand nextId an empty
    // period and reset the running number on every boot.
    if (key.startsWith('period:')) continue
    counters[key] = Number(value) || 0
  }
  if (Object.keys(counters).length) state.counters = counters as unknown as AppState['counters']

  let revision = '0'
  const cfg = schema['Config']
  for (const r of rows.config ?? []) {
    const setting = String(r.data[cfg.fields['Setting']] ?? '')
    const value = String(r.data[cfg.fields['Value']] ?? '')
    if (setting === 'app_revision') revision = value || '0'
    if (setting === 'app_config' && value) {
      try { state.config = JSON.parse(value) as AppState['config'] } catch { /* leave unset */ }
    }
    if (setting.startsWith('period:')) counterPeriods[setting.slice(7)] = value
  }
  // Assigned here, after the Config loop — periods are read from Config, which runs
  // after the Counters pass that builds the shared object.
  if (Object.keys(counterPeriods).length) state.counterPeriods = counterPeriods

  // Collections are checked by their STATE key — the same test the Supabase client ran.
  const everWritten =
    revision !== '' && revision !== '0' ||
    (state.ledger?.length ?? 0) > 0 ||
    COLLECTIONS.some((c) => ((state as Record<string, unknown>)[c.key] as unknown[] | undefined)?.length)

  return { state: everWritten ? state : null, revision, everWritten }
}

/** Reads every mapped table (App ID + Data JSON only) and assembles the snapshot. */
export async function readSnapshot(zoho: ZohoClient): Promise<Assembled> {
  return (await sweepTables(zoho, null, new Set(), null)).snap
}

// ---- the substrate cache: rows held across sweeps, deltas off the watermarks ----

/**
 * The only tables a watermark delta is safe on. Ledger lines and audit rows are
 * append-only — a row is written once with a fixed `at` and never edited (audits
 * are insert-only by the commit gate; a ledger line only ever leaves by whole-
 * document reversal, which files a remove hint) — so "rows whose Data JSON
 * mentions an hour at or past the watermark" is exactly the new rows. Every
 * collection table is edited IN PLACE: the same App ID is re-upserted with new
 * content whose timestamps need not advance, so a watermark would miss edits —
 * those tables full-read on every sweep.
 */
const DELTA_KEYS = ['ledger', 'audits'] as const
type DeltaKey = (typeof DELTA_KEYS)[number]
const isDeltaKey = (supa: string): supa is DeltaKey => supa === 'ledger' || supa === 'audits'

/**
 * How long a watermark may stand without a full re-read. A delta cannot see
 * deletions made by a writer this process never heard from (another instance, a
 * hand edit in the Zoho UI) — its own commits file remove hints, foreign ones
 * cannot. The clock bounds that blindness: at worst five minutes of rows that
 * were deleted server-side still show, then a full read reconciles.
 */
const FULL_REREAD_MS = 5 * 60_000

/** What one sweep produced, besides the assembled state. */
interface Swept {
  snap: Assembled
  rows: SnapshotRows
  watermarks: { ledger?: string; audits?: string }
  lastFullAt: Partial<Record<DeltaKey, number>>
}

/** The Data JSON `at` of a row — the one timestamp that survives read-back
 *  un-normalized. The Time column does not (`2026-09-30T07:00:00.000Z` reads
 *  back "2026/09/30 07:00:00", pinned live 2026-09-30), which is why watermarks
 *  come from the JSON and never from the column. */
function rowAt(table: { dataJson?: string }, r: ZohoRecord): string | null {
  if (!table.dataJson) return null
  const raw = r.data[table.dataJson]
  if (raw === undefined || raw === null || raw === '') return null
  try {
    const at = (JSON.parse(String(raw)) as { at?: unknown }).at
    return typeof at === 'string' && at ? at : null
  } catch {
    return null
  }
}

/** The max `at` across rows (never below `seen`) — ISO-8601 Zulu strings compare
 *  lexicographically in chronological order, so a plain string compare is it. */
function maxAt(seen: string | undefined, rows: ZohoRecord[], table: { dataJson?: string }): string | undefined {
  let max = seen
  for (const r of rows) {
    const at = rowAt(table, r)
    if (at && (max === undefined || at > max)) max = at
  }
  return max
}

/** Delta rows merged over the substrate by App ID. A bucket re-read always
 *  re-delivers the watermark's boundary row, and a false-positive superset (some
 *  other JSON value mentioning the hour) re-mentions ids already held — the
 *  merge is idempotent by business key, which is what makes both safe. */
function mergeById(base: ZohoRecord[], incoming: ZohoRecord[], appIdField: string): ZohoRecord[] {
  if (!incoming.length) return base
  const byId = new Map(base.map((r) => [String(r.data[appIdField] ?? r.recordID), r]))
  for (const r of incoming) byId.set(String(r.data[appIdField] ?? r.recordID), r)
  return [...byId.values()]
}

/**
 * One sweep. Collection tables and Counters/Config full-read every time (scope
 * 'sweep' — the self-restraint pool that leaves interactive traffic its slots);
 * ledger and audits full-read cold, hinted, past the reconciliation clock, or
 * when their delta read refuses — and delta-read (fetchSince: `contains` hour
 * buckets over the Data JSON, the one criteria form the live probe found
 * working) off the substrate otherwise, merging by App ID. Config reads LAST:
 * it carries the revision the caller is returned and the gate compares against.
 *
 * `fast` (non-null) is the own-commit fast path: a Set of the table keys one of
 * this process's commits touched, proved by the caller to be the ONLY write
 * between the substrate and the gate. Tables outside the set are copied from
 * the substrate unread — watermark and clock carried for delta tables — while
 * Counters and Config still read (every commit writes them).
 */
async function sweepTables(
  zoho: ZohoClient,
  entry: SweepCache | null,
  forceFull: ReadonlySet<string>,
  fast: ReadonlySet<string> | null,
): Promise<Swept> {
  const schema = T
  const rows: SnapshotRows = {}
  const watermarks: { ledger?: string; audits?: string } = {}
  const lastFullAt: Partial<Record<DeltaKey, number>> = {}
  const canDelta = (key: DeltaKey) =>
    !!entry &&
    entry.baseId === zoho.baseId &&
    entry.watermarks[key] !== undefined &&
    !forceFull.has(key) &&
    (entry.lastFullAt[key] ?? 0) > Date.now() - FULL_REREAD_MS

  await Promise.all(
    Object.entries(TABLE_FOR).map(async ([supa, base]) => {
      const table = schema[base]
      // order_lines and anything else not in COLLECTIONS is fetched-then-discarded
      // otherwise — a read budget is spent for rows the state can never hold.
      if (!table || !stateKeyFor(supa)) return
      if (fast !== null && !fast.has(supa) && entry) {
        rows[supa] = entry.rows[supa] ?? []
        if (isDeltaKey(supa)) {
          watermarks[supa] = entry.watermarks[supa]
          lastFullAt[supa] = entry.lastFullAt[supa] // no read — the clock stands
        }
        return
      }
      if (isDeltaKey(supa)) {
        if (canDelta(supa)) {
          try {
            const since = await zoho.fetchSince(table.id, table.dataJson!, entry!.watermarks[supa]!, {
              scope: 'sweep',
            })
            rows[supa] = mergeById(entry!.rows[supa] ?? [], since, table.appId)
            watermarks[supa] = maxAt(entry!.watermarks[supa], since, table)
            lastFullAt[supa] = entry!.lastFullAt[supa] // no full read — the clock stands
            return
          } catch {
            // any refusal — a wrapped INTERNAL SERVER ERROR, a gap too wide for
            // the bucket cap — falls to the full read below, same sweep
          }
        }
        rows[supa] = await zoho.fetchAll(table.id, { scope: 'sweep' })
        watermarks[supa] = maxAt(undefined, rows[supa], table)
        lastFullAt[supa] = Date.now()
        return
      }
      rows[supa] = await zoho.fetchAll(table.id, { scope: 'sweep' })
    }),
  )
  rows.counters = await zoho.fetchAll(schema['Counters'].id, { scope: 'sweep' })
  rows.config = await zoho.fetchAll(schema['Config'].id, { scope: 'sweep' })
  return { snap: assembleState(schema, rows), rows, watermarks, lastFullAt }
}

/**
 * The last sweep's substrate, keyed by the revision token it gated on.
 *
 * A sweep is 26 read calls — one per table — against the client's budget of 26
 * reads a minute, so a reload that re-swept spent a full minute waiting for the
 * budget window to slide before it could even start. But nothing in the base
 * changes except through a commit, and every commit bumps the revision row last,
 * so a snapshot read at revision R is exactly what a fresh sweep at R would
 * return. One revision read answers whether the cache still stands.
 *
 * The entry holds the raw ROWS, not just the assembled state: ledger and audits
 * are append-only, so a revision bump needs only the rows whose Data JSON
 * mentions an hour past the watermark (fetchSince — one read instead of one per
 * thousand lines) merged over what is held. The substrate is only ever installed
 * under the token the sweep GATED on (read before the first table), never the
 * token its trailing Config read happened to return: a commit landing mid-sweep
 * would otherwise cache a torn mix of pre- and post-commit rows under the new
 * token and serve it as fresh forever. A sweep whose end revision moved is
 * returned to its caller but cached nowhere — the next gate re-sweeps.
 *
 * Per process: the dev harness is one process, a warm serverless instance is
 * one, and each gates on its own revision read, so nothing needs coordinating
 * between them.
 */
interface SweepCache {
  baseId: string
  /** The gate token this substrate was assembled under — compared for equality only. */
  revision: string
  rows: SnapshotRows
  /** Max Data JSON `at` held per delta table — the fetchSince watermark. */
  watermarks: { ledger?: string; audits?: string }
  /** When each delta table was last full-read — the reconciliation clock. */
  lastFullAt: Partial<Record<DeltaKey, number>>
  /** When EVERY table's rows were last read whole — a full sweep's timestamp,
   *  PRESERVED through fast-path installs (they refresh only what they re-read).
   *  Bounds how long a Zoho-UI hand edit — which moves no revision — can stay
   *  invisible through a run of own-commit fast paths. */
  verifiedAt: number
  /** Null after a foreign invalidate: the substrate still deltas, the assembled
   *  state never serves again. */
  snap: Assembled | null
}

let cached: SweepCache | null = null
/** The sweep in flight, shared by every caller asking while it runs. */
let sweeping: Promise<Assembled> | null = null

/**
 * The newest revision this process has seen or written, with the base it belongs
 * to — the value an audit's revision bump starts from without reading Config.
 */
let lastKnownRevision: { baseId: string; value: string } | null = null

/**
 * Facts a commit files at its bump for the next sweep to honor — accumulated
 * here, not on the cache entry, so a sweep in flight cannot lose them: the sweep
 * drains the store when it starts and puts everything back unless its result was
 * actually installed.
 */
let pendingHints: { baseId: string; forceFull: Set<string>; touched: Set<string> } | null = null

/**
 * Commits this process applied, token → base. Two things read it: the route's
 * post-commit invalidate (is this token OURS, and therefore a no-op?) and the
 * sweep's own-commit fast path (is the gate token ours?). The route's invalidate
 * does NOT consume a marker — the fast path needs it to survive until a sweep
 * installs at or past the token, which is what clears entries (plus the FIFO
 * bound). More than one can be outstanding because the commit mutex serializes
 * the WRITES, not the route handlers around them — request A's invalidate(T1)
 * can land after request B's commit already minted T2, and T1 must still read
 * as our own, not as a foreign token that would roll lastKnownRevision
 * backwards and force-full both delta tables for nothing.
 */
const ownTokens = new Map<string, string>()
const revisionNumberOf = (token: string): number => parseInt(token, 10) || 0

function addHints(baseId: string, forceFull: Iterable<string>, touched: Iterable<string>): void {
  const cur =
    pendingHints && pendingHints.baseId === baseId
      ? pendingHints
      : (pendingHints = { baseId, forceFull: new Set(), touched: new Set() })
  for (const t of forceFull) cur.forceFull.add(t)
  for (const t of touched) cur.touched.add(t)
}

function drainHints(baseId: string): { forceFull: Set<string>; touched: Set<string> } {
  if (!pendingHints || pendingHints.baseId !== baseId) {
    return { forceFull: new Set(), touched: new Set() }
  }
  const drained = pendingHints
  pendingHints = null
  return { forceFull: drained.forceFull, touched: drained.touched }
}

/** Undrains — hints a sweep honored but could not install must wait for the next
 *  sweep (a failed one, or one the mid-sweep revision move made uncacheable);
 *  unioned with anything filed meanwhile. */
function restoreHints(baseId: string, drained: { forceFull: Set<string>; touched: Set<string> }): void {
  if (drained.forceFull.size || drained.touched.size) addHints(baseId, drained.forceFull, drained.touched)
}

/** Record the freshest revision in hand — every read and bump passes here. */
export function noteRevision(baseId: string, value: string): void {
  lastKnownRevision = { baseId, value }
}

/**
 * What a commit tells the next sweep. `removedTables` and `backdatedLedger`
 * exist because a contains-bucket delta cannot see behind its watermark: rows
 * the commit DELETED, or ledger rows it wrote with an `at` under the watermark
 * (PM receipts backdate), would otherwise stay invisible until the
 * reconciliation clock. `touchedTables` is the own-commit fast path's re-sweep
 * set: when the next sweep's gate is this commit's own token, proved the only
 * write in between, just those tables (plus Counters and Config) are read.
 */
export interface CommitHints {
  removedTables: string[]
  backdatedLedger: boolean
  touchedTables: string[]
}

/**
 * Files a commit's hints at its bump. The token is remembered so the route's
 * post-commit invalidate(token) is the no-op it should be: this process's own
 * commit does not spend the substrate — its rows land at `at` = now, ahead of
 * the watermark, where the next delta finds them — and so the sweep that
 * follows can recognize the gate as its own and fast-path off the touched set.
 */
export function noteCommitApplied(baseId: string, token: string, hints: CommitHints): void {
  ownTokens.set(token, baseId)
  if (ownTokens.size > 32) ownTokens.delete(ownTokens.keys().next().value!)
  // the poll memo serves the token at once — the committing process is the one
  // device that knows the revision without reading it
  revisionMemo = { baseId, value: token, at: Date.now() }
  const forceFull = new Set<string>(hints.removedTables)
  if (hints.backdatedLedger) forceFull.add('ledger')
  addHints(baseId, forceFull, hints.touchedTables)
}

/** The ledger watermark this process holds — the commit path's backdate test. */
export function cachedLedgerWatermark(baseId: string): string | null {
  return cached && cached.baseId === baseId ? (cached.watermarks.ledger ?? null) : null
}

/**
 * The revision this process last saw, either from a sweep or from its own commit —
 * the value an audit's revision bump can start from without reading Config at all.
 */
export function cachedRevision(baseId: string): string | null {
  // After this process's own commit the entry's token still names the plant as
  // it was BEFORE the commit — the freshest knowledge is the token the bump just
  // wrote, and serving the entry's would bump from a number already spent.
  const hasOwn = [...ownTokens.values()].includes(baseId)
  if (cached && cached.baseId === baseId && !hasOwn) {
    return cached.revision
  }
  return lastKnownRevision && lastKnownRevision.baseId === baseId ? lastKnownRevision.value : null
}

/**
 * The last revision read, with when — the poll route's micro-cache. Every client
 * polls every 20s; on one warm instance those polls land seconds apart, and each
 * one used to spend a whole Config fetch. Within this TTL they share a single read
 * (single-flighted below). The TTL is far inside the poll's own granularity, so a
 * served value is at worst a few seconds staler than the poll already is.
 */
let revisionMemo: { baseId: string; value: string; at: number } | null = null
/** The memo-miss read in flight, shared by every concurrent poller. */
let revisionReading: Promise<string> | null = null
const REVISION_MEMO_TTL_MS = 4_000

/**
 * The base changed — what survives depends on who this process is to the change.
 * Its OWN commit (token === the marker noteCommitApplied left): a no-op — the
 * substrate stands, the hints are filed, the moved revision gates the next
 * sweep. A FOREIGN token (the admin audit's own bump): the rows stay as a delta
 * base but the assembled state must never serve again, and neither delta table
 * may trust its watermark — a foreign writer's rows are a black box to the
 * bucket delta. Bare: the process knows nothing anymore (test isolation, a base
 * switch) — forget everything.
 */
export function invalidateSnapshotCache(nowAt?: string): void {
  // the marker is deliberately NOT consumed here: the fast path needs it until a
  // sweep installs at or past the token. Clearing happens there (and at the
  // FIFO bound), so the route's invalidate stays a pure no-op for the cache.
  if (nowAt !== undefined && ownTokens.has(nowAt)) return
  const baseId = cached?.baseId ?? lastKnownRevision?.baseId
  if (nowAt === undefined || !baseId) {
    cached = null
    pendingHints = null
    ownTokens.clear()
    lastKnownRevision = null
    revisionMemo = null
    return
  }
  if (cached && cached.baseId === baseId) {
    cached = { ...cached, snap: null }
    addHints(baseId, DELTA_KEYS, [])
  }
  lastKnownRevision = { baseId, value: nowAt }
  revisionMemo = { baseId, value: nowAt, at: Date.now() }
}

/** Reads the plant, sweeping Zoho only when the revision has moved since the last read. */
export async function readSnapshotCached(zoho: ZohoClient): Promise<Assembled> {
  const entry = cached && cached.baseId === zoho.baseId ? cached : null
  // the gate is read BEFORE any sweep this call may start — cold included. A
  // warm entry could gate on its own token, but installing a sweep under a
  // token that was never read up front is exactly the torn-cache window fix 8
  // exists to close, so every sweep gates on a token read in its own call.
  const gate = await readRevision(zoho)
  if (entry && gate === entry.revision && entry.snap) return entry.snap
  if (!sweeping) {
    sweeping = runSweep(zoho, gate).finally(() => {
      sweeping = null
    })
  }
  return sweeping
}

/** One sweep, installed only under the token it gated on. */
async function runSweep(zoho: ZohoClient, gate: string): Promise<Assembled> {
  const entry = cached && cached.baseId === zoho.baseId ? cached : null
  const drained = drainHints(zoho.baseId)
  let installed = false
  try {
    // The own-commit fast path's proof, all three parts or nothing: the gate
    // token is one of this process's outstanding bumps (our commit is the newest
    // write), its number is EXACTLY the substrate's + 1 (no other commit — ours
    // or foreign — bumped in between; a foreign commit that did breaks the
    // arithmetic and the sweep full-reads, catching its collection writes), and
    // the substrate is inside the reconciliation clock (a Zoho-UI hand edit
    // moves no revision at all, so freshness is the only bound on how long one
    // can stay invisible through a run of fast paths).
    const gateNum = revisionNumberOf(gate)
    const fast =
      entry &&
      ownTokens.has(gate) &&
      revisionNumberOf(entry.revision) + 1 === gateNum &&
      Date.now() - entry.verifiedAt < FULL_REREAD_MS
        ? drained.touched
        : null
    const built = await sweepTables(zoho, entry, drained.forceFull, fast)
    if (built.snap.revision === gate) {
      cached = {
        baseId: zoho.baseId,
        revision: gate,
        rows: built.rows,
        watermarks: built.watermarks,
        lastFullAt: built.lastFullAt,
        // a fast install refreshed only what it re-read — the untouched rows'
        // read age stands, so the clock keeps ticking from the last FULL sweep
        verifiedAt: fast !== null && entry ? entry.verifiedAt : Date.now(),
        snap: built.snap,
      }
      // the substrate has caught up with (or passed) every own token at or below
      // the gate — their routes' invalidates already behaved; a commit that
      // landed ABOVE the gate mid-sweep keeps its marker for its own route
      const gateNum = revisionNumberOf(gate)
      for (const [t, b] of ownTokens) {
        if (b === zoho.baseId && revisionNumberOf(t) <= gateNum) ownTokens.delete(t)
      }
      noteRevision(zoho.baseId, gate)
      installed = true
    } else {
      // a commit moved the base mid-sweep: the assembled state goes to this
      // caller, but it is cached NOWHERE — a torn substrate must never serve as
      // fresh. The old entry survives untouched; the next sweep deltas off it.
      noteRevision(zoho.baseId, built.snap.revision)
    }
    return built.snap
  } finally {
    // hints are only consumed by an installed sweep — a failed or uncacheable
    // one puts them back for the next, unioned with anything filed meanwhile
    if (!installed) restoreHints(zoho.baseId, drained)
  }
}

/** Reads just the revision token (one row) — the gate every snapshot re-read hangs on. */
export async function readRevision(zoho: ZohoClient): Promise<string> {
  const cfg = T['Config']
  // One row by criteria, not a paged Config sweep: the Config table also holds
  // app_config's whole JSON blob, which a revision gate has no business pulling
  // down the wire every 20 seconds per client. The criteria form and its
  // is_ids_used_in_params flag are fetchByKeyIn's, pinned live (see zoho.ts).
  const rows = await zoho.fetchByKeyIn(cfg.id, cfg.fields['Setting'], ['app_revision'])
  for (const r of rows) {
    if (String(r.data[cfg.fields['Setting']]) === 'app_revision') {
      const value = String(r.data[cfg.fields['Value']] ?? '') || '0'
      noteRevision(zoho.baseId, value)
      return value
    }
  }
  noteRevision(zoho.baseId, '0')
  return '0'
}

/** The poll route's read — memoized for a few seconds and shared by concurrent pollers. */
export async function readRevisionMemoized(zoho: ZohoClient): Promise<string> {
  if (revisionMemo && revisionMemo.baseId === zoho.baseId && Date.now() - revisionMemo.at < REVISION_MEMO_TTL_MS) {
    return revisionMemo.value
  }
  if (!revisionReading) {
    revisionReading = readRevision(zoho)
      .then((value) => {
        revisionMemo = { baseId: zoho.baseId, value, at: Date.now() }
        return value
      })
      .finally(() => {
        revisionReading = null
      })
  }
  return revisionReading
}
