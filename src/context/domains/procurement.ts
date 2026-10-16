/**
 * Goods receipts — what arrived at the gate, graded and priced into a lot.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { itemUom } from '../../lib/batches'
import { QTY_EPSILON } from '../../lib/utils'
import { asReceived, grnCostsChanged, priceGrn } from '../../lib/grn'
import type { GrnInput } from '../../lib/grn'
import { defaultRawStore, checkArea, postedLocation } from '../../lib/posting'
import { itemName } from '../../lib/stock'
import { deepClone, nowISO, uid } from '../../lib/utils'
import type { Grn } from '../../types'
import { POSTED, goneFromDevice } from './deps'
import type { CoreDeps } from './deps'

export function useProcurement({ state, setState, nextId, nextLot, log, showToast, announcement }: CoreDeps) {
  const createGrn = useCallback(
    (given: GrnInput): string | null => {
      // Weighed produce is not graded: stored with no free quantity and all of it in A.
      const input = asReceived(given)
      const math = priceGrn(input)
      if (!math.ok) {
        showToast(math.error)
        return null
      }
      // The form only offers products that exist, so a missing one means the master
      // moved under an open dialog — posting anyway would book stock against nothing.
      const product = state.purchaseProducts.find((p) => p.id === input.purchaseProductId)
      if (!product) {
        showToast('That product is no longer in the master. Pick the produce again.')
        return null
      }

      const badArea = checkArea(state, input.location || defaultRawStore(state), 'Raw Material')
      if (badArea) {
        showToast(badArea)
        return null
      }

      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const farmer = input.farmerId
          ? draft.vendors.find((f) => f.id === input.farmerId)
          : undefined
        if (input.farmerId && !farmer) return prev
        const id = nextId(draft, 'grn')
        const lot = nextLot(draft)
        const bought = draft.purchaseProducts.find((p) => p.id === input.purchaseProductId)
        const itemId = input.itemId || bought?.itemId || product.itemId || ''
        const uom = input.uom || bought?.uom || itemUom(draft, itemId)
        const location = input.location || defaultRawStore(draft) || ''
        // A staged load is booked unsorted: no grades, the whole count held for
        // the grading form to sort (its ledger line waits in Quarantine, and
        // the grading endpoint's paired lines move it out per grade).
        const staged = input.gradingMode === 'staged'
        const g: Grn = {
          id,
          date: new Date(input.date).toISOString(),
          purchaseProductId: bought?.id,
          itemId,
          uom,
          location,
          productName: bought?.name || itemName(draft, itemId),
          farmerId: farmer?.id || '',
          farmerName: farmer?.name || '',
          farmer: input.farmer?.trim() || '',
          area: input.area?.trim() || '',
          harvestedOn: input.harvestedOn || '',
          lot,
          total: input.total,
          free: input.free,
          a: staged ? 0 : input.a,
          b: staged ? 0 : input.b,
          c: staged ? 0 : input.c,
          reject: staged ? 0 : input.reject,
          rate: input.rate,
          transport: input.transport,
          accepted: math.accepted,
          materialValue: math.material,
          landed: math.landed,
          grossCost: math.grossCost,
          usableCost: math.usableCost,
          status: 'Posted',
          notes: input.notes,
          ...(input.gradingMode ? { gradingMode: input.gradingMode } : {}),
          ...(input.poId ? { poId: input.poId } : {}),
        }
        draft.grns.push(g)
        draft.ledger.push({
          id: uid('LED'),
          type: 'Receipt',
          doc: id,
          item: itemId,
          // The ITEM master's own type, not a hardcoded one: a ready extract
          // (READY_EXTRACT route — "into inventory as-is") is Semi Finished
          // stock, and a hardcoded 'Raw Material' hides its lot from the blend
          // stage's fold (blendableLots reads itemType — Phase-6 Journey B's
          // finding). Graded farm produce stays 'Raw Material' because its
          // items are.
          itemType: draft.items.find((i) => i.id === itemId)?.type ?? 'Raw Material',
          lot,
          location,
          status: staged ? 'Quarantine' : 'Available',
          qtyIn: math.accepted,
          qtyOut: 0,
          uom,
          unitCost: g.usableCost,
          // The supplier rides the ledger line, as PM receipts always did — so a
          // receipt line names who it came from without a trip to its GRN.
          vendorId: g.farmerId,
          time: nowISO(),
        })
        log(
          draft,
          'Posted receipt',
          id,
          staged
            ? `Created ${lot}; ${input.total} ${uom.toLowerCase()} of ${g.productName} received and held for grading.`
            : `Created ${lot}; accepted ${math.accepted} of ${input.total} ${uom.toLowerCase()} of ${g.productName}${input.free ? ` (${input.free} free)` : ''}.`,
        )
        createdId = id
        announcement.current = `${id} posted.`
        return draft
      })
      return createdId || POSTED
    },
    [announcement, log, nextId, nextLot, setState, showToast, state.purchaseProducts],
  )

  const updateGrn = useCallback(
    (id: string, given: GrnInput): string | null => {
      const input = asReceived(given)
      const existing = state.grns.find((x) => x.id === id)
      if (!existing) {
        showToast(goneFromDevice('GRN'))
        return null
      }
      // A staged lot's numbers belong to the grading endpoint: it re-derives
      // the costs and books the grade lines from the load the gate counted, so
      // grades typed here would fork that record, and a re-count would strand
      // the held ledger line. Farmer, area, harvest date and notes stay
      // editable; a mis-counted staged lot is deleted and received again.
      let priced = input
      if (existing.gradingMode === 'staged') {
        if (input.a + input.b + input.c + input.reject > QTY_EPSILON) {
          showToast(
            'This lot is waiting to be graded — its grades are recorded from Pipeline → Grading, not on this form.',
          )
          return null
        }
        if (grnCostsChanged(existing, input)) {
          showToast(
            'This lot is staged for grading, so its count and money are frozen until it is graded. If the gate mis-counted it, delete the receipt and receive it again.',
          )
          return null
        }
        priced = { ...input, gradingMode: 'staged' }
      }
      const math = priceGrn(priced)
      if (!math.ok) {
        showToast(math.error)
        return null
      }
      const product = state.purchaseProducts.find((p) => p.id === input.purchaseProductId)
      if (!product) {
        showToast('That product is no longer in the master. Pick the produce again.')
        return null
      }
      // Stock issued from this lot was costed at the posted rate and is already
      // sitting in a batch, so the quantities and money behind it can no longer move.
      const consumed = state.ledger.some((l) => l.lot === existing.lot && l.qtyOut > 0)
      const itemChanged =
        !!input.itemId && !!existing.itemId && input.itemId !== existing.itemId
      if (consumed && (grnCostsChanged(existing, input) || itemChanged)) {
        showToast(
          'This lot is already in production — only farmer, area, harvest date and notes can be edited.',
        )
        return null
      }
      // Stock taken or moved out of this lot left from where the receipt put it, and those
      // lines say so. Changing where it was received would leave that area short and the
      // new one holding stock that is not there.
      const receivedIn = existing.location || postedLocation(state, id, 'Raw Material')
      const putAway = input.location || receivedIn || defaultRawStore(state)
      if (consumed && putAway !== receivedIn) {
        showToast(
          `Stock from ${existing.lot} has already been used or moved — move what is left from the Storage page instead of changing where it was received.`,
        )
        return null
      }
      const badArea = checkArea(state, putAway, 'Raw Material', { keep: receivedIn })
      if (badArea) {
        showToast(badArea)
        return null
      }

      setState((prev) => {
        const draft = deepClone(prev)
        const idx = draft.grns.findIndex((x) => x.id === id)
        if (idx < 0) return prev
        const vendor = input.farmerId
          ? draft.vendors.find((f) => f.id === input.farmerId)
          : undefined
        if (input.farmerId && !vendor) return prev
        const bought = draft.purchaseProducts.find((p) => p.id === input.purchaseProductId)
        const itemId = input.itemId || bought?.itemId || draft.grns[idx].itemId || ''
        const uom = input.uom || bought?.uom || draft.grns[idx].uom || itemUom(draft, itemId)
        const location = input.location || draft.grns[idx].location || defaultRawStore(draft) || ''
        const g: Grn = {
          ...draft.grns[idx],
          date: new Date(input.date).toISOString(),
          purchaseProductId: bought?.id,
          itemId,
          uom,
          location,
          productName: bought?.name || itemName(draft, itemId),
          farmerId: vendor?.id || '',
          farmerName: vendor?.name || '',
          farmer: input.farmer?.trim() || '',
          area: input.area?.trim() || '',
          harvestedOn: input.harvestedOn || '',
          total: input.total,
          free: input.free,
          a: input.a,
          b: input.b,
          c: input.c,
          reject: input.reject,
          rate: input.rate,
          transport: input.transport,
          accepted: math.accepted,
          materialValue: math.material,
          landed: math.landed,
          grossCost: math.grossCost,
          usableCost: math.usableCost,
          notes: input.notes,
        }
        draft.grns[idx] = g
        // Keep the receipt line in step, or stock and its valuation drift from the GRN.
        const receipt = draft.ledger.find((l) => l.doc === id && l.type === 'Receipt')
        if (receipt) {
          receipt.qtyIn = math.accepted
          receipt.unitCost = math.usableCost
          receipt.item = itemId
          receipt.uom = uom
          receipt.location = location
          receipt.vendorId = g.farmerId
        }
        log(
          draft,
          'Edited receipt',
          id,
          `Updated ${g.lot}; accepted ${math.accepted} of ${input.total} ${uom.toLowerCase()} of ${g.productName}${input.free ? ` (${input.free} free)` : ''}.`,
        )
        return draft
      })
      showToast(`${id} updated.`)
      return id
    },
    [log, setState, showToast, state.grns, state.ledger, state.purchaseProducts],
  )

  const deleteGrn = useCallback(
    (id: string) => {
      const g = state.grns.find((x) => x.id === id)
      if (!g) {
        showToast(goneFromDevice('GRN', 'try again'))
        return
      }
      if (state.ledger.some((l) => l.lot === g.lot && l.qtyOut > 0)) {
        showToast('Cannot delete: coconuts from this lot have already been used in production.')
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.grns = draft.grns.filter((x) => x.id !== id)
        draft.ledger = draft.ledger.filter((l) => l.doc !== id)
        log(draft, 'Deleted receipt', id, `Removed ${g.lot} and its raw-material stock.`)
        return draft
      })
      showToast('GRN deleted; raw-material stock recalculated.')
    },
    [log, setState, showToast, state.grns, state.ledger],
  )

  return useMemo(
    () => ({
      createGrn,
      updateGrn,
      deleteGrn,
    }),
    [
      createGrn,
      updateGrn,
      deleteGrn,
    ],
  )
}
