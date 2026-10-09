/**
 * What the plant buys, and the packs it sells.
 *
 * Produce and packing material come in against a purchase product; a pack product is
 * the finished-goods SKU a packing run fills. Both mint the stock item the ledger
 * books against, which is why they are created here and nowhere else.
 */
import { useCallback, useMemo } from 'react'
import { itemUom } from '../../lib/batches'
import { bulkUomForUnit, mediumForUom, packDefs, toBase } from '../../lib/packs'
import type { PackDefInput, Problem } from '../../lib/posting'
import { itemName } from '../../lib/stock'
import { deepClone } from '../../lib/utils'
import type { Product, PurchaseProduct } from '../../types'
import { POSTED, type CoreDeps } from './deps'

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
    (
      id: string,
      input: { name: string; uom: string; description: string; vendorIds?: string[] },
    ): string | null => {
      const existing = state.purchaseProducts.find((p) => p.id === id)
      if (!existing) return null
      const error = checkPurchaseProduct(input, id)
      if (error) {
        showToast(error)
        return null
      }
      // the same rule add enforces: produce names who grew it, a packing
      // material may float free. Without it the edit dialog could legally
      // save a farm product with no supplier left.
      if (
        existing.category !== 'Packing Material' &&
        input.vendorIds !== undefined &&
        !input.vendorIds.length
      ) {
        showToast('Select at least one farmer or vendor.')
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
        // The edit dialog has always offered the supplier picker; the save used
        // to drop it here, so a changed supplier list silently kept the old one
        // (the Suppliers button on the card worked, the edit form did not).
        if (input.vendorIds) p.vendorIds = [...input.vendorIds]
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

  /** Shared by save and edit: what a pack must have before any of it can be saved.
   *  Returns the first problem, or null when the pack stands. */
  const checkPack = useCallback(
    (defKey: string | null, input: PackDefInput): Problem => {
      if (!input.name.trim()) return 'Give the pack a name.'
      if (!input.type.trim()) return 'Enter the pack type — BiB, Glass Bottle, Cover…'
      if (!(input.size > 0)) return 'Pack size must be greater than zero.'
      if (!input.recipes.length) {
        return 'A pack exists to be filled — assign at least one recipe. To drop the pack entirely, delete it from its card.'
      }
      if (input.bom.some((b) => !b.item || !(b.qty > 0))) {
        return 'Every packing material line needs an item and a quantity.'
      }
      // The pack being edited, as it stands now — null on create.
      const def = defKey ? packDefs(state.products).find((d) => d.key === defKey) : undefined
      if (defKey && !def) return null // it was deleted under us; the save is a no-op
      for (const r of input.recipes) {
        if (!r.name.trim()) return 'Give every recipe a name.'
        const bulkItem = r.skuId ? def?.members.find((m) => m.id === r.skuId)?.bulkItem : r.bulkItem
        const bulk = state.items.find((i) => i.id === bulkItem && i.type === 'Semi Finished')
        if (!bulk) return 'Choose the bulk each recipe is filled from.'
        // A pack sized in litres cannot be filled from something counted in kilograms —
        // the run would draw the right number and the wrong quantity.
        if (bulk.uom !== bulkUomForUnit(input.unit)) {
          return `${bulk.name} is held in ${bulk.uom.toLowerCase()}, so a pack sized in ${input.unit} cannot be filled from it.`
        }
        if (
          state.products.some(
            (p) =>
              p.id !== r.skuId && p.name.trim().toLowerCase() === r.name.trim().toLowerCase(),
          )
        ) {
          return `${r.name.trim()} already exists.`
        }
      }
      // Two new rows can share a name without either matching anything in state, and
      // would mint twin SKUs the rest of the app cannot tell apart.
      const names = input.recipes.map((r) => r.name.trim().toLowerCase())
      const dupName = names.find((n, i) => n && names.indexOf(n) !== i)
      if (dupName) {
        return `Two recipes are both named "${dupName}" — give each its own name.`
      }
      // Each recipe is one bulk — a bulk cannot be filled into the same pack twice,
      // whether both rows are new or one is a member the save keeps.
      const bulks = input.recipes.map((r) => {
        if (r.skuId) return def?.members.find((m) => m.id === r.skuId)?.bulkItem || r.skuId
        return r.bulkItem
      })
      const dup = bulks.find((b, i) => bulks.indexOf(b) !== i)
      if (dup) {
        // itemName without pulling all of `state` into the deps — the items list
        // is already one.
        const bulkName = state.items.find((i) => i.id === dup)?.name || dup
        return `${bulkName} is assigned to this pack twice — each recipe is its own bulk.`
      }
      // Recipes left off the list are being unassigned. Once a recipe has stock
      // history its SKU cannot be deleted, and unassigning IS deleting — the pack
      // is the group, so a member that leaves it leaves the app entirely.
      const kept = new Set(input.recipes.map((r) => r.skuId).filter(Boolean))
      const dropped = (def?.members ?? []).filter((m) => !kept.has(m.id))
      const packedOff = dropped.find((m) => state.ledger.some((l) => l.item === m.id))
      if (packedOff) {
        return `${packedOff.name} has already been packed — it has stock history and cannot be removed from the pack. Retire the pack instead if it is no longer filled.`
      }
      // Once a recipe has stock history, the fields that history was costed in are
      // frozen: a new pack unit re-dimensions every pack line any member has posted.
      // Size may still move — posted runs carry their own perPack copy.
      const unitChanged = def ? def.unit !== input.unit : false
      if (def && unitChanged) {
        const withHistory = def.members.some((m) => state.ledger.some((l) => l.item === m.id))
        if (withHistory) {
          return `${def.name} has stock history — its pack unit cannot change. Size and the rest may still be edited.`
        }
      }
      return null
    },
    [state.items, state.ledger, state.products],
  )

  /**
   * Saves a pack: one physical format — name, type, size, unit, what one pack is
   * made of — with a recipe list. Each recipe row is one finished SKU: a new bulk
   * gets its SKU minted, a kept one keeps its id, and a member left off the list is
   * unassigned (deleted, stock history permitting).
   *
   * The pack itself is not a record: the SKUs that share its name, type, size and
   * unit ARE it (lib/packs.ts). So the save writes the physicals onto every member,
   * and the catalog can never show a pack whose recipes disagree with it.
   */
  const savePack = useCallback(
    (defKey: string | null, input: PackDefInput): string | null => {
      const error = checkPack(defKey, input)
      if (error) {
        showToast(error)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const def = defKey ? packDefs(draft.products).find((d) => d.key === defKey) : undefined
        if (defKey && !def) return prev // deleted under us; nothing to edit
        const byId = new Map((def?.members ?? []).map((m) => [m.id, m]))
        // 1. recipes left off the list leave the pack — and with it the app
        const kept = new Set(input.recipes.map((r) => r.skuId).filter(Boolean))
        for (const m of def?.members ?? []) {
          if (kept.has(m.id)) continue
          draft.products = draft.products.filter((p) => p.id !== m.id)
          draft.items = draft.items.filter((i) => i.id !== m.id)
        }
        // 2. every row becomes a member: kept ones in place, new ones minted
        const members: Product[] = []
        for (const r of input.recipes) {
          let p = r.skuId ? draft.products.find((x) => x.id === r.skuId) : undefined
          const bulkItem = r.skuId ? byId.get(r.skuId)?.bulkItem : r.bulkItem
          if (!bulkItem) return prev
          const medium = mediumForUom(itemUom(draft, bulkItem))
          if (p) {
            p.name = r.name.trim()
            p.shelfLifeDays = r.shelfLifeDays
            p.chilledShelfLifeDays = r.chilledShelfLifeDays
            p.mrp = r.mrp
          } else {
            p = {
              id: nextId(draft, 'product'),
              name: r.name.trim(),
              type: input.type.trim(),
              size: input.size,
              unit: input.unit,
              packVolume: toBase(input.size, input.unit),
              shelfLifeDays: r.shelfLifeDays,
              chilledShelfLifeDays: r.chilledShelfLifeDays,
              mrp: r.mrp,
              bom: [],
              bulkItem,
              medium,
              retired: def?.retired,
            }
            draft.products.push(p)
            // The ledger books packs against an item, not a product, so a pack
            // product without its matching finished-goods item never reaches stock.
            draft.items.push({
              id: p.id,
              name: p.name,
              type: 'Finished Goods',
              // Malai is sold by weight, water by the pack.
              uom: medium === 'Malai' ? 'Kg' : 'Pack',
              lotControlled: true,
              reorder: 0,
              costMethod: 'Batch Actual',
            })
          }
          // 3. the physical pack itself, on every member alike
          p.type = input.type.trim()
          p.size = input.size
          p.unit = input.unit
          p.packVolume = toBase(input.size, input.unit)
          p.bom = input.bom.map((b) => ({ ...b }))
          p.packName = input.name.trim()
          const item = draft.items.find((i) => i.id === p.id)
          if (item) item.name = p.name
          members.push(p)
        }
        log(
          draft,
          def ? 'Edited pack' : 'Added pack',
          input.name.trim(),
          `${input.type.trim()}, ${input.size} ${input.unit} — ${members.length} recipe${
            members.length === 1 ? '' : 's'
          }: ${members.map((m) => itemName(draft, m.bulkItem || '')).join(', ')}.`,
        )
        return draft
      })
      showToast(`${input.name.trim()} saved.`)
      return POSTED
    },
    [checkPack, log, nextId, setState, showToast],
  )

  /**
   * Takes a pack off the line without touching its past. A retired pack is hidden
   * from new packing runs and planning; everything already posted — stock, stickers,
   * dispatch — keeps reading it. Deleting is the permanent version, and refuses
   * while any recipe has stock history.
   */
  const retirePack = useCallback(
    (defKey: string, retired: boolean) => {
      const def = packDefs(state.products).find((d) => d.key === defKey)
      if (!def) return
      setState((prev) => {
        const draft = deepClone(prev)
        for (const m of def.members) {
          const p = draft.products.find((x) => x.id === m.id)
          if (p) p.retired = retired || undefined
        }
        log(draft, retired ? 'Retired pack' : 'Restored pack', def.name, def.name)
        return draft
      })
      showToast(retired ? `${def.name} retired — it can be restored from its card.` : `${def.name} is back on the line.`)
    },
    [log, setState, showToast, state.products],
  )

  const deletePack = useCallback(
    (defKey: string) => {
      const def = packDefs(state.products).find((d) => d.key === defKey)
      if (!def) return
      // Same rule as one recipe: stock already packed is ledger history, and the
      // ledger is never rewritten. The pack names the first blocker so the office
      // knows retire is the option that fits.
      const packedOff = def.members.find((m) => state.ledger.some((l) => l.item === m.id))
      if (packedOff) {
        showToast(
          `${packedOff.name} has already been packed — it has stock history, so the pack cannot be deleted. Retire it instead.`,
        )
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const ids = new Set(def.members.map((m) => m.id))
        draft.products = draft.products.filter((p) => !ids.has(p.id))
        draft.items = draft.items.filter((i) => !ids.has(i.id))
        log(draft, 'Deleted pack', def.name, def.members.map((m) => m.name).join(', '))
        return draft
      })
      showToast(`${def.name} deleted.`)
    },
    [log, setState, showToast, state.ledger, state.products],
  )

  return useMemo(
    () => ({
      addPurchaseProduct,
      updatePurchaseProduct,
      deletePurchaseProduct,
      updatePurchaseProductVendors,
      savePack,
      retirePack,
      deletePack,
    }),
    [
      addPurchaseProduct,
      updatePurchaseProduct,
      deletePurchaseProduct,
      updatePurchaseProductVendors,
      savePack,
      retirePack,
      deletePack,
    ],
  )
}
