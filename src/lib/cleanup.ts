import { highestIssued, ruleFor, type SeriesKey } from './numbering'
import type { AppState } from '../types'

/**
 * The series minted by the documents a cleanup can remove, so their counters have to
 * be wound back to what survived. Masters are never removed, so they never move.
 */
const NUMBERED_BY_DOCUMENT: SeriesKey[] = [
  'grn',
  'lot',
  'batch',
  'melangeBatch',
  'packing',
  'qc',
  'dispatch',
  'challan',
  'testReport',
  'sticker',
  'issue',
]

/**
 * Working out which records are a test run and which are the plant's real history.
 *
 * There is no author on a record to go by — every document type carries a date and
 * nothing else about who entered it — so the split is by date: everything from the
 * cutoff onwards is treated as the test run and removed, everything before it stays.
 *
 * That ordering is what makes it safe. A document can only ever draw on something
 * that already existed, so deleting the newest can never orphan what is kept. The one
 * way that breaks is an *old* record edited to point at a *new* one, which is why
 * `blockers` exists: rather than quietly leave a kept batch drawing on a lot that no
 * longer exists, the plan refuses and names the pair.
 */

export interface CleanupPlan {
  cutoff: string
  /** Document ids that would be removed, by kind. */
  remove: {
    grns: string[]
    batches: string[]
    packingRuns: string[]
    dispatches: string[]
    orders: string[]
    stockIssues: string[]
    qcs: string[]
    labReports: string[]
    stickerPrints: number
    ledgerRows: number
    audits: number
  }
  /** What survives, for the confirmation screen to show alongside. */
  keep: {
    grns: number
    batches: number
    packingRuns: number
    dispatches: number
    orders: number
  }
  /**
   * Kept records that depend on something the cutoff would delete. Non-empty means the
   * plan must not run — the reference would dangle and its stock would be wrong.
   */
  blockers: string[]
}

/** A record's own timestamp, trimmed to a date so a cutoff compares cleanly. */
const on = (iso?: string) => (iso || '').slice(0, 10)

const isFrom = (iso: string | undefined, cutoff: string) => !!on(iso) && on(iso) >= cutoff

export function planCleanup(state: AppState, cutoff: string): CleanupPlan {
  const grns = state.grns.filter((g) => isFrom(g.date, cutoff)).map((g) => g.id)
  const batches = state.batches.filter((b) => isFrom(b.date, cutoff)).map((b) => b.id)
  const packingRuns = state.packingRuns.filter((r) => isFrom(r.date, cutoff)).map((r) => r.id)
  const dispatches = state.dispatches
    .filter((d) => isFrom(d.dispatchTime, cutoff))
    .map((d) => d.id)
  const stockIssues = (state.stockIssues || []).filter((i) => isFrom(i.date, cutoff)).map((i) => i.id)
  const orders = (state.orders || []).filter((o) => isFrom(o.date, cutoff)).map((o) => o.id)

  const goingGrnLots = new Set(
    state.grns.filter((g) => grns.includes(g.id)).map((g) => g.lot),
  )
  const goingBatches = new Set(batches)

  // A kept record must not be left pointing at something on its way out.
  const blockers: string[] = []
  for (const b of state.batches) {
    if (goingBatches.has(b.id)) continue
    for (const l of b.sourceLines || []) {
      if (goingGrnLots.has(l.lot)) blockers.push(`${b.id} was pressed from ${l.lot}`)
    }
    for (const l of b.blendLines || []) {
      if (goingBatches.has(l.lot)) blockers.push(`${b.id} was blended from ${l.lot}`)
    }
  }
  for (const r of state.packingRuns) {
    if (packingRuns.includes(r.id)) continue
    if (goingBatches.has(r.batchId)) blockers.push(`${r.id} packed ${r.batchId}`)
  }
  for (const d of state.dispatches) {
    if (dispatches.includes(d.id)) continue
    if (goingBatches.has(d.batchId)) blockers.push(`${d.id} shipped ${d.batchId}`)
  }
  /**
   * A stock issue drawing on a batch that is going. Normally impossible — you cannot
   * issue stock before it exists, so an issue is always dated after the batch — but a
   * back-dated one would keep its own ledger lines while the lines that put the stock
   * there disappeared, leaving the balance negative and nothing to explain it.
   */
  for (const i of state.stockIssues || []) {
    if (stockIssues.includes(i.id)) continue
    for (const l of i.lines) {
      if (goingBatches.has(l.lot) || goingGrnLots.has(l.lot)) {
        blockers.push(`${i.id} issued stock from ${l.lot}`)
      }
    }
  }

  const qcs = state.qcs.filter((q) => goingBatches.has(q.batchId)).map((q) => q.id)
  const labReports = state.labReports
    .filter((r) => isFrom(r.createdAt || r.issueDate, cutoff))
    .map((r) => r.id)

  // Every ledger line the removed documents wrote, including the QC records that
  // moved their stock — a batch's QC posts under its own id, not the batch's.
  const goingDocs = new Set<string>([
    ...grns,
    ...batches,
    ...packingRuns,
    ...dispatches,
    ...stockIssues,
    ...qcs,
  ])
  const ledgerRows = state.ledger.filter((l) => goingDocs.has(l.doc)).length

  return {
    cutoff,
    remove: {
      grns,
      batches,
      packingRuns,
      dispatches,
      orders,
      stockIssues,
      qcs,
      labReports,
      stickerPrints: state.stickerPrints.filter((p) => isFrom(p.printedAt, cutoff)).length,
      ledgerRows,
      audits: state.audits.filter((a) => isFrom(a.time, cutoff)).length,
    },
    keep: {
      grns: state.grns.length - grns.length,
      batches: state.batches.length - batches.length,
      packingRuns: state.packingRuns.length - packingRuns.length,
      dispatches: state.dispatches.length - dispatches.length,
      orders: (state.orders || []).length - orders.length,
    },
    blockers: [...new Set(blockers)],
  }
}

/**
 * Applies a plan in place. Counters are pulled back to the highest number still in
 * use rather than to zero: the point is that the next document carries on from the
 * plant's real history, and a counter below a live id would hand out that id twice.
 */
export function applyCleanup(draft: AppState, plan: CleanupPlan) {
  const gone = <T extends { id: string }>(list: T[], ids: string[]) =>
    list.filter((x) => !ids.includes(x.id))

  const goingDocs = new Set<string>([
    ...plan.remove.grns,
    ...plan.remove.batches,
    ...plan.remove.packingRuns,
    ...plan.remove.dispatches,
    ...plan.remove.stockIssues,
    ...plan.remove.qcs,
  ])

  draft.grns = gone(draft.grns, plan.remove.grns)
  draft.batches = gone(draft.batches, plan.remove.batches)
  draft.packingRuns = gone(draft.packingRuns, plan.remove.packingRuns)
  draft.dispatches = gone(draft.dispatches, plan.remove.dispatches)
  draft.orders = gone(draft.orders || [], plan.remove.orders)
  draft.stockIssues = gone(draft.stockIssues || [], plan.remove.stockIssues)
  draft.qcs = gone(draft.qcs, plan.remove.qcs)
  draft.labReports = gone(draft.labReports, plan.remove.labReports)
  draft.ledger = draft.ledger.filter((l) => !goingDocs.has(l.doc))
  draft.stickerPrints = draft.stickerPrints.filter((p) => on(p.printedAt) < plan.cutoff)
  // The entries describing the removed documents go with them; the cleanup writes its
  // own line straight after, so the trail says what happened rather than just thinning.
  draft.audits = draft.audits.filter((a) => on(a.time) < plan.cutoff)

  /**
   * An order raised before the cutoff but dispatched after it keeps its record while
   * the challan that fulfilled it goes. Left as it was, it would stay marked
   * Dispatched against a challan with nothing on it — and an order that is not Open
   * cannot be dispatched again, so it would be stuck for good with its stock back on
   * the shelf. It is opened again instead, which is what actually happened to it.
   */
  for (const o of draft.orders) {
    if (o.status !== 'Dispatched') continue
    if (draft.dispatches.some((d) => d.orderId === o.id)) continue
    o.status = 'Open'
    o.challan = undefined
    o.dispatchedAt = undefined
  }

  /**
   * Numbering carries on from the highest number still in use. Read through the
   * series' own format rather than off the end of the code — a challan filed as
   * DC0007/2026 ends in its year, so trimming trailing digits set the counter to
   * 2026 and the next challan would have been DC2027/2026.
   */
  for (const key of NUMBERED_BY_DOCUMENT) {
    draft.counters[key] = highestIssued(draft, key, ruleFor(draft.config, key))
  }
}
