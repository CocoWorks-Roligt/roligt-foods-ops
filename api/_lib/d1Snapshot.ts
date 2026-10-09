/**
 * The D1 read engine — the whole plant in ONE batch.
 *
 * The Zoho snapshot path spends its life managing a 26-reads-per-minute budget
 * (substrate caches, delta watermarks, burst seeding); D1 has no such budget, so
 * this arm is one batch of 26 SELECTs — every wire collection, the counters and
 * meta — that answers in ~420 ms (the Phase-0 probe's measurement). Because a
 * REST batch is a single transaction (pinned live by the same probe), the meta
 * read that carries the revision is ATOMIC with the row reads around it: the
 * assembled snapshot installs under exactly the token its own rows were read
 * at, and the torn-mix window the Zoho engine closes with its two-observation
 * rule cannot open here. One observation IS the proof.
 *
 * Two small memos absorb the read traffic anyway — not for a budget, for
 * latency and rows_read economics on the free tier:
 *
 *   - a 4-second revision memo (single-flighted), the same shape the poll
 *     route's Zoho arm has: every client polls every 20 s, and a warm instance
 *     serves those bursts without a round trip;
 *   - a revision-keyed STATE memo: nothing changes the plant except a write,
 *     and every write bumps the revision LAST inside its own atomic batch, so
 *     a snapshot read at token R is exactly what a fresh batch at R would
 *     return. A moved token self-invalidates the memo — no explicit cache
 *     invalidation exists on this side of the seam at all.
 */
import type { D1Client } from './d1.js'
import { WIRE_TABLES, stateKeyFor } from './registry.js'
import { ledgerFromRow, auditFromRow } from '../../src/lib/tables.js'
import { assembleState, type Assembled, type ParsedSnapshot } from './snapshot.js'

/** One documents row as the batch hands it back (json is the stored document, byte-for-byte). */
interface DocRow {
  id: string
  json: string
}

/** The batch's per-statement rows, loosely typed — each SELECT fills its own columns. */
interface BatchRow {
  id?: unknown
  json?: unknown
  series?: unknown
  next?: unknown
  setting?: unknown
  value?: unknown
}

/** Page size per collection — 10k rows plus one overflow sentinel. */
const PAGE = 10_000

const SELECT_PAGE = 'SELECT id, json FROM documents WHERE collection = ? ORDER BY id LIMIT '
const SELECT_AFTER = 'SELECT id, json FROM documents WHERE collection = ? AND id > ? ORDER BY id LIMIT '

const docRowOf = (r: BatchRow): DocRow => ({ id: String(r.id ?? ''), json: typeof r.json === 'string' ? r.json : '' })

/**
 * The documents/counters/meta rows → ParsedSnapshot, mirroring parseZohoRows
 * row for row: a collection read back with ZERO rows was deliberately emptied
 * ([] — migrateState cannot refill it from seed), rows that hold no parsable
 * document are skipped, ledger and audits decode through their flat-row
 * mappers (their json stores the flat shape, not a nested document), and a
 * period:* key in counters is remnant corruption the meta read owns instead.
 */
function parseD1Rows(tables: Record<string, DocRow[]>, counterRows: BatchRow[], metaRows: BatchRow[]): ParsedSnapshot {
  const docs: Partial<Record<string, Record<string, unknown>[]>> = {}
  for (const supa of WIRE_TABLES) {
    const key = stateKeyFor(supa)
    if (!key) continue
    const rows = tables[supa]
    if (!rows) continue // never queried — absent, not wiped
    const wiped = rows.length === 0
    const fromRow = supa === 'ledger' ? ledgerFromRow : supa === 'audits' ? auditFromRow : null
    const parsed = wiped
      ? []
      : rows
          .map((r) => {
            try {
              const doc = JSON.parse(r.json) as unknown
              if (!doc || typeof doc !== 'object') return null // parses, but is no document (rowToDoc's null contract)
              return fromRow ? fromRow(doc as Record<string, unknown>) : (doc as Record<string, unknown>)
            } catch {
              return null // a hand-written row no engine path can produce — skipped, never fatal
            }
          })
          .filter((d): d is Record<string, unknown> => d !== null)
    if (wiped || parsed.length) docs[key] = parsed
  }
  const counters: Record<string, number> = {}
  for (const r of counterRows) {
    const key = String(r.series ?? '')
    if (!key) continue
    if (key.startsWith('period:')) continue // periods live in meta's text values
    counters[key] = Number(r.next) || 0
  }
  const config: Record<string, string> = {}
  for (const r of metaRows) {
    const setting = String(r.setting ?? '')
    if (setting) config[setting] = String(r.value ?? '')
  }
  return { docs, counters, config }
}

/** The whole plant, one batch — installed under the revision its own meta read carried. */
async function readAllD1(d1: D1Client): Promise<Assembled> {
  const first = await d1.batch<BatchRow>([
    ...WIRE_TABLES.map((t) => ({ sql: `${SELECT_PAGE}${PAGE + 1}`, params: [t] })),
    { sql: 'SELECT series, next FROM counters' },
    { sql: 'SELECT setting, value FROM meta' },
  ])
  const tables: Record<string, DocRow[]> = {}
  const pending: { collection: string; after: string }[] = []
  WIRE_TABLES.forEach((t, i) => {
    const page = first[i].results.map(docRowOf)
    if (page.length > PAGE) {
      // a collection outgrew the page — continue by keyset until a page comes back short
      tables[t] = page.slice(0, PAGE)
      pending.push({ collection: t, after: page[PAGE - 1].id })
    } else {
      tables[t] = page
    }
  })
  while (pending.length) {
    const wave = pending.splice(0)
    const more = await d1.batch<BatchRow>(wave.map((p) => ({ sql: `${SELECT_AFTER}${PAGE + 1}`, params: [p.collection, p.after] })))
    wave.forEach((p, i) => {
      const page = more[i].results.map(docRowOf)
      const list = tables[p.collection]
      if (page.length > PAGE) {
        list.push(...page.slice(0, PAGE))
        pending.push({ collection: p.collection, after: page[PAGE - 1].id })
      } else {
        list.push(...page)
      }
    })
  }
  const snap = assembleState(parseD1Rows(tables, first[WIRE_TABLES.length].results, first[WIRE_TABLES.length + 1].results))
  stateMemo = { revision: snap.revision, snap }
  return snap
}

// ---- the two memos (see the module header) ----

/** The last assembled plant, keyed by the token it was read at. */
let stateMemo: { revision: string; snap: Assembled } | null = null
/** The full read in flight, shared by every concurrent caller. */
let stateReading: Promise<Assembled> | null = null

let revisionMemo: { value: string; at: number } | null = null
/** The revision read in flight, shared by every concurrent poller. */
let revisionReading: Promise<string> | null = null
const REVISION_MEMO_TTL_MS = 4_000

/** Reads the plant: the memo when the revision has not moved, one batch otherwise. */
export async function readSnapshotD1(d1: D1Client): Promise<Assembled> {
  const revision = await readRevisionD1(d1)
  if (stateMemo && stateMemo.revision === revision) return stateMemo.snap
  if (!stateReading) {
    stateReading = readAllD1(d1).finally(() => {
      stateReading = null
    })
  }
  return stateReading
}

/** Just the revision token — the poll route's read, memoized for a few seconds. */
export async function readRevisionD1(d1: D1Client): Promise<string> {
  if (revisionMemo && Date.now() - revisionMemo.at < REVISION_MEMO_TTL_MS) return revisionMemo.value
  if (!revisionReading) {
    revisionReading = d1
      .query<{ value?: unknown }>("SELECT value FROM meta WHERE setting = 'app_revision'")
      .then((rows) => {
        const value = typeof rows[0]?.value === 'string' && rows[0].value ? rows[0].value : '0'
        revisionMemo = { value, at: Date.now() }
        return value
      })
      .finally(() => {
        revisionReading = null
      })
  }
  return revisionReading
}

/**
 * What a write that just bumped the revision tells the memos: the poll serves
 * the fresh token at once, and the state memo's key no longer matches, so the
 * next snapshot read re-batches. There is deliberately no bare invalidation on
 * this side — the token IS the invalidation.
 */
export function noteD1Revision(token: string): void {
  revisionMemo = { value: token, at: Date.now() }
}

/** Test isolation — the memos are module state. */
export function resetD1Caches(): void {
  stateMemo = null
  stateReading = null
  revisionMemo = null
  revisionReading = null
}
