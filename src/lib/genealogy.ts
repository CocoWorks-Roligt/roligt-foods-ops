/**
 * The genealogy fold — the pure BFS behind GET /api/genealogy (ARCHITECTURE
 * §4). Server-side only in practice, but isomorphic in shape: documents in,
 * {nodes, edges, truncated} out, zero I/O, so the traceability page can fold
 * the same graph client-side from its snapshot and get the same answer.
 *
 * Edges are folded from the documents themselves — receipt→run inputs (source
 * lots), blend inputs (bulk lots), run→packing, packing→dispatch, and the
 * order/shipment/challan facts that hang off dispatches. Every edge points the
 * way material flows; `relation` names the fact:
 *   input     the from-node's stock was consumed making the to-node
 *   output    the from-node's output went out on the to-node
 *   fulfils   the from-node (a dispatch) fulfils the to-node (its order)
 *   ships     the from-node rides on the to-node (its shipment)
 *   challan_of the from-node is the challan of the to-node
 */
import type {
  GenealogyDirection,
  GenealogyEdge,
  GenealogyNode,
  GenealogyNodeKind,
  GenealogyResponse,
  GenealogySeed,
  Shipment,
} from './contracts.ts'
import type { Batch, Dispatch, Grn, Order, PackingRun } from '../types.ts'

export const GENEALOGY_MAX_DEPTH = 12
export const GENEALOGY_DEFAULT_DEPTH = 5

/** The documents the fold reads — only what the trace needs, never the plant. */
export interface GenealogyDocs {
  grns: readonly Grn[]
  batches: readonly Batch[]
  packingRuns: readonly PackingRun[]
  orders: readonly Order[]
  dispatches: readonly Dispatch[]
  /** Shipments when the collection exists (flag-off base: absent, []). */
  shipments?: readonly Shipment[]
}

const node = (kind: GenealogyNodeKind, id: string, label: string, at?: string): GenealogyNode => ({
  id: `${kind}:${id}`,
  kind,
  label,
  ...(at ? { at } : {}),
})

/**
 * The seed resolved to its starting node keys — `LOT:` a lot (a receipt's raw
 * lot, or a batch's own lot: bulk and packs live on the batch id), `RUN:` a
 * batch id, `ORD:` an order id. An unresolvable seed answers [] and the route
 * 404s.
 */
export function seedNodes(seed: GenealogySeed, docs: GenealogyDocs): string[] {
  const at = seed.indexOf(':')
  const kind = seed.slice(0, at)
  const v = seed.slice(at + 1).trim()
  const out: string[] = []
  if (kind === 'LOT') {
    for (const g of docs.grns) if (g.lot === v) out.push(`grn:${g.id}`)
    for (const b of docs.batches) if (b.id === v) out.push(`batch:${b.id}`)
  } else if (kind === 'RUN') {
    for (const b of docs.batches) if (b.id === v) out.push(`batch:${b.id}`)
  } else if (kind === 'ORD') {
    for (const o of docs.orders) if (o.id === v) out.push(`order:${o.id}`)
  }
  return [...new Set(out)]
}

/** Every edge the documents can name, folded once. Nodes travel with them. */
export function foldEdges(docs: GenealogyDocs): { nodes: Map<string, GenealogyNode>; edges: GenealogyEdge[] } {
  const nodes = new Map<string, GenealogyNode>()
  const edges: GenealogyEdge[] = []
  const add = (n: GenealogyNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n)
  }
  const link = (from: GenealogyNode, to: GenealogyNode, relation: GenealogyEdge['relation']) => {
    add(from)
    add(to)
    edges.push({ from: from.id, to: to.id, relation })
  }

  for (const g of docs.grns) add(node('grn', g.id, `${g.lot} — ${g.farmerName || g.productName || g.id}`, g.date))
  for (const b of docs.batches) {
    add(node('batch', b.id, `${b.id}${b.kind ? ` (${b.kind})` : ''}`, b.date))
  }
  for (const p of docs.packingRuns) add(node('packing', p.id, p.id, p.date))
  for (const o of docs.orders) add(node('order', o.id, `${o.customerName} — ${o.id}`, o.date))
  for (const s of docs.shipments ?? []) add(node('shipment', s.id, s.id, s.times?.created))

  const batchById = new Map(docs.batches.map((b) => [b.id, b]))
  const grnByLot = new Map(docs.grns.map((g) => [g.lot, g]))
  // SKU → the packing runs on this lot that filled it (time-order picks the
  // nearest run when several share a lot — dispatchRuns' own heuristic)
  const packsBySku = new Map<string, PackingRun[]>()
  for (const p of docs.packingRuns) {
    for (const line of p.lines ?? []) {
      const list = packsBySku.get(line.sku) ?? []
      list.push(p)
      packsBySku.set(line.sku, list)
    }
  }

  for (const b of docs.batches) {
    for (const s of b.sourceLines ?? []) {
      const grn = grnByLot.get(s.lot)
      if (grn) link(node('grn', grn.id, `${grn.lot} — ${grn.farmerName || grn.productName || grn.id}`, grn.date), node('batch', b.id, b.id, b.date), 'input')
    }
    for (const bl of b.blendLines ?? []) {
      if (batchById.has(bl.lot)) {
        link(node('batch', bl.lot, bl.lot), node('batch', b.id, b.id), 'input')
      }
    }
  }
  for (const p of docs.packingRuns) {
    if (batchById.has(p.batchId)) {
      link(node('batch', p.batchId, p.batchId), node('packing', p.id, p.id), 'input')
    }
  }
  for (const d of docs.dispatches) {
    add(node('dispatch', d.id, `${d.sku} × ${d.qty} — ${d.id}`, d.dispatchTime))
    const runs = (packsBySku.get(d.sku) ?? []).filter((r) => r.batchId === d.batchId)
    if (runs.length) {
      link(node('packing', runs[runs.length - 1].id, runs[runs.length - 1].id), node('dispatch', d.id, d.id), 'output')
    } else if (batchById.has(d.batchId)) {
      link(node('batch', d.batchId, d.batchId), node('dispatch', d.id, d.id), 'output')
    }
    if (d.orderId) link(node('dispatch', d.id, d.id), node('order', d.orderId, d.orderId), 'fulfils')
    add(node('challan', d.challan, d.challan))
    link(node('challan', d.challan, d.challan), node('dispatch', d.id, d.id), 'challan_of')
  }
  for (const s of docs.shipments ?? []) {
    for (const id of s.dispatchIds ?? []) {
      link(node('dispatch', id, id), node('shipment', s.id, s.id), 'ships')
    }
  }
  return { nodes, edges }
}

/**
 * The walk. BFS from the seed along the folded edges — `forward` follows
 * from→to (downstream: what this lot became), `backward` follows to→from
 * (upstream: what went into it). Depth caps the hops; `truncated` says whether
 * the frontier was cut short, so the UI says so instead of implying an end.
 */
export function traceGenealogy(
  seed: GenealogySeed,
  dir: GenealogyDirection,
  depth: number,
  docs: GenealogyDocs,
): GenealogyResponse {
  const { nodes, edges } = foldEdges(docs)
  const start = seedNodes(seed, docs)
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    const [a, b] = dir === 'forward' ? [e.from, e.to] : [e.to, e.from]
    const list = adj.get(a) ?? []
    list.push(b)
    adj.set(a, list)
  }
  const seen = new Set(start)
  let frontier = [...start]
  let truncated = false
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of adj.get(id) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
      }
    }
    if (next.length && hop + 1 >= depth) truncated = true
    frontier = next
  }
  if (frontier.length) truncated = true
  const outNodes = [...seen].filter((id) => nodes.has(id)).map((id) => nodes.get(id)!)
  const outIds = new Set(outNodes.map((n) => n.id))
  const outEdges = edges.filter((e) => outIds.has(e.from) && outIds.has(e.to))
  return { nodes: outNodes, edges: outEdges, truncated }
}
