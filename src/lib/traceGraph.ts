/**
 * A traced chain as a network: every record a node, every "came from" an edge.
 *
 * The Traceability screen reads a chain as one row of stages, which suits a straight
 * line and not the shape a trace usually has — a receipt pressed into a batch whose
 * water went to three runs and whose malai went to a fourth, a melange drawing on two
 * batches at once. This lays the same records out as a graph: the nodes are the records
 * the trace found, the edges come from `linkedRecords`, and each node carries the column
 * it belongs in, counted in steps from the start of the chain.
 *
 * Pure — no React, no d3 — so the shape of a trace is worked out here and the chart only
 * decides where to draw it.
 */

import { batchKind, batchLabel } from './batches'
import { docHref, KIND_LABEL, linkedRecords, type DocKind } from './links'
import { itemName } from './stock'
import { fmtDate, localDay, statusLabel } from './utils'
import type { AppState, Grn } from '../types'

/**
 * Identifies the source of a lot: the vendor id, or the lot itself when the
 * coconuts were bought straight from a farmer with no vendor master record.
 */
export const sourceKey = (g: Grn) => g.farmerId || `LOT:${g.lot}`

export type TraceNodeKind = DocKind | 'source' | 'customer'

export const NODE_KIND_LABEL: Record<TraceNodeKind, string> = {
  ...KIND_LABEL,
  source: 'Supplier / farmer',
  customer: 'Customer',
}

/** The order stages are listed in a legend — the order the goods move through them. */
export const NODE_KIND_ORDER: TraceNodeKind[] = [
  'source',
  'grn',
  'batch',
  'melange',
  'qc',
  'material',
  'packing',
  'order',
  'dispatch',
  'issue',
  'customer',
]

export interface TraceNode {
  /** The record's number, or `source:…` / `customer:…` for the two ends of the chain. */
  id: string
  kind: TraceNodeKind
  /** What prints under the node. */
  label: string
  /** One line for the tooltip. */
  detail: string
  /** Column: the longest run of steps from the start of the chain to this record. */
  depth: number
  /** Where clicking the node goes, when it is a record with a page of its own. */
  href?: string
}

export interface TraceEdge {
  source: string
  target: string
}

export interface TraceGraph {
  nodes: TraceNode[]
  edges: TraceEdge[]
}

/** The part of a trace the graph is drawn from — what the Traceability search returns. */
export interface TraceScope {
  sources: string[]
  lots: string[]
  materials: string[]
  batches: string[]
  packings: string[]
  dispatches: string[]
  issues: string[]
  customers: string[]
  /** Which of each batch's outputs the trace is about. */
  outputs: Record<string, 'all' | string[]>
}

const day = (s?: string) => (s ? fmtDate(localDay(s)) : '')

export function traceGraph(state: AppState, scope: TraceScope): TraceGraph {
  const nodes = new Map<string, TraceNode>()
  const put = (node: Omit<TraceNode, 'depth'>) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { ...node, depth: 0 })
  }
  const record = (id: string, kind: DocKind, label: string, detail: string) =>
    put({ id, kind, label, detail, href: docHref({ id, kind }) })

  for (const key of scope.sources) {
    const vendor = state.vendors.find((v) => v.id === key)
    // A vendor supplies many lots; the one in this chain is the one to describe it by.
    const g =
      state.grns.find((x) => sourceKey(x) === key && scope.lots.includes(x.lot)) ||
      state.grns.find((x) => sourceKey(x) === key)
    put({
      id: `source:${key}`,
      kind: 'source',
      label: vendor?.name || g?.farmer || key,
      detail: vendor ? `Supplier ${vendor.id}` : ['Direct farmer', g?.area].filter(Boolean).join(' · '),
    })
  }
  for (const lot of scope.lots) {
    const g = state.grns.find((x) => x.lot === lot)
    if (!g) continue
    record(
      g.id,
      'grn',
      g.lot,
      [g.id, g.productName, `${g.accepted} ${(g.uom || 'Piece').toLowerCase()}`, `received ${day(g.date)}`]
        .filter(Boolean)
        .join(' · '),
    )
  }
  for (const id of scope.batches) {
    const b = state.batches.find((x) => x.id === id)
    if (!b) continue
    record(id, batchKind(b) === 'Melange' ? 'melange' : 'batch', id, `${batchLabel(state, b)} · made ${day(b.date)}`)
    // The verdicts on the products the trace is about sit between the batch and its packs.
    const shown = scope.outputs[id]
    for (const q of state.qcs) {
      if (q.batchId !== id || !(shown === 'all' || shown?.includes(q.item || ''))) continue
      record(q.id, 'qc', q.id, `${itemName(state, q.item || '')} · ${statusLabel(q.disposition)}`)
    }
  }
  for (const doc of scope.materials) {
    const l = state.ledger.find((x) => x.type === 'PM Receipt' && x.doc === doc)
    if (l) record(doc, 'material', doc, `${itemName(state, l.item)} · supplier lot ${l.lot}`)
  }
  for (const id of scope.packings) {
    const r = state.packingRuns.find((x) => x.id === id)
    if (!r) continue
    record(
      id,
      'packing',
      id,
      `${r.lines.map((l) => `${l.packs} × ${itemName(state, l.sku)}`).join(', ')} · packed ${day(r.date)}`,
    )
  }
  for (const id of scope.dispatches) {
    const d = state.dispatches.find((x) => x.id === id)
    if (!d) continue
    record(id, 'dispatch', id, [d.challan, d.customerName, d.status].filter(Boolean).join(' · '))
    const o = d.orderId ? state.orders.find((x) => x.id === d.orderId) : undefined
    if (o) record(o.id, 'order', o.id, `${o.customerName} · ${o.status}`)
  }
  for (const id of scope.issues) {
    const i = (state.stockIssues || []).find((x) => x.id === id)
    if (i) record(id, 'issue', id, [i.reason, i.recipient, `issued ${day(i.date)}`].filter(Boolean).join(' · '))
  }
  for (const id of scope.customers) {
    const c = state.customers.find((x) => x.id === id)
    put({ id: `customer:${id}`, kind: 'customer', label: c?.name || id, detail: id })
  }

  // ---- edges: every link between two records the trace found ----------------
  const next = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return
    const targets = next.get(from)
    if (targets) targets.add(to)
    else next.set(from, new Set([to]))
  }
  for (const node of nodes.values()) {
    if (!node.href) continue
    const { cameFrom, wentInto } = linkedRecords(state, node.id)
    cameFrom.forEach((r) => link(r.id, node.id))
    wentInto.forEach((r) => link(node.id, r.id))
  }
  for (const g of state.grns) link(`source:${sourceKey(g)}`, g.id)
  for (const d of state.dispatches) link(d.id, `customer:${d.customerId}`)

  /**
   * A record's links reach past a step as well as to it — a QC record links straight to
   * the goods received, a batch straight to its dispatches. That is right for a record's
   * own view and wrong for a picture of the chain, where every shortcut is a line
   * crossing the step it skipped. An edge is kept only when nothing else in the graph
   * already leads from one end to the other.
   */
  const reachableAround = (from: string, to: string) => {
    const stack = [...(next.get(from) || [])].filter((x) => x !== to)
    const seen = new Set(stack)
    while (stack.length) {
      const at = stack.pop()!
      if (at === to) return true
      for (const y of next.get(at) || []) {
        if (seen.has(y)) continue
        seen.add(y)
        stack.push(y)
      }
    }
    return false
  }
  const edges: TraceEdge[] = [...next]
    .flatMap(([source, targets]) => [...targets].map((target) => ({ source, target })))
    .filter((e) => !reachableAround(e.source, e.target))

  // ---- columns: the longest run of steps from anything with nothing before it ----
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]))
  const after = new Map<string, string[]>()
  for (const e of edges) {
    indegree.set(e.target, (indegree.get(e.target) || 0) + 1)
    after.set(e.source, [...(after.get(e.source) || []), e.target])
  }
  const queue = [...nodes.keys()].filter((id) => !indegree.get(id))
  const placed = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    placed.add(id)
    const node = nodes.get(id)!
    for (const t of after.get(id) || []) {
      const target = nodes.get(t)!
      target.depth = Math.max(target.depth, node.depth + 1)
      indegree.set(t, (indegree.get(t) || 0) - 1)
      if (indegree.get(t) === 0) queue.push(t)
    }
  }
  // A cycle, which the data should never hold, would leave records unplaced.
  const last = Math.max(0, ...[...nodes.values()].map((n) => n.depth))
  for (const n of nodes.values()) if (!placed.has(n.id)) n.depth = last + 1

  /**
   * By that rule anything with nothing before it starts in the first column — which put
   * an order beside the farmer, and a pallet of bottles beside the goods received. A
   * record that only feeds something sits just before the first thing it feeds instead.
   */
  const incoming = new Set(edges.map((e) => e.target))
  for (const n of nodes.values()) {
    if (incoming.has(n.id)) continue
    const fed = (after.get(n.id) || []).map((t) => nodes.get(t)!.depth)
    if (fed.length) n.depth = Math.max(n.depth, Math.min(...fed) - 1)
  }

  const rank = (k: TraceNodeKind) => NODE_KIND_ORDER.indexOf(k)
  return {
    nodes: [...nodes.values()].sort(
      (a, b) => a.depth - b.depth || rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label),
    ),
    edges,
  }
}
