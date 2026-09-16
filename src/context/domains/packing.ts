/**
 * Filling bulk into packs, and the packing material a run consumes.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { fmtBulk } from '../../lib/batches'
import { checkPacking, defaultPackingStore, postPackingLines, checkArea } from '../../lib/posting'
import type { PackingInput } from '../../lib/posting'
import { sampleProductName } from '../../lib/controlSamples'
import { itemName } from '../../lib/stock'
import { deepClone, localDay, nowISO, QTY_EPSILON, toDateKey, uid } from '../../lib/utils'
import type { AppState } from '../../types'
import { POSTED } from './deps'
import type { ControlSamplePatch, CoreDeps, PackingStockInput } from './deps'

/**
 * The stock item a receipt books. The Procurement form picks a purchase product, so
 * the item is read off that; a caller that already knows the item may name it
 * directly. Either way it has to be packing material, or the receipt would book a
 * bottle into the coconut store.
 */
function packingItem(state: AppState, input: PackingStockInput) {
  const id =
    input.itemId ||
    state.purchaseProducts.find((p) => p.id === input.purchaseProductId)?.itemId ||
    ''
  const item = state.items.find((i) => i.id === id)
  return item && item.type === 'Packing Material' ? item : undefined
}

/** What the form got wrong, or null when it is postable. Shared by add and edit. */
function packingStockError(state: AppState, input: PackingStockInput): string | null {
  if (!packingItem(state, input)) return 'Select the packing material being received.'
  if (!(input.qty > 0)) return 'Quantity must be greater than zero.'
  if (!input.lot.trim()) return 'Lot / batch reference is required.'
  if (input.unitCost < 0) return 'Unit cost cannot be negative.'
  return null
}

export function usePacking({ state, setState, nextId, log, showToast, announcement }: CoreDeps) {
  const createPackingRun = useCallback(
    (input: PackingInput): string | null => {
      const math = checkPacking(state, input)
      if (!math.ok) {
        showToast(math.error)
        return null
      }

      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'packing')
        const run = postPackingLines(draft, id, input, math)
        draft.packingRuns.push(run)
        log(
          draft,
          'Posted packing run',
          id,
          `Packed ${fmtBulk(math.drawn, math.uom)} of ${itemName(draft, math.bulkItem)} from ${input.batchId}.`,
        )
        createdId = id
        announcement.current = `${id} posted.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, setState, showToast, state],
  )

  const updatePackingRun = useCallback(
    (id: string, input: PackingInput): string | null => {
      const existing = state.packingRuns.find((r) => r.id === id)
      if (!existing) return null
      // Anything else that has touched these packs — a QC release, a dispatch, or a
      // second run that packed the same SKU from the same batch — shares their blended
      // unit cost, so re-drawing this run's bulk and packing material would shift it.
      const skus = existing.lines.map((l) => l.sku)
      const touched = state.ledger.some(
        (l) => l.doc !== id && l.lot === existing.batchId && skus.includes(l.item),
      )
      if (touched) {
        showToast(
          'These packs have already been released by QC, dispatched, or packed alongside another run — delete this run instead if it has to change.',
        )
        return null
      }
      const math = checkPacking(state, input, id)
      if (!math.ok) {
        showToast(math.error)
        return null
      }

      setState((prev) => {
        const draft = deepClone(prev)
        const idx = draft.packingRuns.findIndex((r) => r.id === id)
        if (idx < 0) return prev
        // Return the old bulk and packing material, then draw again from the new lines.
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        draft.packingRuns[idx] = postPackingLines(draft, id, input, math)
        log(
          draft,
          'Edited packing run',
          id,
          `Re-packed ${fmtBulk(math.drawn, math.uom)} of ${itemName(draft, math.bulkItem)} from ${input.batchId}.`,
        )
        return draft
      })
      showToast(`${id} updated.`)
      return id
    },
    [log, setState, showToast, state],
  )

  const deletePackingRun = useCallback(
    (id: string) => {
      const run = state.packingRuns.find((r) => r.id === id)
      if (!run) return
      if (state.ledger.some((l) => l.doc === id && l.type === 'Packing Output')) {
        const packed = run.lines.map((l) => l.sku)
        const dispatched = state.ledger.some(
          (l) => l.type === 'Dispatch' && l.lot === run.batchId && packed.includes(l.item),
        )
        if (dispatched) {
          showToast('Cannot delete: packs from this run have already been dispatched.')
          return
        }
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.packingRuns = draft.packingRuns.filter((r) => r.id !== id)
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        log(draft, 'Deleted packing run', id, `Returned bulk and PM from ${run.batchId}.`)
        return draft
      })
      showToast('Packing run deleted; stock recalculated.')
    },
    [log, setState, showToast, state.ledger, state.packingRuns],
  )

  /**
   * Whether anything has drawn on what a receipt brought in. A packing run that has
   * already consumed these BiBs costed itself at the rate posted here, so the quantity
   * and the money behind it can no longer move — only the supplier, which is a record
   * of where they came from and changes nothing downstream.
   */
  const packingReceiptConsumed = useCallback(
    (doc: string) => {
      const line = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
      if (!line) return false
      return state.ledger.some(
        (l) => l.doc !== doc && l.item === line.item && l.lot === line.lot && l.qtyOut > 0,
      )
    },
    [state.ledger],
  )

  const addPackingStock = useCallback(
    (input: PackingStockInput): string | null => {
      const problem = packingStockError(state, input)
      if (problem) {
        showToast(problem)
        return null
      }
      const badArea = checkArea(state, input.location || defaultPackingStore(state), 'Packing Material')
      if (badArea) {
        showToast(badArea)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const item = packingItem(draft, input)
        if (!item) return prev
        // A packing-material receipt is a document like any other: it names a supplier,
        // it is edited and deleted, and it is quoted in the audit trail. It used to mint
        // itself a random code no series could configure and no admin could reconcile.
        const doc = nextId(draft, 'pmReceipt')
        const vendor = input.vendorId ? draft.vendors.find((v) => v.id === input.vendorId) : undefined
        draft.ledger.push({
          id: uid('LED'),
          type: 'PM Receipt',
          doc,
          item: item.id,
          itemType: 'Packing Material',
          lot: input.lot.trim(),
          location: input.location || defaultPackingStore(draft) || '',
          status: 'Available',
          qtyIn: input.qty,
          qtyOut: 0,
          uom: item.uom,
          unitCost: input.unitCost,
          // The day the pallet actually arrived, which is not always the day somebody
          // got round to entering it.
          time: input.date ? new Date(input.date).toISOString() : nowISO(),
          vendorId: vendor?.id,
        })
        log(
          draft,
          'Added packing stock',
          doc,
          `${item.name}: +${input.qty} ${item.uom}${vendor ? ` from ${vendor.name}` : ''}`,
        )
        createdId = doc
        announcement.current = `${doc} posted — ${item.name} is in stock.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, setState, showToast, state],
  )

  const updatePackingStock = useCallback(
    (doc: string, input: PackingStockInput): string | null => {
      const line = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
      if (!line) return null
      const problem = packingStockError(state, input)
      if (problem) {
        showToast(problem)
        return null
      }
      const consumed = packingReceiptConsumed(doc)
      const materialMoved =
        input.itemId !== line.item ||
        input.lot.trim() !== line.lot ||
        Math.abs(input.qty - line.qtyIn) > QTY_EPSILON ||
        Math.abs(input.unitCost - line.unitCost) > QTY_EPSILON ||
        (input.location || line.location) !== line.location
      if (consumed && materialMoved) {
        showToast('This stock is already in a packing run — only the supplier can be edited.')
        return null
      }
      const badArea = checkArea(state, input.location || line.location, 'Packing Material', {
        keep: line.location,
      })
      if (badArea) {
        showToast(badArea)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const target = draft.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
        if (!target) return prev
        const item = packingItem(draft, input)
        if (!item) return prev
        const vendor = input.vendorId ? draft.vendors.find((v) => v.id === input.vendorId) : undefined
        // A receipt is one line, so re-posting it is rewriting that line in place —
        // the reverse-and-repost the longer documents do, with nothing else to reverse.
        target.item = item.id
        target.lot = input.lot.trim()
        target.location = input.location || target.location
        target.qtyIn = input.qty
        target.uom = item.uom
        target.unitCost = input.unitCost
        if (input.date) target.time = new Date(input.date).toISOString()
        target.vendorId = vendor?.id
        log(
          draft,
          'Edited packing stock',
          doc,
          `${item.name}: ${input.qty} ${item.uom}${vendor ? ` from ${vendor.name}` : ''}`,
        )
        return draft
      })
      showToast('Packing material receipt updated.')
      return doc
    },
    [log, packingReceiptConsumed, setState, showToast, state],
  )

  const deletePackingStock = useCallback(
    (doc: string) => {
      const line = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
      if (!line) return
      if (packingReceiptConsumed(doc)) {
        showToast('This stock is already in a packing run and cannot be removed.')
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.ledger = draft.ledger.filter((l) => l.doc !== doc)
        log(
          draft,
          'Deleted packing stock',
          doc,
          `${itemName(draft, line.item)}: -${line.qtyIn} ${line.uom}; stock recalculated.`,
        )
        return draft
      })
      showToast('Packing material receipt deleted.')
    },
    [log, packingReceiptConsumed, setState, showToast, state],
  )

  /**
   * Records what happened to a run's control samples after it was posted — who took
   * them, the day they were destroyed, a remark. Nothing here is stock, so it is written
   * straight onto the line, and stays open after the run's packs are released or gone.
   */
  const updateControlSample = useCallback(
    (runId: string, index: number, patch: ControlSamplePatch): string | null => {
      const run = state.packingRuns.find((r) => r.id === runId)
      const sample = run?.controlSamples?.[index]
      if (!run || !sample) return null
      // Samples counted before the register existed never said who took them, and nobody
      // may now know — that must not stop anyone recording that they were destroyed.
      const collectedBy = patch.collectedBy.trim()
      if (!collectedBy && sample.collectedBy) {
        showToast('Say who collected the control samples.')
        return null
      }
      const destroyedOn = patch.destroyedOn
      if (destroyedOn && destroyedOn < localDay(run.date)) {
        showToast('They cannot have been destroyed before the day they were produced.')
        return null
      }
      if (destroyedOn && destroyedOn > toDateKey()) {
        showToast('The day they were destroyed cannot be in the future.')
        return null
      }
      const remark = patch.remark.trim()
      setState((prev) => {
        const draft = deepClone(prev)
        const target = draft.packingRuns.find((r) => r.id === runId)
        const s = target?.controlSamples?.[index]
        if (!target || !s) return prev
        const destroyed = !!destroyedOn && !s.destroyedOn
        const restored = !destroyedOn && !!s.destroyedOn
        s.collectedBy = collectedBy
        if (destroyedOn) s.destroyedOn = destroyedOn
        else delete s.destroyedOn
        if (remark) s.remark = remark
        else delete s.remark
        const what = `${s.count} × ${sampleProductName(draft, target, s)} from ${target.batchId}`
        log(
          draft,
          destroyed ? 'Destroyed control samples' : restored ? 'Cleared control sample destruction' : 'Edited control samples',
          runId,
          destroyed
            ? `${what} destroyed on ${destroyedOn}${remark ? ` — ${remark}` : ''}.`
            : restored
              ? `${what} recorded as still kept.`
              : `${what} · collected by ${collectedBy}${remark ? ` · ${remark}` : ''}.`,
        )
        return draft
      })
      showToast(destroyedOn && !sample.destroyedOn ? 'Control samples recorded as destroyed.' : 'Control samples updated.')
      return runId
    },
    [log, setState, showToast, state.packingRuns],
  )

  return useMemo(
    () => ({
      createPackingRun,
      updatePackingRun,
      deletePackingRun,
      addPackingStock,
      updatePackingStock,
      deletePackingStock,
      updateControlSample,
    }),
    [
      createPackingRun,
      updatePackingRun,
      deletePackingRun,
      addPackingStock,
      updatePackingStock,
      deletePackingStock,
      updateControlSample,
    ],
  )
}
