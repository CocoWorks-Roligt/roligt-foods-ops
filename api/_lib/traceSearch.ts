/**
 * The GET-side B3 endpoints' reads: genealogy and search. Both answer any
 * signed-in caller EXCEPT a delivery agent (RBAC.md §c — §(d) strips search
 * and genealogy from that role entirely), both read D1 with json_extract over
 * documents, and both honor the snapshot's page-based withholding: a caller
 * who cannot read a collection through /api/snapshot cannot learn its rows
 * here either.
 */
import type { D1Client } from './d1.js'
import type { Caller } from './auth.js'
import { DomainError, isDeliveryAgent, parseDoc } from './domain.js'
import { withheldForCaller } from './snapshot.js'
import {
  GENEALOGY_DEFAULT_DEPTH,
  GENEALOGY_MAX_DEPTH,
  traceGenealogy,
  seedNodes,
  type GenealogyDocs,
} from '../../src/lib/genealogy.js'
import type {
  GenealogyDirection,
  GenealogyResponse,
  GenealogySeed,
  SearchResponse,
  SearchResult,
  Shipment,
} from '../../src/lib/contracts.js'
import type { Batch, Dispatch, Grn, Order, PackingRun } from '../../src/types.js'

/** RBAC.md §c: any signed-in except delivery_agent. */
export function assertTraceAllowed(caller: Caller): void {
  if (isDeliveryAgent(caller.permissions)) {
    throw new DomainError(403, 'Search and genealogy are not part of the delivery app.', 'role_allowed')
  }
}

// ── GET /api/genealogy ───────────────────────────────────────────────────────

/** One seed as the routes accept it: LOT:/RUN:/ORD: + a non-empty id. */
export function parseGenealogyQuery(q: Record<string, unknown>): {
  seed: GenealogySeed
  dir: GenealogyDirection
  depth: number
} {
  const seed = String(q.seed ?? '')
  if (!/^(LOT|RUN|ORD):.+$/.test(seed)) {
    throw new DomainError(400, 'Seed the trace with LOT:…, RUN:… or ORD:….', 'invalid_seed')
  }
  const dir = String(q.dir ?? 'forward')
  if (dir !== 'forward' && dir !== 'backward') {
    throw new DomainError(400, 'Direction is forward or backward.', 'invalid_dir')
  }
  const rawDepth = Number(q.depth ?? GENEALOGY_DEFAULT_DEPTH)
  const depth = Number.isFinite(rawDepth) && rawDepth >= 1 ? Math.min(Math.floor(rawDepth), GENEALOGY_MAX_DEPTH) : GENEALOGY_DEFAULT_DEPTH
  return { seed: seed as GenealogySeed, dir, depth }
}

/** The walk over live documents — reads only the collections the fold names. */
export async function genealogyOf(d1: D1Client, caller: Caller, q: Record<string, unknown>): Promise<GenealogyResponse> {
  assertTraceAllowed(caller)
  const { seed, dir, depth } = parseGenealogyQuery(q)
  const [grns, batches, packingRuns, orders, dispatches, shipments] = await Promise.all([
    readCollection<Grn>(d1, 'grns'),
    readCollection<Batch>(d1, 'batches'),
    readCollection<PackingRun>(d1, 'packing_runs'),
    readCollection<Order>(d1, 'orders'),
    readCollection<Dispatch>(d1, 'dispatches'),
    readCollection<Shipment>(d1, 'shipments'),
  ])
  const docs: GenealogyDocs = { grns, batches, packingRuns, orders, dispatches, shipments }
  if (!seedResolves(seed, docs)) {
    throw new DomainError(404, `Nothing in the plant answers ${seed}.`, 'seed_not_found')
  }
  return traceGenealogy(seed, dir, depth, docs)
}

/** Does the seed name anything at all? The 404 the route answers. */
function seedResolves(seed: GenealogySeed, docs: GenealogyDocs): boolean {
  return seedNodes(seed, docs).length > 0
}

async function readCollection<T>(d1: D1Client, collection: string): Promise<T[]> {
  const rows = await d1.query<{ json: unknown }>(`SELECT json FROM documents WHERE collection = ?`, [collection])
  const out: T[] = []
  for (const r of rows) {
    const doc = parseDoc<T>(r.json)
    if (doc) out.push(doc)
  }
  return out
}

// ── GET /api/search ──────────────────────────────────────────────────────────

/** q, trimmed and LIKE-escaped; too short a needle answers nothing, not an error. */
export function parseSearchQuery(q: Record<string, unknown>): string {
  return String(q.q ?? '').trim()
}

const MAX_PER_KIND = 5

/** LIKE's own wildcards, escaped so a q of "100%" is a literal. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * The global search: prefix/substring over lot ids, batch ids, order ids,
 * challan numbers, customer and vendor names and storage locations — grouped
 * top hits per kind (max 5). A collection the caller's snapshot withholds is
 * not searched: the same page-based read withholding /api/snapshot applies.
 * (PO numbers: contracts SEARCH_KINDS has no 'po' kind — reported as a gap in
 * the B3 handoff, not worked around with a lying kind.)
 */
export async function searchFor(d1: D1Client, caller: Caller, q: Record<string, unknown>): Promise<SearchResponse> {
  assertTraceAllowed(caller)
  const needle = parseSearchQuery(q)
  if (needle.length < 2) return { results: [] }
  const like = `%${escapeLike(needle)}%`
  const withheld = new Set(withheldForCaller(caller.permissions))
  const results: SearchResult[] = []

  const run = async (
    opts: {
      kind: SearchResult['kind']
      /** The COLLECTIONS state key the page gate reads — masters pass ''. */
      withheldKey?: string
      collection: string
      jsonField: string
      label: (row: Record<string, unknown>) => { id: string; label: string; sublabel?: string; href: string }
    },
  ): Promise<void> => {
    if (opts.withheldKey && withheld.has(opts.withheldKey)) return
    const rows = await d1.query<{ json: unknown }>(
      `SELECT json FROM documents WHERE collection = ? AND json_extract(json, ?) LIKE ? ESCAPE '\\' LIMIT 25`,
      [opts.collection, `$.${opts.jsonField}`, like],
    )
    for (const row of rows.slice(0, MAX_PER_KIND)) {
      const doc = parseDoc<Record<string, unknown>>(row.json)
      if (!doc) continue
      results.push({ kind: opts.kind, ...opts.label(doc) })
    }
  }

  await Promise.all([
    run({
      kind: 'lot',
      withheldKey: 'grns',
      collection: 'grns',
      jsonField: 'lot',
      label: (d) => ({
        id: String(d.lot ?? ''),
        label: String(d.lot ?? ''),
        sublabel: `Receipt ${d.id ?? ''} — ${d.farmerName || d.productName || ''}`,
        href: `/procurement?lot=${encodeURIComponent(String(d.lot ?? ''))}`,
      }),
    }),
    run({
      kind: 'batch',
      withheldKey: 'batches',
      collection: 'batches',
      jsonField: 'id',
      label: (d) => ({
        id: String(d.id ?? ''),
        label: String(d.id ?? ''),
        sublabel: String(d.kind ?? 'Extraction'),
        href: `/production?batch=${encodeURIComponent(String(d.id ?? ''))}`,
      }),
    }),
    run({
      kind: 'order',
      withheldKey: 'orders',
      collection: 'orders',
      jsonField: 'id',
      label: (d) => ({
        id: String(d.id ?? ''),
        label: String(d.id ?? ''),
        sublabel: `${d.customerName ?? ''} — ${d.status ?? ''}`,
        href: `/orders?order=${encodeURIComponent(String(d.id ?? ''))}`,
      }),
    }),
    run({
      kind: 'challan',
      withheldKey: 'dispatches',
      collection: 'dispatches',
      jsonField: 'challan',
      label: (d) => ({
        id: String(d.challan ?? ''),
        label: String(d.challan ?? ''),
        sublabel: `${d.sku ?? ''} × ${d.qty ?? 0} — ${d.customerName ?? ''}`,
        href: `/dispatch?challan=${encodeURIComponent(String(d.challan ?? ''))}`,
      }),
    }),
    run({
      kind: 'customer',
      collection: 'customers',
      jsonField: 'name',
      label: (d) => ({
        id: String(d.id ?? ''),
        label: String(d.name ?? ''),
        href: `/customers?customer=${encodeURIComponent(String(d.id ?? ''))}`,
      }),
    }),
    run({
      kind: 'vendor',
      collection: 'vendors',
      jsonField: 'name',
      label: (d) => ({
        id: String(d.id ?? ''),
        label: String(d.name ?? ''),
        href: `/vendors?vendor=${encodeURIComponent(String(d.id ?? ''))}`,
      }),
    }),
    run({
      kind: 'storageLocation',
      collection: 'storage_locations',
      jsonField: 'name',
      label: (d) => ({
        id: String(d.id ?? ''),
        label: String(d.name ?? ''),
        href: `/storage?location=${encodeURIComponent(String(d.id ?? ''))}`,
      }),
    }),
  ])
  return { results }
}
