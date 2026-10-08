/**
 * The commit engine's pure gates — the rules that judge a StateChanges
 * against caller permissions and stored state, extracted VERBATIM from
 * commit.ts so the two engines cannot drift: the Zoho engine and the D1
 * engine both import their verdicts from here, and every gate either throws
 * the error class the route maps (Forbidden 403, Conflict 409) or returns
 * its verdict for the caller to act on. Nothing in this module performs I/O.
 *
 * The reads that feed the gates (config, counters, touched rows) stay with
 * each engine; a gate that needs stored state takes it as an argument.
 */
import { FUTURE_AT_GRACE_MS } from './zoho.js'
import { WIRE_TABLES } from './registry.js'
import { periodKeyForPattern, seriesPatternOf } from '../../src/lib/seriesPatterns.js'
import { COLLECTIONS } from '../../src/lib/tables.js'
import type { StateChanges } from '../../src/lib/sync.js'
import { TABLE_WRITE_PERMISSION, CONFIG_KEY_WRITE_PERMISSION, isAdminPermissions } from '../../src/lib/permissions.js'
import { pageScope } from '../../src/lib/pages.js'
import type { ViewId, NumberingRule } from '../../src/types.js'
import type { Caller } from './auth.js'

export class Forbidden extends Error {
  readonly table: string
  constructor(table: string) {
    super(`You do not have permission to change ${table.replace(/_/g, ' ')}.`)
    this.table = table
  }
}

/** A well-formed request whose payload is not a legal StateChanges — refused
 *  with a 400 before any store call, unlike Forbidden (403) and Conflict (409). */
export class Malformed extends Error {}

/** Every table a commit may write. `vendor_types` and `order_lines` sat in
 *  TABLE_FOR with no CollectionSpec, so a change naming them used to slip past
 *  both permission loops untouched — ungated writes to live base tables. */
const WRITABLE_TABLES = new Set<string>(WIRE_TABLES)

/** How far a counter may jump FORWARD past what is stored, for everyone but
 *  administrators. A stale mirror heals by the size of the offline stint that
 *  stale-wrote it — documents a human actually keyed, one row each, pushed in
 *  chunks whose counter can land ahead of the rows — so the ceiling only has
 *  to clear what one device can honestly mint, and a hundred thousand documents
 *  keyed by hand on one phone is not that. Below the ceiling the write lands as
 *  it always did; above it the commit is refused whole, because a crafted
 *  {grn: 999999999} used to land unconditionally and stick until the next
 *  genuine rollover, minting absurd codes plant-wide. */
const COUNTER_JUMP_MAX = 100_000

/** The config keys whose values are numbers by contract — the tolerances, alert
 *  windows and label-stock dimensions. A crafted string under one of these
 *  travels device-to-device through app_config and lands where only a number
 *  is ever expected (the sticker sizes reach the print sheet's HTML raw), so
 *  the shape gate refuses it before anything is spent. */
export const CONFIG_NUMBER_KEYS = [
  'yieldTolerance',
  'pmTolerance',
  'expiryAlertDays',
  'complianceLeadDays',
  'lowStockPacks',
  'stickerWidthMm',
  'stickerHeightMm',
  'controlSampleDays',
] as const

/**
 * Pure shape validation, run before the throttle and any store call. The commit
 * endpoint is authenticated but its callers are browsers, and a crafted body
 * used to die in two expensive places instead: a missing `counters` threw a
 * TypeError in step 5 AFTER the row writes had landed (a partial commit with no
 * revision bump, re-thrown on every retry), and a body naming every table in
 * TABLE_FOR spent one pre-flight read per table against the plant's shared
 * read budget. Returns the refusal reason, or null when the shape is one the
 * honest client emits.
 */
export function validateChanges(changes: StateChanges): string | null {
  if (!Array.isArray(changes.tables)) return 'changes.tables must be an array.'
  if (changes.tables.length > 12) return 'A commit carries at most 12 table changes.'
  let rows = 0
  for (const change of changes.tables) {
    if (!change || typeof change.table !== 'string' || !WRITABLE_TABLES.has(change.table))
      return `changes.tables names a table this app does not write (${String(change?.table)}.)`
    const { upsert, remove } = change
    if (!Array.isArray(upsert) || !Array.isArray(remove)) return 'upsert and remove must be arrays.'
    rows += upsert.length + remove.length
    const seen = new Set<string>()
    for (const row of upsert) {
      if (!row || typeof row !== 'object') return 'upsert rows must be objects.'
      const id = (row as { id?: unknown }).id
      // a missing id stringifies to the literal key 'undefined' downstream —
      // a garbage row every device then syncs
      if (typeof id !== 'string' || !id.trim() || id === 'undefined') return 'upsert rows must carry a non-empty string id.'
      if (seen.has(id)) return `Duplicate row id ${id} in one commit.`
      seen.add(id)
    }
    for (const id of remove) if (typeof id !== 'string' || !id.trim()) return 'removes must be non-empty strings.'
    const expect = (change as { expect?: unknown }).expect
    if (expect !== undefined && (expect === null || typeof expect !== 'object' || Array.isArray(expect)))
      return 'expect must be an object.'
    // ledger lines and audit rows are insert-only: sync.ts emits no expect for
    // either (edits arrive as remove+insert), so one here is the crafted
    // rewrite shape — echo the stored row as the base, land the edit over it —
    // which no permission gate could refuse, because the payload looked honest.
    if ((change.table === 'ledger' || change.table === 'audits') && expect !== undefined)
      return `${change.table} rows are insert-only and carry no expect.`
    if (change.table === 'ledger' || change.table === 'audits') {
      for (const row of upsert) {
        const at = (row as { at?: unknown }).at
        if (at === undefined) continue
        // `at` feeds the snapshot watermarks, and a future one parks a watermark
        // where no delta bucket ever reaches — the sweep then serves empty
        // forever while looking healthy (the future row also leads every "when"
        // column ever rendered). Past stays free: backdated PM receipts are a
        // real, legal shape. The grace is the skew any honest phone is allowed;
        // an unparseable string poisons the lexicographic watermark worse than
        // a date, so it is refused with the same breath.
        const t = typeof at === 'string' ? Date.parse(at) : Number.NaN
        if (Number.isNaN(t) || t - Date.now() > FUTURE_AT_GRACE_MS)
          return `${change.table} rows must carry a parseable, not-future 'at'.`
      }
    }
  }
  if (rows > 16) return 'A commit carries at most 16 rows.'
  const counters = changes.counters
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) return 'changes.counters must be an object.'
  const counterKeys = Object.keys(counters)
  if (counterKeys.length > 16) return 'Too many counter keys in one commit.'
  for (const key of counterKeys) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) return `Bad counter key ${key}.`
    const value = (counters as Record<string, unknown>)[key]
    if (key.startsWith('period:')) {
      if (typeof value !== 'string' || value.length > 64) return `Counter ${key} must be a short string.`
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) {
      return `Counter ${key} must be a non-negative number.`
    }
  }
  const config = changes.config
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config)))
    return 'changes.config must be an object.'
  for (const key of CONFIG_NUMBER_KEYS) {
    const v = (config as Record<string, unknown> | undefined)?.[key]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v)))
      return `app_config ${key} must be a number.`
  }
  return null
}

/**
 * The one `period:<series>` value that may unlock a counter reset or write a
 * period row: the period the series' own PATTERN computes to on this clock.
 * Judged against the stored `app_config` numbering rules through the same leaf
 * the client mints with (src/lib/seriesPatterns.ts), because "is a current
 * period" alone is not a gate — many distinct strings read as current at once
 * ('YYYY:2026' and 'YYYY:2026|MM:10' both pass a token-by-token clock check in
 * October 2026), and any of them but the real one is a forged claim whose
 * re-issued numbers overwrite the original documents while their ledger lines
 * dangle. A series nobody configured runs the built-in default pattern; a
 * stored rule is merged exactly the way `ruleFor` merges it for the client.
 */
export function expectedPeriodOf(storedConfig: Map<string, string>, series: string): string {
  const raw = storedConfig.get('app_config') ?? '{}'
  let cached = numberingOfConfig.get(storedConfig)
  if (!cached || cached.raw !== raw) {
    let rules: { numbering?: NumberingRule[] } = {}
    try {
      rules = JSON.parse(raw) as { numbering?: NumberingRule[] }
    } catch {
      rules = {}
    }
    cached = { raw, rules }
    numberingOfConfig.set(storedConfig, cached)
  }
  const saved = cached.rules.numbering?.find((r) => r?.key === series)
  return periodKeyForPattern(seriesPatternOf(saved, series), new Date())
}

/** app_config parses per commit, not per counter key — one string, many series. */
const numberingOfConfig = new WeakMap<Map<string, string>, { raw: string; rules: { numbering?: NumberingRule[] } }>()

/** One row the commit would have clobbered; the client adopts the winning version. */
export interface RowConflict {
  table: string
  id: string
  /** The caller's base no longer matches the stored row — a genuine edit race. */
  kind: 'changed'
  /** The caller is inserting a key that already exists — a minted-code collision. */
  | 'exists'
}

export class Conflict extends Error {
  readonly conflicts: RowConflict[]
  constructor(conflicts: RowConflict[]) {
    super(
      conflicts.length
        ? `Another device saved ${conflicts.map((c) => c.id).join(', ')} first.`
        : 'Another device saved these records first.',
    )
    this.conflicts = conflicts
  }
}

/**
 * Canonical JSON equality: keys sorted, recursively. The client's migrate
 * rebuilds each state document in its own key order, while a row's Data JSON
 * keeps the order its creator first wrote it in — so two serializations of the
 * SAME document can differ in key order alone, and that difference must never
 * read as a conflict or as a change (a purchase-product edit 409'd forever
 * against its own base on the scratch base, 2026-10-06: `status` sat last in
 * the stored JSON, mid-object in the client's rebuilt copy). Values coming off
 * JSON.parse never hold undefined, so the undefined arm is unreachable in
 * practice and harmless anyway.
 */
export const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const record = v as Record<string, unknown>
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}

export const jsonEq = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

/**
 * Shared-device provenance (the audit's S3-12). The client stamps an audit
 * row's actor at QUEUE time (AppContext), but a shared tablet's offline queue
 * may be drained hours later by whoever signs in next — and the server stamps
 * the stored actor from the draining session, so the row used to say the
 * drainer did something they only submitted. The queued-by claim is not
 * evidence of anything (the payload could have written any name), but when it
 * is a well-formed email that DIFFERS from the drainer's, recording it in
 * Details is the honest trail: "who the tablet claims queued this" alongside
 * "who provably drained it". Malformed or matching claims are dropped — the
 * details string is not a free-text channel for the payload.
 */
export const provenanceDetails = (row: Record<string, unknown>, drainer: string): unknown => {
  const claimed = row.actor
  if (typeof claimed !== 'string') return row.details
  const trimmed = claimed.trim()
  if (!trimmed || trimmed === drainer) return row.details
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return row.details
  const suffix = `queued by ${trimmed}`
  return typeof row.details === 'string' && row.details ? `${row.details}; ${suffix}` : suffix
}

/**
 * The "<id>:<n>" version-token grammar's only home — the discipline every
 * engine's guarded writes and the compliance register's client-visible
 * baseVersion share. A token belongs to a row only when it carries that row's
 * own id before the colon and digits after it; anything else (empty, legacy,
 * malformed, another row's) is not a token this row may match.
 */
export function versionTokenOf(appId: string, n: number): string {
  return `${appId}:${n}`
}

/** The row's own token number, or null when the token is absent/foreign/malformed. */
export function versionNumberOf(appId: string, token: string): number | null {
  if (!token.startsWith(appId + ':')) return null
  const m = /^(\d+)$/.exec(token.slice(appId.length + 1))
  return m ? Number(m[1]) : null
}

/** What the permission gates concluded about a commit's ride-alongs — the two
 *  audit verdicts that cannot be settled until after the config gate reads
 *  what is stored (see gateConfigKeys and gateAuditRide). */
export interface RideVerdict {
  /** The caller's held permissions — the config and audit gates reuse the set. */
  held: Set<string>
  /** Whether the caller holds every admin permission (isAdminPermissions). */
  admin: boolean
  auditsNeedRide: boolean
  auditsRideOwned: boolean
}

/**
 * Step one of every commit — the RLS of this fork, all permission verdicts
 * that need nothing but the caller and the payload. Throws Forbidden on the
 * first refusal; returns the ride-along verdicts the later gates consume.
 */
export function gateTablePermissions(caller: Caller, changes: StateChanges): RideVerdict {
  const held = new Set(caller.permissions)
  const holdsAny = (perm: string | readonly string[]) =>
    typeof perm === 'string' ? held.has(perm) : perm.some((p) => held.has(p))
  for (const change of changes.tables) {
    // fail closed: a table name with no CollectionSpec used to slip both
    // permission loops untouched — vendor_types and order_lines were writable
    // by any signed-in caller
    if (!WRITABLE_TABLES.has(change.table)) throw new Forbidden(change.table)
    const spec = COLLECTIONS.find((c) => c.table === change.table)
    if (spec?.writePermission && !holdsAny(spec.writePermission)) throw new Forbidden(change.table)
  }
  // Page narrowing: a caller holding any page.* slug is scoped to those pages,
  // and the day's work stops being open — they may write only the tables whose
  // page they hold. The default caller (no page permissions, the operator) is
  // untouched by THIS loop; a full administrator is simply a caller holding
  // every page. The BFF is what makes this real: the UI's nav hiding a page
  // would matter little to a crafted POST without it.
  const pages = pageScope(caller.permissions)
  // The one exemption below the top gate: a full administrator, for whom
  // housekeeping (a bare counter alignment, trail cleanup, ledger line
  // removals) is a page like any other. Everyone else — the scoped clerks AND
  // the open-tier operator — faces the ride-along gates: those gates used to
  // live inside the scoped branch only, so a caller holding no page slugs at
  // all walked straight past them, and the operator tier could post bare audit
  // rows, bare ledger lines, remove ledger history and mint counters with no
  // document behind any of it — precisely the tables where integrity lives.
  const admin = isAdminPermissions([...held])
  const holdsPage = (page: ViewId | readonly ViewId[]) =>
    pages !== null && (typeof page === 'string' ? pages.has(page) : page.some((p) => pages.has(p)))
  if (pages && !admin) {
    for (const change of changes.tables) {
      const spec = COLLECTIONS.find((c) => c.table === change.table)
      if (spec?.page && !holdsPage(spec.page)) throw new Forbidden(change.table)
    }
  }
  // Audits inserts are the third ride-along, and the only one whose verdict is
  // not settled here: an audit row may also ride a config change, and whether
  // any config key actually moved is known only after the config gate below has
  // read what is stored. These two carry this block's verdict out to the
  // refusal that stands after that gate.
  let auditsNeedRide = false
  let auditsRideOwned = false
  if (!admin) {
    // Ride-alongs: ledger lines, audit inserts and counter moves are part of a
    // document's posting, owned by no page. Every non-admin caller may write
    // them only alongside a collection change they hold — otherwise a crafted
    // POST moves stock, resets numbering or files audit rows through the tables
    // no page gate covers. Masters tables carry no `page`, but their
    // writePermission IS the page that owns them (the top gate already demanded
    // it), and saving a master mints its number and files its audit row exactly
    // like a posting — without that arm the suppliers clerk's add-vendor commit
    // (vendors row + audit insert + counters{vendor}) owned neither ride and
    // was refused blaming "ledger", a table nobody edited, wedging their whole
    // queue.
    const ownsCollectionChange = changes.tables.some((t) => {
      const spec = COLLECTIONS.find((c) => c.table === t.table)
      if (!spec || !(t.upsert?.length || t.remove?.length)) return false
      // the day's work: a scoped caller needs the page ticked; the operator
      // tier holds every open-tier table the way it holds their pages — by
      // holding nothing at all
      if (spec.page) return !pages || holdsPage(spec.page)
      return !!spec.writePermission && holdsAny(spec.writePermission)
    })
    const ledgerRemove = changes.tables.some((t) => t.table === 'ledger' && !!t.remove?.length)
    const ledgerWrites = changes.tables.some(
      (t) => t.table === 'ledger' && (t.upsert?.length || t.remove?.length),
    )
    // counters — the running numbers and the period:* rows that gate their
    // resets alike — need a document behind them: a period row is numbering
    // state, and rewriting it resets a series plant-wide
    const counterWrites = Object.keys(changes.counters || {}).length > 0
    // One honest exception: moving stock between rooms is the Storage page's
    // own job, and it posts ledger lines and an audit row while owning no
    // collection row to hang them on — so that page stands in for one. The
    // trail row is load-bearing: a move always files the entry that names it,
    // and without requiring it the operator's bare-lines commit (lines naming
    // no posting, nothing in the trail) would ride this allowance too. A holder
    // may upsert ledger lines with no collection change; the operator tier may
    // too, because Storage is an open-tier page they hold like the rest.
    // Removals and counters still need a document behind them, because a move
    // never deletes history and never mints a number.
    const moveTrail = changes.tables.some((t) => t.table === 'audits' && !!t.upsert?.length)
    const stockMove = ledgerWrites && !ledgerRemove && moveTrail && (holdsPage('storage') || !pages)
    if ((ledgerWrites && !ownsCollectionChange && !stockMove) || (counterWrites && !ownsCollectionChange)) {
      throw new Forbidden('ledger')
    }
    // Audit inserts ride the same two verdicts — a document's posting files its
    // audit row, and so does the Storage move above. The config ride
    // (saveConfig, saveStickerSize) is judged after the config gate; the
    // refusal itself is thrown below it, not here.
    auditsNeedRide = changes.tables.some((t) => t.table === 'audits' && !!t.upsert?.length)
    auditsRideOwned = ownsCollectionChange || stockMove
  }
  return { held, admin, auditsNeedRide, auditsRideOwned }
}

/**
 * The config gate: config is one stored row, so its gate diffs the incoming
 * object against what is stored and judges only the keys that actually
 * changed — sync sends the whole config, and a lab tester may carry the
 * numbering series unchanged in their payload without it reading as an
 * attempt to change it. A key listed in CONFIG_KEY_WRITE_PERMISSION passes on
 * any one of its permissions (the report types are the lab's own); every other
 * key needs the Settings page. No stored row means every key is new, and
 * first-time config is the Settings page's business. Returns whether any key
 * genuinely moved under a permission this caller holds — the third honest
 * ride for an audit insert (a settings change files its own audit row with no
 * collection change behind it).
 */
export function gateConfigKeys(
  changes: StateChanges,
  storedConfig: Map<string, string>,
  held: Set<string>,
): boolean {
  // Set when a config key genuinely moved under a permission this caller holds
  let ownsConfigChange = false
  if (changes.config) {
    // app_config is in the very map handed in — the config, counter and
    // revision reads share one sweep per commit.
    let stored: Record<string, unknown> = {}
    try {
      stored = JSON.parse(storedConfig.get('app_config') ?? '{}') as Record<string, unknown>
    } catch {
      stored = {}
    }
    // The union of keys, not just the payload's: a key the payload drops is a
    // change too (a partial payload must not read as "leave the rest alone" —
    // the write replaces the whole row, so it would wipe what it omits).
    for (const key of new Set([...Object.keys(changes.config), ...Object.keys(stored)])) {
      if (jsonEq(stored[key], changes.config[key])) continue // key order alone is not a change
      const gate =
        (CONFIG_KEY_WRITE_PERMISSION as Record<string, readonly string[] | undefined>)[key] ??
        [TABLE_WRITE_PERMISSION.app_config]
      if (!gate.some((p) => held.has(p))) throw new Forbidden(`app_config ${key}`)
      ownsConfigChange = true
    }
  }
  return ownsConfigChange
}

/**
 * The audits ride-along refusal, held until after the config gate because the
 * config ride is only known there: an audit insert a scoped caller files must
 * stand on a collection change whose page they hold, the Storage page's move
 * shape, or a config key that genuinely moved under them. Anything else is a
 * crafted audit-only POST — the trail is evidence, not a page anyone may write.
 */
export function gateAuditRide(rides: RideVerdict, ownsConfigChange: boolean): void {
  if (rides.auditsNeedRide && !rides.auditsRideOwned && !ownsConfigChange) throw new Forbidden('audits')
}

/** Audit deletions carry their own gate: the trail is insert-only for callers
 *  without the Audit page (sync.ts only ever emits audit removals from
 *  admin-side edits). */
export function gateAuditRemove(changes: StateChanges, held: Set<string>): void {
  const auditRemove = changes.tables.some((t) => t.table === 'audits' && t.remove?.length)
  if (auditRemove && !held.has(TABLE_WRITE_PERMISSION.audits)) throw new Forbidden('audits')
}

/**
 * Counter vaulting is refused with the other permission gates, before any
 * write lands — a refused commit is whole, rows included. `storedNext` is the
 * evidence the Counters table holds; a series absent from it has no ceiling
 * to clear (the write is an insert, not a jump).
 */
export function gateCounterJumps(counters: StateChanges['counters'], storedNext: Map<string, number>, admin: boolean): void {
  for (const series of Object.keys(counters).filter((k) => !k.startsWith('period:'))) {
    const stored = storedNext.get(series)
    if (stored !== undefined && (Number(counters[series]) || 0) > stored + COUNTER_JUMP_MAX && !admin)
      throw new Forbidden('counters')
  }
}

/**
 * The `expect` pre-flight, pure once the stored documents are handed in:
 * `storedDocAt(table, id)` answers the stored row's parsed document —
 * undefined when the row does not exist, null when it exists but holds no
 * parsable document (a hand-staged row; writing such a row is what makes it
 * readable, so it never counts as a conflict), the document otherwise. All-or-
 * nothing happens here, before any write, so a refused race never leaves half
 * a posting. Audits are skipped: they are insert-only and their existence is
 * checked at write time.
 */
export function detectRowConflicts(
  changes: StateChanges,
  storedDocAt: (table: string, id: string) => Record<string, unknown> | null | undefined,
): RowConflict[] {
  const conflicts: RowConflict[] = []
  for (const change of changes.tables) {
    if (change.table === 'audits') continue // insert-only: existence is checked at write time
    const spec = COLLECTIONS.find((c) => c.table === change.table) ?? null

    for (const row of change.upsert) {
      const appId = String(row.id)
      const storedDoc = storedDocAt(change.table, appId)
      if (storedDoc === undefined) {
        // The store held this row (a non-null expect is only ever emitted for a
        // row the client's base contained) but the table no longer does:
        // somebody deleted it after this client's read. Letting the upsert
        // through would resurrect a document an administrator removed, with
        // this client never the wiser — refuse as a change instead, so the
        // conflict path adopts the deletion. No expect means the client never
        // saw the row: a plain insert, not a resurrection.
        if (change.expect?.[appId] != null) conflicts.push({ table: change.table, id: appId, kind: 'changed' })
        continue
      }
      if (storedDoc === null) continue
      const incoming = spec ? ((row as { data: Record<string, unknown> }).data ?? {}) : row
      if (jsonEq(storedDoc, incoming)) continue // a retry of our own write — skipped at write time, never a conflict
      const expected = change.expect?.[appId]
      if (expected) {
        const expectedDoc = spec ? ((expected as { data: Record<string, unknown> }).data ?? {}) : expected
        if (!jsonEq(storedDoc, expectedDoc)) conflicts.push({ table: change.table, id: appId, kind: 'changed' })
      } else {
        // the caller never saw this row, yet it exists with different content:
        // either a minted code landed on another device's document, or a null-base
        // push would replace live work — both refused
        conflicts.push({ table: change.table, id: appId, kind: 'exists' })
      }
    }
  }
  return conflicts
}
