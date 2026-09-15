/**
 * Goods receipts — what arrived at the gate, graded and priced into a lot.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { itemUom } from '../../lib/batches'
import { grnCostsChanged, priceGrn } from '../../lib/grn'
import type { GrnInput } from '../../lib/grn'
import { defaultRawStore, checkArea, postedLocation } from '../../lib/posting'
import { itemName } from '../../lib/stock'
import { deepClone, nowISO, uid } from '../../lib/utils'
import type { Grn } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useProcurement({ state, setState, nextId, nextLot, log, showToast, announcement }: CoreDeps) {
  const createGrn = useCallback(
    (input: GrnInput): string | null => {
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
          status: 'Posted',
          notes: input.notes,
        }
        draft.grns.push(g)
        draft.ledger.push({
          id: uid('LED'),
          type: 'Receipt',
          doc: id,
          item: itemId,
          itemType: 'Raw Material',
          lot,
          location,
          status: 'Available',
          qtyIn: math.accepted,
          qtyOut: 0,
          uom,
          unitCost: g.usableCost,
          time: nowISO(),
        })
        log(
          draft,
          'Posted receipt',
          id,
          `Created ${lot}; accepted ${math.accepted} of ${input.total} ${uom.toLowerCase()} of ${g.productName}${input.free ? ` (${input.free} free)` : ''}.`,
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
    (id: string, input: GrnInput): string | null => {
      const existing = state.grns.find((x) => x.id === id)
      if (!existing) return null
      const math = priceGrn(input)
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
      if (!g) return
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
