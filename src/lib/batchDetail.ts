/**
 * Batch/Lot Detail's model (WORKFLOW): everything the page shows about one
 * batch, folded pure from the plant — the honest timeline of what happened to
 * it, its genealogy both ways (the same isomorphic walk the Traceability page
 * and /api/genealogy run), and the ONE next action, chosen from what the
 * batch's own state allows and the caller's own permissions, with every
 * refused action saying why in plain words.
 *
 * Classic batches (everything before batch_v2) post complete: their "next
 * action" is the next step of the flow their state sits in — record the
 * verdict, pack the bulk, blend it, dispatch the packs. The run state machine
 * (Draft→In Progress→Awaiting QC→Closed with the spoilage and mass-balance
 * guards) arrives with the batch_v2 stage forms and reads here then.
 */
import { batchKind, batchOutputs } from './batches.ts'
import { traceGenealogy, GENEALOGY_DEFAULT_DEPTH, type GenealogyDocs } from './genealogy.ts'
import { canConsumeLot, type ConsumptionVerdict } from './rules/consumption.ts'
import { stockRows } from './stock.ts'
import type { GenealogyNode } from './contracts.ts'
import type { AppState, Batch, QcRecord } from '../types.ts'

/** One thing that happened to the batch, on the day it happened. */
export interface BatchTimelineEvent {
  at?: string
  label: string
  detail?: string
  status?: string
}

/**
 * Something the flow says could happen next. `legal` is false when the role or
 * the rules refuse it — the page shows it disabled with `why`, never hidden:
 * "why can't I" is the question the page exists to answer.
 */
export interface BatchAction {
  key: string
  label: string
  href?: string
  legal: boolean
  why?: string
}

export interface BatchDetailModel {
  batch: Batch
  /** "Extraction run" or "Blend run" — the plant's own words (GLOSSARY). */
  kindLabel: string
  timeline: BatchTimelineEvent[]
  actions: BatchAction[]
  upstream: GenealogyNode[]
  downstream: GenealogyNode[]
  truncated: boolean
}

const genealogyDocs = (state: AppState): GenealogyDocs => ({
  grns: state.grns,
  batches: state.batches,
  packingRuns: state.packingRuns,
  orders: state.orders,
  dispatches: state.dispatches,
  shipments: [],
})

/** Bulk of this batch still on hand, by output stock id — what packing or a blend could draw. */
const bulkRows = (state: AppState, batch: Batch) =>
  stockRows(state).filter((r) => r.lot.startsWith(`${batch.id}/`) && r.qty > 0)

const bulkLeft = (state: AppState, batch: Batch): number =>
  bulkRows(state, batch).reduce((sum, r) => sum + r.qty, 0)

/**
 * The verdict on using this batch's bulk: every lot row must be drawable, and
 * the explanation that answers is the first refusal — lot status lives on the
 * stock rows (Released, Quarantine…), not on the batch's own rolled-up status.
 */
function bulkVerdict(
  state: AppState,
  batch: Batch,
  purpose: 'pack' | 'blend',
  qcGateV2: boolean,
): ConsumptionVerdict {
  const rows = bulkRows(state, batch)
  let ok: ConsumptionVerdict = { ok: true, purpose, status: '', mode: 'legacy', explanation: '' }
  for (const r of rows) {
    const v = canConsumeLot(r, { purpose, qcGateV2 })
    if (!v.ok) return v
    ok = v
  }
  return rows.length ? ok : canConsumeLot({ status: batch.status }, { purpose, qcGateV2 })
}

/** Packed finished goods of this batch still on hand. */
const packsLeft = (state: AppState, batch: Batch): number =>
  stockRows(state)
    .filter((r) => r.itemType === 'Finished Goods' && r.lot.startsWith(batch.id) && r.qty > 0)
    .reduce((sum, r) => sum + r.qty, 0)

const holds = (permissions: readonly string[], slug: string) => permissions.includes(slug)

/**
 * The page's model. `permissions` reads like the session's permission list
 * (page slugs and can.* action slugs); `qcGateV2` is the folded flag.
 */
export function batchDetail(
  state: AppState,
  batchId: string,
  permissions: readonly string[],
  qcGateV2: boolean,
): BatchDetailModel | null {
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) return null

  const outputs = batchOutputs(batch)
  const qcs = (batch.qcIds ?? [])
    .map((id) => state.qcs.find((q) => q.id === id))
    .filter((q): q is QcRecord => !!q)
  const pendingQc = qcs.filter((q) => q.disposition === 'Pending' || q.disposition === 'Retest')
  const runs = state.packingRuns.filter((p) => p.batchId === batch.id)
  const dispatches = state.dispatches.filter((d) => d.batchId === batch.id)

  // —— Timeline: what happened, in the order it happened.
  const timeline: BatchTimelineEvent[] = []
  const grnByLot = new Map(state.grns.map((g) => [g.lot, g]))
  for (const s of batch.sourceLines) {
    const g = grnByLot.get(s.lot)
    if (g) timeline.push({ at: g.date, label: `Received ${g.lot}`, detail: g.farmerName })
  }
  for (const s of batch.blendLines ?? []) {
    timeline.push({ at: undefined, label: `Drew ${s.qty} ${s.uom ?? ''} of ${s.item}`.trim(), detail: `from ${s.lot}` })
  }
  timeline.push({
    at: batch.date,
    label: batchKind(batch) === 'Melange' ? 'Blend run recorded' : 'Extraction run recorded',
    detail: `${outputs.length} output${outputs.length === 1 ? '' : 's'}`,
  })
  for (const q of qcs) {
    timeline.push({
      at: q.reviewedAt,
      label: q.disposition === 'Pending' ? 'QC tests recorded' : `QC verdict: ${q.disposition}`,
      detail: q.item ? state.items.find((i) => i.id === q.item)?.name ?? q.item : undefined,
      status: q.disposition,
    })
  }
  for (const p of runs) {
    const packs = p.lines.reduce((n, l) => n + l.packs, 0)
    timeline.push({ at: p.date, label: `Packed ${packs} pack${packs === 1 ? '' : 's'}`, detail: p.id })
  }
  for (const d of dispatches) {
    timeline.push({
      at: d.dispatchTime.slice(0, 10),
      label: `Dispatched ${d.qty} to ${d.customerName}`,
      detail: `challan ${d.challan}`,
      status: d.status,
    })
  }
  timeline.sort((a, b) => (a.at ?? batch.date).localeCompare(b.at ?? batch.date))

  // —— Actions: the flow's next steps for the state this batch sits in, each
  // legal only for a caller who holds the page that owns it.
  const actions: BatchAction[] = []
  if (pendingQc.length) {
    const legal = holds(permissions, 'page.quality')
    actions.push({
      key: 'qc',
      label: `Record QC verdict${pendingQc.length > 1 ? ` (${pendingQc.length} waiting)` : ''}`,
      href: legal ? '/quality' : undefined,
      legal,
      why: legal ? undefined : 'Only Quality Control can record verdicts.',
    })
  }
  const bulk = bulkLeft(state, batch)
  if (bulk > 0 && batchKind(batch) !== 'Melange') {
    const verdict = bulkVerdict(state, batch, 'pack', qcGateV2)
    const legal = verdict.ok && holds(permissions, 'page.packing')
    actions.push({
      key: 'pack',
      label: `Pack the ${bulk} on hand`,
      href: legal ? '/packing' : undefined,
      legal,
      why: !verdict.ok ? verdict.explanation : !holds(permissions, 'page.packing') ? 'Only Packing can pack a run.' : undefined,
    })
  }
  if (bulk > 0) {
    const legal = holds(permissions, 'page.production')
    actions.push({
      key: 'blend',
      label: 'Blend into a product',
      href: legal ? '/production?stage=melange' : undefined,
      legal,
      why: legal ? undefined : 'Only Production can start a blend.',
    })
  }
  const packs = packsLeft(state, batch)
  if (packs > 0) {
    const legal = holds(permissions, 'page.dispatch')
    actions.push({
      key: 'dispatch',
      label: `Dispatch packed stock (${packs})`,
      href: legal ? '/dispatch' : undefined,
      legal,
      why: legal ? undefined : 'Only Store/Dispatch can dispatch.',
    })
  }

  // —— Genealogy: the same walk, both directions.
  const docs = genealogyDocs(state)
  const back = traceGenealogy(`RUN:${batch.id}`, 'backward', GENEALOGY_DEFAULT_DEPTH, docs)
  const forward = traceGenealogy(`RUN:${batch.id}`, 'forward', GENEALOGY_DEFAULT_DEPTH, docs)

  return {
    batch,
    kindLabel: batchKind(batch) === 'Melange' ? 'Blend run' : 'Extraction run',
    timeline,
    actions,
    upstream: back.nodes.filter((n) => n.id !== `batch:${batch.id}`),
    downstream: forward.nodes.filter((n) => n.id !== `batch:${batch.id}`),
    truncated: back.truncated || forward.truncated,
  }
}
