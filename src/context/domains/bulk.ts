/**
 * Bulk products and the blends made from them.
 *
 * A bulk product is what an extraction presses out — coconut water, beetroot juice.
 * A melange is a recipe over those, and owns the bulk item it is booked as, so
 * blended stock is never mistaken for the single-fruit juice it was made from.
 */
import { useCallback, useMemo } from 'react'
import { bulkItemOf } from '../../lib/packs'
import { BY_PRODUCT_COST_METHOD, type Problem } from '../../lib/posting'
import type { BulkProductInput, MelangeInput } from '../../lib/posting'
import { itemName } from '../../lib/stock'
import { deepClone } from '../../lib/utils'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useBulkProducts({ state, setState, nextId, log, showToast }: CoreDeps) {
  /** Litre or kilogram — the only two units bulk is ever held in. */
  const checkBulkProduct = useCallback(
    (input: BulkProductInput, id?: string): Problem => {
      if (!input.name.trim()) return 'Give the bulk product a name.'
      if (input.uom !== 'Litre' && input.uom !== 'Kg') return 'Bulk is measured in litres or kilograms.'
      if (
        state.items.some(
          (i) => i.id !== id && i.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
        )
      ) {
        return `${input.name.trim()} already exists.`
      }
      return null
    },
    [state.items],
  )

  const addBulkProduct = useCallback(
    (input: BulkProductInput): string | null => {
      const error = checkBulkProduct(input)
      if (error) {
        showToast(error)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'bulkProduct')
        draft.items.push({
          id,
          name: input.name.trim(),
          type: 'Semi Finished',
          uom: input.uom,
          lotControlled: true,
          reorder: 0,
          costMethod: input.byProduct ? BY_PRODUCT_COST_METHOD : 'Batch Actual',
        })
        log(
          draft,
          'Added bulk product',
          id,
          `${input.name.trim()} — measured in ${input.uom}${input.byProduct ? ', a by-product carrying no batch cost' : ''}.`,
        )
        createdId = id
        return draft
      })
      showToast(`${input.name.trim()} added.`)
      return createdId || POSTED
    },
    [checkBulkProduct, log, nextId, setState, showToast],
  )

  const updateBulkProduct = useCallback(
    (id: string, input: BulkProductInput): string | null => {
      const existing = state.items.find((i) => i.id === id)
      if (!existing) return null
      const error = checkBulkProduct(input, id)
      if (error) {
        showToast(error)
        return null
      }
      // Stock already booked is counted in the old unit, and the ledger is never
      // rewritten — so once a bulk has history, its unit is fixed.
      if (existing.uom !== input.uom && state.ledger.some((l) => l.item === id)) {
        showToast(`${existing.name} already has stock history, so it stays measured in ${existing.uom}.`)
        return null
      }
      // A melange owns the bulk it is booked as, and is the only place that names it.
      // While both were editable the two had to rename each other to stay in step,
      // which is exactly why the recipe is now the single owner.
      const owner = state.melanges.find((m) => m.outputItem === id)
      if (owner) {
        showToast(`${existing.name} belongs to the ${owner.name} melange — edit it there.`)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const item = draft.items.find((i) => i.id === id)
        if (!item) return prev
        item.name = input.name.trim()
        item.uom = input.uom
        item.costMethod = input.byProduct ? BY_PRODUCT_COST_METHOD : 'Batch Actual'
        log(draft, 'Edited bulk product', id, `${item.name} — measured in ${item.uom}.`)
        return draft
      })
      showToast(`${input.name.trim()} updated.`)
      return id
    },
    [checkBulkProduct, log, setState, showToast, state.items, state.ledger, state.melanges],
  )

  const deleteBulkProduct = useCallback(
    (id: string) => {
      const item = state.items.find((i) => i.id === id)
      if (!item) return
      if (state.ledger.some((l) => l.item === id)) {
        showToast(`${item.name} has stock history and cannot be deleted.`)
        return
      }
      const melange = state.melanges.find(
        (m) => m.outputItem === id || m.components.some((c) => c.item === id),
      )
      if (melange) {
        showToast(`Cannot delete: ${melange.name} uses ${item.name}. Change that recipe first.`)
        return
      }
      const pack = state.products.find((p) => bulkItemOf(p) === id)
      if (pack) {
        showToast(`Cannot delete: ${pack.name} is filled from ${item.name}.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.items = draft.items.filter((i) => i.id !== id)
        log(draft, 'Deleted bulk product', id, item.name)
        return draft
      })
      showToast(`${item.name} deleted.`)
    },
    [log, setState, showToast, state.items, state.ledger, state.melanges, state.products],
  )

  /** Shared by add and edit: what a blend formulation must have before it can be saved. */
  const checkMelange = useCallback(
    (input: MelangeInput, id?: string): Problem => {
      const name = input.name.trim()
      if (!name) return 'Give the melange a name — ABC Juice, Tropical Blend…'
      if (state.melanges.some((m) => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) {
        return `${name} already exists.`
      }
      if (input.uom !== 'Litre' && input.uom !== 'Kg') return 'A blend is measured in litres or kilograms.'
      const lines = input.components.filter((c) => c.item && c.share > 0)
      if (lines.length < 2) return 'A melange blends at least two bulk components.'
      if (new Set(lines.map((c) => c.item)).size !== lines.length) {
        return 'Each component can only be listed once.'
      }
      for (const c of lines) {
        const item = state.items.find((i) => i.id === c.item && i.type === 'Semi Finished')
        if (!item) return 'Every component must be a bulk product.'
      }
      const total = lines.reduce((a, c) => a + c.share, 0)
      if (Math.abs(total - 100) > 0.01) {
        return `Component shares add up to ${Number(total.toFixed(2))}% — they must total 100%.`
      }
      return null
    },
    [state.items, state.melanges],
  )

  const addMelange = useCallback(
    (input: MelangeInput): string | null => {
      const error = checkMelange(input)
      if (error) {
        showToast(error)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'melange')
        // The recipe owns the bulk it is booked as, so blended stock is never mistaken
        // for the single-fruit juice it was made from.
        const outputItem = `SF-${id}`
        const name = input.name.trim()
        draft.items.push({
          id: outputItem,
          name: `${name} (bulk)`,
          type: 'Semi Finished',
          uom: input.uom,
          lotControlled: true,
          reorder: 0,
          costMethod: 'Batch Actual',
        })
        draft.melanges.push({
          id,
          name,
          outputItem,
          uom: input.uom,
          components: input.components
            .filter((c) => c.item && c.share > 0)
            .map((c) => ({ ...c })),
          description: input.description || '',
          status: 'Active',
        })
        log(
          draft,
          'Added melange recipe',
          id,
          `${name} — ${input.components.filter((c) => c.item && c.share > 0).map((c) => `${c.share}% ${itemName(draft, c.item)}`).join(', ')}.`,
        )
        createdId = id
        return draft
      })
      showToast(`${input.name.trim()} added.`)
      return createdId || POSTED
    },
    [checkMelange, log, nextId, setState, showToast],
  )

  const updateMelange = useCallback(
    (id: string, input: MelangeInput): string | null => {
      const existing = state.melanges.find((m) => m.id === id)
      if (!existing) return null
      const error = checkMelange(input, id)
      if (error) {
        showToast(error)
        return null
      }
      if (existing.uom !== input.uom && state.ledger.some((l) => l.item === existing.outputItem)) {
        showToast(`${existing.name} has already been blended, so it stays measured in ${existing.uom}.`)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const m = draft.melanges.find((x) => x.id === id)
        if (!m) return prev
        m.name = input.name.trim()
        m.uom = input.uom
        // Runs already posted keep the shares they were blended at — the recipe is a
        // starting point for the next run, not a rule the ledger is measured against.
        m.components = input.components.filter((c) => c.item && c.share > 0).map((c) => ({ ...c }))
        m.description = input.description || ''
        const item = draft.items.find((i) => i.id === m.outputItem)
        if (item) {
          item.name = `${m.name} (bulk)`
          item.uom = m.uom
        }
        log(draft, 'Edited melange recipe', id, m.name)
        return draft
      })
      showToast(`${input.name.trim()} updated.`)
      return id
    },
    [checkMelange, log, setState, showToast, state.ledger, state.melanges],
  )

  const setMelangeStatus = useCallback(
    (id: string, status: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const m = draft.melanges.find((x) => x.id === id)
        if (!m) return prev
        m.status = status
        log(draft, 'Updated melange recipe', id, `${m.name} set ${status}.`)
        return draft
      })
      showToast('Recipe status updated.')
    },
    [log, setState, showToast],
  )

  const deleteMelange = useCallback(
    (id: string) => {
      const m = state.melanges.find((x) => x.id === id)
      if (!m) return
      const run = state.batches.find((b) => b.melangeId === id)
      if (run) {
        showToast(`Cannot delete: ${run.id} was blended to this recipe. Deactivate it instead.`)
        return
      }
      if (state.ledger.some((l) => l.item === m.outputItem)) {
        showToast(`${m.name} has stock history. Deactivate it instead of deleting.`)
        return
      }
      const pack = state.products.find((p) => bulkItemOf(p) === m.outputItem)
      if (pack) {
        showToast(`Cannot delete: ${pack.name} is filled from ${m.name}.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.melanges = draft.melanges.filter((x) => x.id !== id)
        draft.items = draft.items.filter((i) => i.id !== m.outputItem)
        log(draft, 'Deleted melange recipe', id, m.name)
        return draft
      })
      showToast(`${m.name} deleted.`)
    },
    [log, setState, showToast, state.batches, state.ledger, state.melanges, state.products],
  )

  return useMemo(
    () => ({
      addBulkProduct,
      updateBulkProduct,
      deleteBulkProduct,
      addMelange,
      updateMelange,
      setMelangeStatus,
      deleteMelange,
    }),
    [
      addBulkProduct,
      updateBulkProduct,
      deleteBulkProduct,
      addMelange,
      updateMelange,
      setMelangeStatus,
      deleteMelange,
    ],
  )
}
