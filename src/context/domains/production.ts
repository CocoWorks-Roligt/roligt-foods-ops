/**
 * Extraction and melange runs: produce and bulk in, bulk out, QC raised.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { MALAI_ITEM, WATER_ITEM, batchOutputs, usableYield } from '../../lib/batches'
import {
  batchDisposition,
  batchQuantitiesChanged,
  checkBatch,
  describeOutputs,
  postBatchLines,
} from '../../lib/posting'
import type { BatchInput } from '../../lib/posting'
import { deepClone } from '../../lib/utils'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useProduction({ state, setState, nextId, log, showToast, announcement }: CoreDeps) {
  const createBatch = useCallback(
    (input: BatchInput): string | null => {
      const error = checkBatch(state, input)
      if (error) {
        showToast(error)
        return null
      }

      const blending = input.kind === 'Melange'
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, blending ? 'melangeBatch' : 'batch')
        const posted = postBatchLines(draft, id, input)
        const { main } = posted

        /**
         * One QC record per bulk the batch made. A pressing gives water and malai and
         * they are tested apart — different benches, different results, and the water
         * can be released while the malai is still pending.
         */
        const qcIds = posted.outputLines.map((line) => {
          const qcId = nextId(draft, 'qc')
          draft.qcs.push({
            id: qcId,
            batchId: id,
            item: line.item,
            micro: 'Pending',
            pesticides: 'Pending',
            heavyMetals: 'Pending',
            physico: 'Pending',
            disposition: 'Pending',
            reviewedBy: '',
            reviewedAt: '',
          })
          return qcId
        })

        draft.batches.push({
          id,
          kind: input.kind,
          date: new Date(input.date).toISOString(),
          melangeId: input.melangeId,
          location: input.location,
          sourceLines: posted.sourceLines,
          blendLines: posted.blendLines,
          outputLines: posted.outputLines,
          coconuts: posted.inputQty,
          inputQty: posted.inputQty,
          inputUom: posted.inputUom,
          spoiled: input.spoiled,
          // Kept in step for the coconut reports that still read them by name.
          waterLitres: posted.outputLines.find((l) => l.item === WATER_ITEM)?.qty ?? 0,
          malaiKg: posted.outputLines.find((l) => l.item === MALAI_ITEM)?.qty ?? 0,
          outputs: [],
          outputLitres: main?.qty ?? 0,
          // Yield is measured against the nuts that were actually pressed, not against
          // everything carried in — a load with 50 rotten nuts did not get worse at
          // pressing, it got smaller. `wastage` is what those spoiled nuts would have
          // given at that same rate.
          yieldPerCoconut: usableYield(posted.inputQty, input.spoiled, main?.qty ?? 0),
          yieldPerUnit: usableYield(posted.inputQty, input.spoiled, main?.qty ?? 0),
          wastage: usableYield(posted.inputQty, input.spoiled, main?.qty ?? 0) * (input.spoiled || 0),
          rmCost: posted.inputCost,
          pmCost: 0,
          directCost: posted.inputCost,
          costPerL: main?.qty ? posted.inputCost / main.qty : 0,
          status: 'Awaiting QC',
          qcId: qcIds[0] || '',
          qcIds,
        })
        log(
          draft,
          blending ? 'Posted melange' : 'Posted production',
          id,
          `${blending ? 'Blended' : 'Consumed'} ${posted.inputQty} ${posted.inputUom} into ${describeOutputs(draft, posted.outputLines)}.`,
        )
        createdId = id
        announcement.current = `${id} posted. Each bulk it made has its own QC record — release them one product at a time.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, setState, showToast, state],
  )

  const updateBatch = useCallback(
    (id: string, input: BatchInput): string | null => {
      const existing = state.batches.find((b) => b.id === id)
      if (!existing) return null
      // Bulk that has been packed, or moved by QC, was costed off this batch's output,
      // so the quantities behind it can no longer move. Descriptive fields still can.
      const drawnOn = state.ledger.some((l) => l.lot === id && l.doc !== id)
      const qtyChanged = batchQuantitiesChanged(existing, input)
      if (drawnOn && qtyChanged) {
        showToast(
          'This batch has already been packed, blended or reviewed by QC — only the date and the spoiled count can be edited.',
        )
        return null
      }
      const error = checkBatch(state, input, id)
      if (error) {
        showToast(error)
        return null
      }

      setState((prev) => {
        const draft = deepClone(prev)
        const b = draft.batches.find((x) => x.id === id)
        if (!b) return prev
        b.date = new Date(input.date).toISOString()
        b.spoiled = input.spoiled
        b.melangeId = input.melangeId
        b.location = input.location
        if (qtyChanged) {
          // Reverse this batch's own stock lines and re-post them from the new figures.
          draft.ledger = draft.ledger.filter((l) => l.doc !== id)
          const posted = postBatchLines(draft, id, input)
          const { main } = posted
          b.sourceLines = posted.sourceLines
          b.blendLines = posted.blendLines
          b.outputLines = posted.outputLines
          b.coconuts = posted.inputQty
          b.inputQty = posted.inputQty
          b.inputUom = posted.inputUom
          b.waterLitres = posted.outputLines.find((l) => l.item === WATER_ITEM)?.qty ?? 0
          b.malaiKg = posted.outputLines.find((l) => l.item === MALAI_ITEM)?.qty ?? 0
          b.outputLitres = main?.qty ?? 0
          b.yieldPerCoconut = usableYield(posted.inputQty, input.spoiled, main?.qty ?? 0)
          b.yieldPerUnit = b.yieldPerCoconut
          b.wastage = b.yieldPerCoconut * (input.spoiled || 0)
          b.rmCost = posted.inputCost
          b.directCost = posted.inputCost
          b.costPerL = main?.qty ? posted.inputCost / main.qty : 0

          /**
           * Outputs can be added or dropped by an edit, and each one owns a QC record.
           * Quantities only move while nothing has drawn on the batch — checked above —
           * so every record here is still untouched and safe to reconcile.
           */
          const produced = posted.outputLines.map((l) => l.item)
          draft.qcs = draft.qcs.filter(
            (q) => q.batchId !== id || produced.includes(q.item || ''),
          )
          for (const item of produced) {
            if (draft.qcs.some((q) => q.batchId === id && q.item === item)) continue
            draft.qcs.push({
              id: nextId(draft, 'qc'),
              batchId: id,
              item,
              micro: 'Pending',
              pesticides: 'Pending',
              heavyMetals: 'Pending',
              physico: 'Pending',
              disposition: 'Pending',
              reviewedBy: '',
              reviewedAt: '',
            })
          }
          const records = draft.qcs.filter((q) => q.batchId === id)
          b.qcIds = records.map((q) => q.id)
          b.qcId = b.qcIds[0] || ''
          b.status = batchDisposition(records)
        }
        log(
          draft,
          existing.kind === 'Melange' ? 'Edited melange' : 'Edited production',
          id,
          qtyChanged
            ? `Re-posted ${b.inputQty} ${b.inputUom} into ${describeOutputs(draft, batchOutputs(b))}.`
            : 'Updated batch details; stock unchanged.',
        )
        return draft
      })
      showToast(`${id} updated.`)
      return id
    },
    [log, nextId, setState, showToast, state],
  )

  const deleteBatch = useCallback(
    (id: string) => {
      const b = state.batches.find((x) => x.id === id)
      if (!b) return
      if (state.ledger.some((l) => l.lot === id && l.type === 'Dispatch')) {
        showToast('Cannot delete: finished goods from this batch have already been dispatched.')
        return
      }
      // A melange that drew this batch's bulk owns stock costed off it, so the batch
      // it was blended from cannot simply vanish underneath it.
      const blendedInto = state.batches.find(
        (x) => x.id !== id && (x.blendLines || []).some((l) => l.lot === id),
      )
      if (blendedInto) {
        showToast(`Cannot delete: ${blendedInto.id} was blended from this batch. Delete that melange first.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        // Packing runs draw from this batch, so they go with it — otherwise their
        // packs and packing-material issues outlive the batch that produced them.
        const runIds = draft.packingRuns.filter((r) => r.batchId === id).map((r) => r.id)
        draft.packingRuns = draft.packingRuns.filter((r) => r.batchId !== id)
        draft.batches = draft.batches.filter((x) => x.id !== id)
        // Every output's QC record, not just the first — each one writes its own
        // status-transfer lines under its own document code.
        const qcDocs = draft.qcs.filter((x) => x.batchId === id).map((x) => x.id)
        draft.qcs = draft.qcs.filter((x) => x.batchId !== id)
        const gone = new Set([id, b.qcId, ...qcDocs, ...runIds].filter(Boolean))
        draft.ledger = draft.ledger.filter((l) => !gone.has(l.doc))
        log(
          draft,
          'Deleted batch',
          id,
          `Removed the batch, its ${qcDocs.length || 1} QC record(s)${runIds.length ? `, ${runIds.length} packing run(s)` : ''}, and reversed all its stock.`,
        )
        return draft
      })
      showToast('Batch deleted; stock recalculated.')
    },
    [log, setState, showToast, state.batches, state.ledger],
  )

  return useMemo(
    () => ({
      createBatch,
      updateBatch,
      deleteBatch,
    }),
    [
      createBatch,
      updateBatch,
      deleteBatch,
    ],
  )
}
