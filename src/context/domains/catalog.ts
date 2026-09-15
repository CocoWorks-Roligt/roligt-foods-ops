/**
 * What the plant buys, and the packs it sells.
 *
 * Produce and packing material come in against a purchase product; a pack product is
 * the finished-goods SKU a packing run fills. Both mint the stock item the ledger
 * books against, which is why they are created here and nowhere else.
 */
import { useCallback, useMemo } from 'react'
import { itemUom } from '../../lib/batches'
import { bulkUomForUnit, mediumForUom, toBase } from '../../lib/packs'
import type { ProductInput } from '../../lib/posting'
import { itemName } from '../../lib/stock'
import { deepClone } from '../../lib/utils'
import type { Product, PurchaseProduct } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'
import type { Problem } from '../../lib/posting'

export function useCatalog({ state, setState, nextId, log, showToast }: CoreDeps) {
  /** Shared by add and edit. The melange form has always guarded its names; this one
   *  did not, so two "Apple" records could sit side by side in the produce dropdown. */
  const checkPurchaseProduct = useCallback(
    (input: { name: string; vendorIds?: string[] }, id?: string): Problem => {
      const name = input.name.trim()
      if (!name) return 'Give the item a name.'
      if (
        state.purchaseProducts.some(
          (p) => p.id !== id && p.name.trim().toLowerCase() === name.toLowerCase(),
        )
      ) {
        return `${name} already exists — edit that one instead of adding a second.`
      }
      return null
    },
    [state.purchaseProducts],
  )

  const addPurchaseProduct = useCallback(
    (
      input: Omit<PurchaseProduct, 'id' | 'status' | 'itemId'> & { itemId?: string },
    ): string | null => {
      const error = checkPurchaseProduct(input)
      if (error) {
        showToast(error)
        return null
      }
      // Produce has to name who grew it, but a packing material is routinely bought
      // ad hoc off whoever has stock. Forcing a supplier here meant leaving the pack
      // form, creating a vendor and starting again just to add a carton.
      if (input.category !== 'Packing Material' && !input.vendorIds?.length) {
        showToast('Select at least one farmer or vendor.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'purchaseProduct')
        let itemId = input.itemId
        if (!itemId) {
          const prefix =
            input.category === 'Packing Material'
              ? 'PM'
              : input.category === 'Farm Produce'
                ? 'RM'
                : 'OT'
          itemId = `${prefix}-${id}`
          draft.items.push({
            id: itemId,
            name: input.name,
            type: input.category === 'Packing Material' ? 'Packing Material' : 'Raw Material',
            uom: input.uom || 'Piece',
            lotControlled: true,
            reorder: 0,
            costMethod: input.category === 'Packing Material' ? 'Weighted Avg' : 'Lot Actual',
          })
        }
        const pp: PurchaseProduct = {
          id,
          name: input.name.trim(),
          category: input.category,
          uom: input.uom || 'Piece',
          description: input.description || '',
          vendorIds: [...input.vendorIds],
          itemId,
          status: 'Active',
        }
        draft.purchaseProducts.push(pp)
        log(draft, 'Created purchase product', pp.id, pp.name)
        createdId = pp.id
        return draft
      })
      showToast('Product created.')
      return createdId || POSTED
    },
    [checkPurchaseProduct, log, nextId, setState, showToast],
  )

  const updatePurchaseProduct = useCallback(
    (id: string, input: { name: string; uom: string; description: string }): string | null => {
      const existing = state.purchaseProducts.find((p) => p.id === id)
      if (!existing) return null
      const error = checkPurchaseProduct(input, id)
      if (error) {
        showToast(error)
        return null
      }
      // Stock already received was counted in the old unit and the ledger is never
      // rewritten, so a unit only moves while nothing has been bought yet.
      const received = state.ledger.some((l) => l.item === existing.itemId)
      if (received && existing.uom !== input.uom) {
        showToast(`${existing.name} has already been received, so it stays measured in ${existing.uom}.`)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const p = draft.purchaseProducts.find((x) => x.id === id)
        if (!p) return prev
        p.name = input.name.trim()
        p.uom = input.uom
        p.description = input.description
        const item = draft.items.find((i) => i.id === p.itemId)
        if (item) {
          item.name = p.name
          item.uom = p.uom
        }
        log(draft, 'Edited item', id, p.name)
        return draft
      })
      showToast(`${input.name.trim()} updated.`)
      return id
    },
    [checkPurchaseProduct, log, setState, showToast, state.ledger, state.purchaseProducts],
  )

  const deletePurchaseProduct = useCallback(
    (id: string) => {
      const p = state.purchaseProducts.find((x) => x.id === id)
      if (!p) return
      if (state.grns.some((g) => g.purchaseProductId === id)) {
        showToast(`Cannot delete: ${p.name} has receipts on record.`)
        return
      }
      if (p.itemId && state.ledger.some((l) => l.item === p.itemId)) {
        showToast(`Cannot delete: ${p.name} has stock history.`)
        return
      }
      const pack = state.products.find((x) => x.bom.some((b) => b.item === p.itemId))
      if (pack) {
        showToast(`Cannot delete: ${pack.name} consumes ${p.name}.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.purchaseProducts = draft.purchaseProducts.filter((x) => x.id !== id)
        if (p.itemId) draft.items = draft.items.filter((i) => i.id !== p.itemId)
        log(draft, 'Deleted item', id, p.name)
        return draft
      })
      showToast(`${p.name} deleted.`)
    },
    [log, setState, showToast, state.grns, state.ledger, state.products, state.purchaseProducts],
  )

  const updatePurchaseProductVendors = useCallback(
    (id: string, vendorIds: string[]) => {
      if (!vendorIds.length) {
        showToast('Select at least one farmer or vendor.')
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const p = draft.purchaseProducts.find((x) => x.id === id)
        if (!p) return prev
        p.vendorIds = [...vendorIds]
        log(draft, 'Updated product suppliers', id, `${vendorIds.length} linked sources`)
        return draft
      })
      showToast('Suppliers updated.')
    },
    [log, setState, showToast],
  )

  /** Shared by add and edit: what a pack product must have before it can be saved. */
  const checkProduct = useCallback(
    (input: ProductInput, id?: string): Problem => {
      if (!input.name.trim()) return 'Give the pack product a name.'
      if (!input.type.trim()) return 'Enter the pack type — BiB, Glass Bottle, Cover…'
      if (!(input.size > 0)) return 'Pack size must be greater than zero.'
      if (!(input.shelfLifeDays > 0)) return 'Shelf life must be at least one day.'
      const bulk = state.items.find((i) => i.id === input.bulkItem && i.type === 'Semi Finished')
      if (!bulk) return 'Choose the bulk this pack is filled from.'
      // A pack sized in litres cannot be filled from something counted in kilograms —
      // the run would draw the right number and the wrong quantity.
      if (bulk.uom !== bulkUomForUnit(input.unit)) {
        return `${bulk.name} is held in ${bulk.uom.toLowerCase()}, so a pack sized in ${input.unit} cannot be filled from it.`
      }
      if (
        state.products.some(
          (p) => p.id !== id && p.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
        )
      ) {
        return `${input.name.trim()} already exists.`
      }
      if (input.bom.some((b) => !b.item || !(b.qty > 0))) {
        return 'Every packing material line needs an item and a quantity.'
      }
      return null
    },
    [state.items, state.products],
  )

  const addProduct = useCallback(
    (input: ProductInput): string | null => {
      const error = checkProduct(input)
      if (error) {
        showToast(error)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'product')
        const medium = mediumForUom(itemUom(draft, input.bulkItem))
        const p: Product = {
          id,
          name: input.name.trim(),
          type: input.type.trim(),
          size: input.size,
          unit: input.unit,
          packVolume: toBase(input.size, input.unit),
          shelfLifeDays: input.shelfLifeDays,
          chilledShelfLifeDays: input.chilledShelfLifeDays,
          mrp: input.mrp,
          bom: input.bom.map((b) => ({ ...b })),
          bulkItem: input.bulkItem,
          medium,
        }
        draft.products.push(p)
        // The ledger books packs against an item, not a product, so a pack product
        // without its matching finished-goods item could never reach stock.
        draft.items.push({
          id,
          name: p.name,
          type: 'Finished Goods',
          // Malai is sold by weight, water by the pack.
          uom: medium === 'Malai' ? 'Kg' : 'Pack',
          lotControlled: true,
          reorder: 0,
          costMethod: 'Batch Actual',
        })
        log(
          draft,
          'Added pack product',
          id,
          `${p.name} — ${p.type}, ${p.size} ${p.unit}, filled from ${itemName(draft, input.bulkItem)}.`,
        )
        createdId = id
        return draft
      })
      showToast(`${input.name.trim()} added.`)
      return createdId || POSTED
    },
    [checkProduct, log, nextId, setState, showToast],
  )

  const updateProduct = useCallback(
    (id: string, input: ProductInput): string | null => {
      const error = checkProduct(input, id)
      if (error) {
        showToast(error)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const p = draft.products.find((x) => x.id === id)
        if (!p) return prev
        const medium = mediumForUom(itemUom(draft, input.bulkItem))
        p.name = input.name.trim()
        p.type = input.type.trim()
        p.size = input.size
        p.unit = input.unit
        p.packVolume = toBase(input.size, input.unit)
        p.shelfLifeDays = input.shelfLifeDays
        p.chilledShelfLifeDays = input.chilledShelfLifeDays
        p.mrp = input.mrp
        p.bom = input.bom.map((b) => ({ ...b }))
        p.bulkItem = input.bulkItem
        p.medium = medium
        const item = draft.items.find((i) => i.id === id)
        if (item) {
          item.name = p.name
          item.uom = medium === 'Malai' ? 'Kg' : 'Pack'
        }
        // Runs already posted keep the size they were filled at — `perPack` on each
        // packing line is a copy, so nothing here reaches back into stock.
        log(draft, 'Edited pack product', id, `${p.name} — ${p.type}, ${p.size} ${p.unit}.`)
        return draft
      })
      showToast(`${input.name.trim()} updated.`)
      return id
    },
    [checkProduct, log, setState, showToast],
  )

  const deleteProduct = useCallback(
    (id: string) => {
      const p = state.products.find((x) => x.id === id)
      if (!p) return
      if (state.ledger.some((l) => l.item === id)) {
        showToast(`${p.name} has already been packed — it has stock history and cannot be deleted.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.products = draft.products.filter((x) => x.id !== id)
        draft.items = draft.items.filter((i) => i.id !== id)
        log(draft, 'Deleted pack product', id, p.name)
        return draft
      })
      showToast(`${p.name} deleted.`)
    },
    [log, setState, showToast, state.ledger, state.products],
  )

  return useMemo(
    () => ({
      addPurchaseProduct,
      updatePurchaseProduct,
      deletePurchaseProduct,
      updatePurchaseProductVendors,
      addProduct,
      updateProduct,
      deleteProduct,
    }),
    [
      addPurchaseProduct,
      updatePurchaseProduct,
      deletePurchaseProduct,
      updatePurchaseProductVendors,
      addProduct,
      updateProduct,
      deleteProduct,
    ],
  )
}
