/**
 * Reads the store back into the app's own snapshot shape. The D1 engine hands
 * its documents/counters/meta rows over as a ParsedSnapshot (d1Snapshot.ts);
 * the assembly and the per-caller projection below are the shared truth every
 * reader serves.
 */
import { COLLECTIONS } from '../../src/lib/tables.js'
import { canViewPage } from '../../src/lib/pages.js'
import { isDeliveryAgent } from './domain.js'
import type { AppState, ViewId } from '../../src/types.js'

export interface Assembled {
  state: Partial<AppState> | null
  /** Opaque change token, compared for equality only — minted by the D1 commit
   *  arm's revision bump (d1Commit.ts). */
  revision: string
  everWritten: boolean
}

/** What one read parses into, engine-neutral: per-state-key documents, the
 *  counters, and Config as setting → value. The D1 adapter (d1Snapshot.ts)
 *  produces this shape; the assembly below it is the shared truth. */
export interface ParsedSnapshot {
  /** Parsed documents per AppState key — `[]` means deliberately emptied (a
   *  table read back with zero rows), an absent key means never written. */
  docs: Partial<Record<string, Record<string, unknown>[]>>
  counters: Record<string, number>
  /** Config rows as setting → value — app_revision / app_config / period:* verbatim. */
  config: Record<string, string>
}

/** The pure half: parsed rows → the app's snapshot shape. */
export function assembleState(parsed: ParsedSnapshot): Assembled {
  const state: Partial<AppState> = {}
  for (const [key, docs] of Object.entries(parsed.docs)) {
    ;(state as Record<string, unknown>)[key] = docs
  }
  // audit reads newest-first, the order the in-memory list has always been kept in
  if (state.audits) state.audits = [...state.audits].sort((a, b) => b.time.localeCompare(a.time))

  if (Object.keys(parsed.counters).length) state.counters = parsed.counters as unknown as AppState['counters']

  const revision = parsed.config['app_revision'] || '0'
  const rawConfig = parsed.config['app_config']
  if (rawConfig) {
    try { state.config = JSON.parse(rawConfig) as AppState['config'] } catch { /* leave unset */ }
  }
  const counterPeriods: Record<string, string> = {}
  for (const [setting, value] of Object.entries(parsed.config)) {
    if (setting.startsWith('period:')) counterPeriods[setting.slice(7)] = value
  }
  // Assigned here, after the counters pass — periods are read from Config, which
  // runs after the Counters pass that builds the shared object.
  if (Object.keys(counterPeriods).length) state.counterPeriods = counterPeriods

  // Collections are checked by their STATE key — the same test the Supabase client ran.
  const everWritten =
    revision !== '' && revision !== '0' ||
    (state.ledger?.length ?? 0) > 0 ||
    COLLECTIONS.some((c) => ((state as Record<string, unknown>)[c.key] as unknown[] | undefined)?.length)

  return { state: everWritten ? state : null, revision, everWritten }
}

// ---- read-side authorization: the per-caller projection over the shared substrate ----

/**
 * The tables a caller may be denied on the READ side — the mirror image of the
 * write gates in commitGates.ts. Masters stay readable for everyone: they are the
 * reference data every screen resolves names against, and the staff register
 * (the Roster page's master) sits on the open tier. Their CONTACT fields are
 * masked per MASTER_MASKS below — a master's identity travels everywhere, its
 * phone book only to the page that owns it. The day's work is readable by the
 * page that owns it, and the audit trail by the Audit page — an open-tier page,
 * so the operator keeps the trail and only scoped clerks lose it. `ledger`,
 * `counters`, `counterPeriods` and `config` are readable by every signed-in
 * caller: the ledger is the stock arithmetic the whole app runs on.
 */
const READ_GATED: { key: string; page: ViewId | readonly ViewId[] }[] = [
  ...COLLECTIONS.filter((c) => c.page).map((c) => ({ key: c.key, page: c.page! })),
  { key: 'audits', page: 'audit' },
]

/**
 * The masters contact fields a caller without the master's own page receives
 * DROPPED (Phase 4's close of the masking note the audit left open): a
 * vendor's phone/email without page.vendors, a customer's GSTIN/phone/email/
 * contact person without page.customers. Every field here is rendered by that
 * master's page alone (Vendors.tsx, Customers.tsx) — nothing functional
 * consumes them elsewhere, and a caller who cannot write the master (the write
 * gate demands the same slug) can never round-trip a field they never saw.
 * Rows are COPIED with the fields deleted, never blanked: the ids and names
 * every screen resolves against stay intact, and only the masked caller's
 * projection pays for the copy.
 */
const MASTER_MASKS: { key: string; page: string; fields: readonly string[] }[] = [
  { key: 'vendors', page: 'page.vendors', fields: ['phone', 'email'] },
  { key: 'customers', page: 'page.customers', fields: ['gst', 'phone', 'email', 'contactPerson'] },
]

/** One row with the masked fields deleted — the row itself when nothing was
 *  masked, so untouched arrays keep their original row objects. */
function maskRow(row: unknown, fields: readonly string[]): unknown {
  if (typeof row !== 'object' || row === null) return row
  const copy = { ...(row as Record<string, unknown>) }
  let touched = false
  for (const f of fields) {
    if (copy[f] !== undefined) {
      delete copy[f]
      touched = true
    }
  }
  return touched ? copy : row
}

/**
 * The state keys this caller may not see — CONSTANT per permission set, computed
 * from the page map alone and never from what the store holds, so the list leaks
 * which tables a ROLE cannot read, never which tables hold data. Empty for the
 * unscoped operator (the open tier reads the whole day's work) and for a caller
 * holding every page.
 */
export function withheldForCaller(held: readonly string[]): string[] {
  const sees = (page: ViewId | readonly ViewId[]) =>
    typeof page === 'string' ? canViewPage(held, page) : page.some((p) => canViewPage(held, p))
  return READ_GATED.filter((g) => !sees(g.page)).map((g) => g.key)
}

/**
 * Every state key the substrate can hold. The delivery agent's allowlist is its
 * complement (RBAC.md §d): an external caller receives NO plant data at all —
 * the PWA reads /api/shipments and /api/challans, never the mirror. Constant
 * per role like withheldForCaller's list, so it leaks nothing about the store.
 */
const AGENT_WITHHELD: readonly string[] = [
  ...new Set([
    ...COLLECTIONS.map((c) => c.key),
    'ledger',
    'audits',
    'counters',
    'counterPeriods',
    'config',
  ]),
]

/** What one caller's GET /api/snapshot returns after authorization. */
export interface ProjectedSnapshot {
  state: Partial<AppState> | null
  revision: string
  /** The state keys dropped from `state` for this caller — restoreWithheld's cue. */
  withheld: string[]
}

/**
 * The shared substrate, projected to one caller. The assembled snapshot is
 * memoized by revision token and served to everyone — that sharing is what
 * keeps the read cost flat — so authorization happens HERE, per request, on
 * a shallow copy: the keys this caller may not see are dropped and named in
 * `withheld`, which the client honors by keeping its mirror's copies of exactly
 * those keys (src/lib/sync.ts restoreWithheld). A key merely ABSENT would read
 * as "never written" to the client's seeding and as "the server dropped every
 * row" to its three-way merge — either corrupts the next save, which is why the
 * list travels with every body. The substrate itself is never mutated: the next
 * caller — an operator, an admin — still receives the whole plant. Masters
 * contact fields ride the same copy: MASTER_MASKS drops them per caller (row
 * copies, substrate rows untouched) — masked fields are not named in
 * `withheld`, because the client must NOT bridge them back from a stale mirror.
 */
export function projectSnapshot(snap: Assembled, held: readonly string[]): ProjectedSnapshot {
  // The delivery agent first (RBAC.md §d): the projection inverts to an
  // allowlist whose member list is empty — no masters, no ledger, no day's
  // work reaches an external caller, whatever pages a mis-ticked role added.
  if (isDeliveryAgent(held)) {
    return { state: {}, revision: snap.revision, withheld: [...AGENT_WITHHELD] }
  }
  const withheld = withheldForCaller(held)
  const masks = MASTER_MASKS.filter((m) => !held.includes(m.page))
  if (!snap.state || (!withheld.length && !masks.length)) {
    return { state: snap.state, revision: snap.revision, withheld }
  }
  const drop = new Set(withheld)
  const state: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(snap.state)) {
    if (drop.has(key)) continue
    const mask = masks.find((m) => m.key === key)
    state[key] = mask && Array.isArray(value) ? value.map((row) => maskRow(row, mask.fields)) : value
  }
  return { state: state as Partial<AppState>, revision: snap.revision, withheld }
}
