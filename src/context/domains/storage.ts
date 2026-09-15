/**
 * The storage areas stock can sit in — one list, each with a type — and where new stock
 * goes by default.
 *
 * Every change that could strand stock or break a storage rule is refused here, not just
 * hidden on a screen: an area cannot become a type that may not hold what is inside it,
 * the default area for a kind of stock cannot be switched off, and nothing that has ever
 * held stock or that a document names can be deleted.
 */

import { useCallback, useMemo } from 'react'
import type { StorageLocationInput } from '../../lib/posting'
import {
  AREA_PURPOSES,
  STORAGE_TYPES,
  areaDeleteBlocker,
  areaRefusal,
  defaultsOf,
  fmtRowTotal,
  itemTypeLabel,
  stockRows,
  storageTypeLabel,
} from '../../lib/stock'
import { deepClone, QTY_EPSILON, statusLabel } from '../../lib/utils'
import type { AreaPurpose, StorageType } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

const listed = (labels: string[]) => labels.map((l) => l.toLowerCase()).join(' and ')
const isType = (type: string): type is StorageType => STORAGE_TYPES.some((t) => t.value === type)

export function useStorageLocations({ state, setState, nextId, log, showToast }: CoreDeps) {
  /** What an area is holding right now. */
  const holding = useCallback(
    (name: string) => stockRows(state).filter((r) => r.location === name && r.qty > QTY_EPSILON),
    [state],
  )

  const addStorageLocation = useCallback(
    (input: StorageLocationInput): string | null => {
      const label = input.label.trim()
      if (!label) {
        showToast('Give the storage area a name.')
        return null
      }
      if (!isType(input.type)) {
        showToast('Pick what kind of storage area it is — cold room, dry store or hold area.')
        return null
      }
      if (state.storageLocations.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
        showToast(`There is already a storage area called ${label}.`)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const id = nextId(draft, 'storageLocation')
        // The ledger key is fixed at creation and hidden from the UI, so the visible
        // name can be corrected later without stranding any stock.
        let key = label
        for (let n = 2; draft.storageLocations.some((s) => s.name === key); n++) key = `${label} ${n}`
        draft.storageLocations.push({
          id,
          name: key,
          label,
          holds: (input.holds || '').trim(),
          type: input.type,
          status: 'Active',
        })
        log(draft, 'Added storage area', id, `${label} (${storageTypeLabel(input.type).toLowerCase()}).`)
        createdId = id
        return draft
      })
      showToast(`${label} added.`)
      return createdId || POSTED
    },
    [log, nextId, setState, showToast, state.storageLocations],
  )

  const updateStorageLocation = useCallback(
    (id: string, patch: StorageLocationInput): string | null => {
      const existing = state.storageLocations.find((s) => s.id === id)
      if (!existing) return null
      const label = patch.label.trim()
      if (!label) {
        showToast('Give the storage area a name.')
        return null
      }
      if (!isType(patch.type)) {
        showToast('Pick what kind of storage area it is — cold room, dry store or hold area.')
        return null
      }
      if (
        state.storageLocations.some(
          (s) => s.id !== id && s.label.toLowerCase() === label.toLowerCase(),
        )
      ) {
        showToast(`There is already a storage area called ${label}.`)
        return null
      }
      if (patch.type !== existing.type) {
        // Judged as the area will be once open, so an inactive area's stock is measured
        // against the new type rather than refused for the area being inactive.
        const retyped = { ...existing, type: patch.type, status: 'Active' }
        const misfit = holding(existing.name).find((r) => areaRefusal(retyped, r.itemType, r.status))
        if (misfit) {
          showToast(
            `${existing.label} is holding ${itemTypeLabel(misfit.itemType).toLowerCase()} (${statusLabel(misfit.status).toLowerCase()}), which a ${storageTypeLabel(patch.type).toLowerCase()} cannot take. Move it out before changing the type.`,
          )
          return null
        }
        const purposes = defaultsOf(state, existing).filter((p) => areaRefusal(retyped, p.itemType))
        if (purposes.length) {
          showToast(
            `${existing.label} is the default for ${listed(purposes.map((p) => p.label))}, which a ${storageTypeLabel(patch.type).toLowerCase()} cannot take. Choose another default first.`,
          )
          return null
        }
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const s = draft.storageLocations.find((x) => x.id === id)
        if (!s) return prev
        // `name` is deliberately untouched — it is what the ledger points at.
        s.label = label
        s.holds = (patch.holds || '').trim()
        s.type = patch.type
        log(draft, 'Updated storage area', id, `${label} (${storageTypeLabel(patch.type).toLowerCase()}).`)
        return draft
      })
      showToast(`${label} updated.`)
      return id
    },
    [holding, log, setState, showToast, state],
  )

  const setStorageLocationStatus = useCallback(
    (id: string, status: string): string | null => {
      const area = state.storageLocations.find((x) => x.id === id)
      if (!area) return null
      if (status !== 'Active') {
        const purposes = defaultsOf(state, area)
        if (purposes.length) {
          showToast(
            `${area.label} is the default for ${listed(purposes.map((p) => p.label))}. Choose another default before deactivating it.`,
          )
          return null
        }
      }
      const inside = status === 'Active' ? [] : holding(area.name)
      setState((prev) => {
        const draft = deepClone(prev)
        const s = draft.storageLocations.find((x) => x.id === id)
        if (!s) return prev
        s.status = status
        log(draft, 'Updated storage area', id, `${s.label} set ${status.toLowerCase()}.`)
        return draft
      })
      showToast(
        status === 'Active'
          ? `${area.label} reactivated — new stock can go into it again.`
          : `${area.label} deactivated — nothing new will be put into it.${
              inside.length ? ` It still holds ${fmtRowTotal(inside)}; move that out from its card.` : ''
            }`,
      )
      return id
    },
    [holding, log, setState, showToast, state],
  )

  /** Makes an area the one new stock of a kind goes into unless somebody picks another. */
  const setDefaultArea = useCallback(
    (purpose: AreaPurpose, id: string): string | null => {
      const p = AREA_PURPOSES.find((x) => x.key === purpose)
      const area = state.storageLocations.find((s) => s.id === id)
      if (!p || !area) return null
      const refusal = areaRefusal(area, p.itemType)
      if (refusal) {
        showToast(refusal)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.config.defaultAreas = { ...(draft.config.defaultAreas || {}), [purpose]: id }
        log(draft, 'Set default storage area', id, `Default for ${p.label.toLowerCase()}: ${area.label}.`)
        return draft
      })
      showToast(`Default for ${p.label.toLowerCase()} is now ${area.label}.`)
      return id
    },
    [log, setState, showToast, state.storageLocations],
  )

  const deleteStorageLocation = useCallback(
    (id: string): string | null => {
      const s = state.storageLocations.find((x) => x.id === id)
      if (!s) return null
      const blocker = areaDeleteBlocker(state, s)
      if (blocker) {
        showToast(blocker)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.storageLocations = draft.storageLocations.filter((x) => x.id !== id)
        log(draft, 'Deleted storage area', id, `${s.label} removed.`)
        return draft
      })
      showToast(`${s.label} deleted.`)
      return id
    },
    [log, setState, showToast, state],
  )

  return useMemo(
    () => ({
      addStorageLocation,
      updateStorageLocation,
      setStorageLocationStatus,
      setDefaultArea,
      deleteStorageLocation,
    }),
    [
      addStorageLocation,
      updateStorageLocation,
      setStorageLocationStatus,
      setDefaultArea,
      deleteStorageLocation,
    ],
  )
}
