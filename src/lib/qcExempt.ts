/**
 * Clearing the QC queue of a bulk that no longer goes through QC.
 *
 * Switching a bulk to "skips QC" only decides future batches — an output keeps the
 * decision its batch was posted under. That left every batch pressed before the
 * switch awaiting a verdict the lab will never be asked for, its stock held in
 * Quarantine. This releases exactly those lots: the outputs of the item whose QC
 * record nobody has started. A record carrying any lab work (a result, a note, a
 * report) is the lab's to close, and a verdict already given stands.
 */
import { batchOutputs, runBulkItem } from './batches'
import { batchRollUp } from './posting'
import { LEGACY_TESTS, hasTestData, qcTest } from './qcCategories'
import { inHoldArea, stockRows } from './stock'
import { nowISO, uid } from './utils'
import type { AppState, QcRecord } from '../types'

/** Whether anyone has written anything on a QC record yet. */
export const hasLabWork = (q: QcRecord) =>
  [...LEGACY_TESTS, ...Object.keys(q.tests || {})].some((key) => hasTestData(qcTest(q, key)))

export interface ExemptRelease {
  /** The batches whose output of the item was released. */
  released: string[]
  /** Untouched records that already carry lab work — the lab still has to close these. */
  started: string[]
  /** Batches left alone because some of their stock sits in a hold area. */
  setAside: string[]
}

/**
 * Releases, in place on `draft`, every untested pending QC record of `item`: the
 * record goes, the batch output is marked exempt (as if posted after the switch),
 * its Quarantine stock — the bulk lot and the packs filled from it — moves to
 * Released with paired "QC Status Transfer" lines filed under the batch, and the
 * batch's status rolls up again. The ledger is only appended to.
 */
export function releaseExemptPending(draft: AppState, item: string): ExemptRelease {
  const out: ExemptRelease = { released: [], started: [], setAside: [] }
  const pending = draft.qcs.filter((q) => q.item === item && q.disposition === 'Pending')
  for (const q of pending) {
    if (hasLabWork(q)) {
      out.started.push(q.id)
      continue
    }
    const b = draft.batches.find((x) => x.id === q.batchId)
    if (!b) continue
    const packedFrom = new Set(
      draft.packingRuns
        .filter((r) => r.batchId === b.id && runBulkItem(r) === item)
        .flatMap((r) => r.lines.map((l) => l.sku)),
    )
    const moving = stockRows(draft).filter(
      (r) =>
        r.lot === b.id &&
        r.qty > 0 &&
        r.status === 'Quarantine' &&
        (r.itemType === 'Semi Finished' ? r.item === item : r.itemType === 'Finished Goods' && packedFrom.has(r.item)),
    )
    // A hold area takes only rejected stock (see saveQc); releasing a lot that sits
    // in one would leave sellable goods among the rejects.
    if (moving.some((r) => inHoldArea(draft, r.location))) {
      out.setAside.push(b.id)
      continue
    }
    const time = nowISO()
    for (const r of moving) {
      const line = {
        type: 'QC Status Transfer',
        doc: b.id,
        item: r.item,
        itemType: r.itemType,
        lot: r.lot,
        location: r.location,
        uom: r.uom,
        unitCost: r.unitCost,
        time,
        expiry: r.expiry,
      }
      draft.ledger.push({ ...line, id: uid('LED'), status: 'Quarantine', qtyIn: 0, qtyOut: r.qty })
      draft.ledger.push({ ...line, id: uid('LED'), status: 'Released', qtyIn: r.qty, qtyOut: 0 })
    }
    // batchOutputs synthesises lines for legacy coconut batches, so they are stored
    // first — otherwise the mark below would land on a throwaway copy
    if (!b.outputLines?.length) b.outputLines = batchOutputs(b)
    for (const o of b.outputLines) if (o.item === item) o.qcExempt = true
    draft.qcs = draft.qcs.filter((x) => x.id !== q.id)
    b.qcIds = draft.qcs.filter((x) => x.batchId === b.id).map((x) => x.id)
    if (b.qcId === q.id) b.qcId = b.qcIds[0] || ''
    b.status = batchRollUp(draft.qcs.filter((x) => x.batchId === b.id), batchOutputs(b))
    out.released.push(b.id)
  }
  return out
}
