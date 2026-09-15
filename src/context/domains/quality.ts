/**
 * The QC verdict a batch is released on, its test blueprints and its lab reports.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { batchDisposition, qcDisposition } from '../../lib/posting'
import type { QcUpdate } from '../../lib/posting'
import { batchOutputs, mainOutput, runBulkItem } from '../../lib/batches'
import { categoryTitle } from '../../lib/qcCategories'
import { itemName, stockRows, inHoldArea, locationLabel } from '../../lib/stock'
import { deepClone, nowISO, statusLabel, uid, QTY_EPSILON } from '../../lib/utils'
import type { LabReport, TestParameter } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useQuality({ state, setState, nextId, log, showToast, actor, announcement }: CoreDeps) {
  const saveQc = useCallback(
    (id: string, updates: QcUpdate): string | null => {
      // Worked out from the verdicts themselves rather than read back out of the
      // updater, so the toast cannot announce a disposition other than the one saved.
      const disposition = qcDisposition(updates)
      /**
       * Stock set aside in a hold area is there because QC rejected it, and a hold area
       * takes nothing else — so a release must not quietly turn it back into sellable stock
       * while it sits there. It is moved back out first.
       */
      if (disposition === 'Released') {
        const record = state.qcs.find((x) => x.id === id)
        const batch = record && state.batches.find((x) => x.id === record.batchId)
        if (record && batch) {
          const covered = record.item || mainOutput(batch)?.item || ''
          const packs = new Set(
            state.packingRuns
              .filter((r) => r.batchId === batch.id && runBulkItem(r) === covered)
              .flatMap((r) => r.lines.map((l) => l.sku)),
          )
          const setAside = stockRows(state).find(
            (r) =>
              r.lot === batch.id &&
              r.qty > QTY_EPSILON &&
              (r.itemType === 'Semi Finished' ? r.item === covered : r.itemType === 'Finished Goods' && packs.has(r.item)) &&
              inHoldArea(state, r.location),
          )
          if (setAside) {
            showToast(
              `${itemName(state, setAside.item)} from ${batch.id} is set aside in ${locationLabel(state, setAside.location)} — move it back out before releasing it.`,
            )
            return null
          }
        }
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const q = draft.qcs.find((x) => x.id === id)
        if (!q) return prev
        Object.assign(q, updates)
        q.disposition = disposition
        q.reviewedBy = actor
        q.reviewedAt = nowISO()
        const b = draft.batches.find((x) => x.id === q.batchId)
        if (!b) return draft

        /**
         * What this verdict actually covers: one bulk output of the batch, and the
         * packs filled from that bulk. A batch gives water and malai, and rejecting
         * the malai must not quarantine the bottles of water standing beside it.
         */
        const product = q.item || mainOutput(b)?.item || ''
        const packedFrom = new Set(
          draft.packingRuns
            .filter((r) => r.batchId === b.id && runBulkItem(r) === product)
            .flatMap((r) => r.lines.map((l) => l.sku)),
        )
        const covers = (r: { itemType: string; item: string }) =>
          r.itemType === 'Semi Finished'
            ? r.item === product
            : r.itemType === 'Finished Goods' && packedFrom.has(r.item)

        if (disposition === 'Released' || disposition === 'Rejected') {
          // Packs are already in the freezer — they went there off the packing line and
          // the lab worked while they sat. So a verdict changes their *status* and
          // nothing else: released stock becomes sellable where it stands, rejected
          // stock stays put flagged so it is not quietly shipped. Nothing physically
          // moves, which is what the floor actually does.
          const current = stockRows(draft).filter(
            (r) => r.lot === b.id && r.status !== disposition && r.qty > 0 && covers(r),
          )
          for (const r of current) {
            draft.ledger.push({
              id: uid('LED'),
              type: 'QC Status Transfer',
              doc: q.id,
              item: r.item,
              itemType: r.itemType,
              lot: r.lot,
              location: r.location,
              status: r.status,
              qtyIn: 0,
              qtyOut: r.qty,
              uom: r.uom,
              unitCost: r.unitCost,
              time: nowISO(),
              expiry: r.expiry,
            })
            draft.ledger.push({
              id: uid('LED'),
              type: 'QC Status Transfer',
              doc: q.id,
              item: r.item,
              itemType: r.itemType,
              lot: r.lot,
              location: r.location,
              status: disposition,
              qtyIn: r.qty,
              qtyOut: 0,
              uom: r.uom,
              unitCost: r.unitCost,
              time: nowISO(),
              expiry: r.expiry,
            })
          }
          // Filed under the QC record — the transaction the verdict belongs to — and not
          // the batch, which had two products and said nothing about which was meant.
          log(
            draft,
            disposition === 'Released' ? 'Released product' : 'Rejected product',
            q.id,
            disposition === 'Released'
              ? `${itemName(draft, product)} from ${b.id} released — its packs are cleared for dispatch where they stand and its bulk is cleared for packing.`
              : `${itemName(draft, product)} from ${b.id} rejected — its stock stays where it is, flagged so it cannot be dispatched.`,
          )
        } else if (disposition === 'Retest') {
          log(draft, 'Held product for retest', q.id, `${itemName(draft, product)} from ${b.id} needs a retest.`)
        } else {
          // Results saved before there is a verdict are still work somebody did on the record.
          const results = (['micro', 'pesticides', 'heavyMetals', 'physico'] as const)
            .map((k) => `${categoryTitle(k)} ${statusLabel(q[k])}`)
            .join(', ')
          log(draft, 'Recorded QC results', q.id, `${itemName(draft, product)} from ${b.id}: ${results}.`)
        }
        // The batch is the roll-up of every verdict on what it made — released only
        // when all of them are, and `Partly Released` for the case this whole change
        // exists for.
        b.status = batchDisposition(draft.qcs.filter((x) => x.batchId === b.id))
        return draft
      })
      showToast(`QC updated: ${statusLabel(disposition)}.`)
      return disposition
    },
    [actor, log, setState, showToast],
  )

  /**
   * Raises the QC record for a bulk output that has none.
   *
   * Only ever needed by a batch posted before QC was per product: it carries one
   * record covering its main output, and its by-product has nothing to be tested
   * against. Every batch posted since gets a record for each output as it is booked.
   */
  const startQc = useCallback(
    (batchId: string, item: string): string | null => {
      const b = state.batches.find((x) => x.id === batchId)
      if (!b) return null
      if (!batchOutputs(b).some((o) => o.item === item)) {
        showToast('That batch did not produce this product.')
        return null
      }
      if (state.qcs.some((q) => q.batchId === batchId && q.item === item)) {
        showToast('That product already has a QC record.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'qc')
        draft.qcs.push({
          id,
          batchId,
          item,
          micro: 'Pending',
          pesticides: 'Pending',
          heavyMetals: 'Pending',
          physico: 'Pending',
          disposition: 'Pending',
          reviewedBy: '',
          reviewedAt: '',
        })
        const target = draft.batches.find((x) => x.id === batchId)
        if (target) {
          target.qcIds = draft.qcs.filter((q) => q.batchId === batchId).map((q) => q.id)
          target.status = batchDisposition(draft.qcs.filter((q) => q.batchId === batchId))
        }
        log(draft, 'Raised QC record', id, `${itemName(draft, item)} from ${batchId}.`)
        createdId = id
        return draft
      })
      showToast('QC record raised.')
      return createdId || POSTED
    },
    [log, nextId, setState, showToast, state.batches, state.qcs],
  )

  const addTestParameter = useCallback(
    (input: Omit<TestParameter, 'id'>): string | null => {
      if (!input.name.trim()) {
        showToast('Test parameter name is required.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const tp: TestParameter = { ...input, id: uid('TP') }
        draft.testParameters.push(tp)
        log(draft, 'Added test parameter', tp.id, `${categoryTitle(tp.category)}: ${tp.name}`)
        createdId = tp.id
        return draft
      })
      showToast('Test parameter added.')
      return createdId || POSTED
    },
    [log, setState, showToast],
  )

  const updateTestParameter = useCallback(
    (id: string, patch: Omit<TestParameter, 'id' | 'category'>): string | null => {
      if (!patch.name.trim()) {
        showToast('Test parameter name is required.')
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const tp = draft.testParameters.find((x) => x.id === id)
        if (!tp) return prev
        Object.assign(tp, patch)
        log(draft, 'Edited test parameter', tp.id, tp.name)
        return draft
      })
      showToast('Test parameter updated.')
      return id
    },
    [log, setState, showToast],
  )

  const deleteTestParameter = useCallback(
    (id: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const tp = draft.testParameters.find((x) => x.id === id)
        if (!tp) return prev
        draft.testParameters = draft.testParameters.filter((x) => x.id !== id)
        log(draft, 'Deleted test parameter', id, tp.name)
        return draft
      })
      showToast('Test parameter deleted.')
    },
    [log, setState, showToast],
  )

  const generateReport = useCallback(
    (input: Omit<LabReport, 'id' | 'createdAt'>): string | null => {
      if (!input.customerName.trim()) {
        showToast('Customer name is required.')
        return null
      }
      if (!input.results.length) {
        showToast('Add at least one test parameter for this category first.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'testReport')
        const report: LabReport = { ...input, id, createdAt: nowISO() }
        draft.labReports.push(report)
        log(draft, 'Generated lab report', id, `${categoryTitle(report.category)} · ${report.sampleName}`)
        createdId = id
        // Announced after React commits, like every other posting: read straight back
        // out of the updater the code is only there while React takes its eager-state
        // shortcut, and the toast quietly degraded to the word "Report" when it did not.
        announcement.current = `${id} generated.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, setState, showToast],
  )

  const updateReport = useCallback(
    (id: string, input: Omit<LabReport, 'id' | 'createdAt'>): string | null => {
      if (!input.customerName.trim()) {
        showToast('Customer name is required.')
        return null
      }
      if (!input.results.length) {
        showToast('Add at least one test parameter for this category first.')
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const idx = draft.labReports.findIndex((r) => r.id === id)
        if (idx < 0) return prev
        // Report number and the date it was generated identify the document, so they
        // survive an edit — anything a QC record has attached still points at it.
        draft.labReports[idx] = { ...input, id, createdAt: draft.labReports[idx].createdAt }
        log(draft, 'Edited lab report', id, `${categoryTitle(input.category)} · ${input.sampleName}`)
        return draft
      })
      showToast(`${id} updated.`)
      return id
    },
    [log, setState, showToast],
  )

  const deleteReport = useCallback(
    (id: string) => {
      const attachedTo = state.qcs.find((q) =>
        [q.microReport, q.pesticidesReport, q.heavyMetalsReport, q.physicoReport].some(
          (r) => r?.url === `/reports/${id}`,
        ),
      )
      if (attachedTo) {
        showToast(`Cannot delete: attached to ${attachedTo.id}. Detach it from the QC record first.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const r = draft.labReports.find((x) => x.id === id)
        if (!r) return prev
        draft.labReports = draft.labReports.filter((x) => x.id !== id)
        log(draft, 'Deleted lab report', id, `${categoryTitle(r.category)} · ${r.sampleName}`)
        return draft
      })
      showToast('Report deleted.')
    },
    [log, setState, showToast, state.qcs],
  )

  return useMemo(
    () => ({
      saveQc,
      startQc,
      addTestParameter,
      updateTestParameter,
      deleteTestParameter,
      generateReport,
      updateReport,
      deleteReport,
    }),
    [
      saveQc,
      startQc,
      addTestParameter,
      updateTestParameter,
      deleteTestParameter,
      generateReport,
      updateReport,
      deleteReport,
    ],
  )
}
