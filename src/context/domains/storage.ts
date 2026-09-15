/**
 * The storage areas stock can sit in — one list, each with a type.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import type { StorageLocationInput } from '../../lib/posting'
import { deepClone } from '../../lib/utils'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useStorageLocations({ state, setState, nextId, log, showToast }: CoreDeps) {
  const addStorageLocation = useCallback(
    (input: StorageLocationInput): string | null => {
      const label = input.label.trim()
      if (!label) {
        showToast('Give the location a name.')
        return null
      }
      if (state.storageLocations.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
        showToast(`${label} already exists.`)
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
        draft.storageLocations.push({ ...input, label, id, name: key, status: 'Active' })
        log(draft, 'Added storage area', id, `${label} (${input.type}).`)
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
        showToast('Give the location a name.')
        return null
      }
      if (
        state.storageLocations.some(
          (s) => s.id !== id && s.label.toLowerCase() === label.toLowerCase(),
        )
      ) {
        showToast(`${label} already exists.`)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const s = draft.storageLocations.find((x) => x.id === id)
        if (!s) return prev
        // `name` is deliberately untouched — it is what the ledger points at.
        Object.assign(s, patch, { label, name: s.name })
        log(
          draft,
          'Updated storage area',
          id,
          // Not "dispatch-ready": nothing gates on that flag any more, and printing it
          // in the trail implied the area's type decides whether stock may ship. It does
          // not — the QC verdict does.
          `${label} (${patch.type}).`,
        )
        return draft
      })
      showToast(`${label} updated.`)
      return id
    },
    [log, setState, showToast, state.storageLocations],
  )

  const setStorageLocationStatus = useCallback(
    (id: string, status: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const s = draft.storageLocations.find((x) => x.id === id)
        if (!s) return prev
        s.status = status
        log(draft, 'Updated storage area', id, `${s.label} set ${status}.`)
        return draft
      })
    },
    [log, setState],
  )

  const deleteStorageLocation = useCallback(
    (id: string) => {
      const s = state.storageLocations.find((x) => x.id === id)
      if (!s) return
      if (state.ledger.some((l) => l.location === s.name)) {
        showToast(`${s.label} has stock history — deactivate it instead of deleting.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        draft.storageLocations = draft.storageLocations.filter((x) => x.id !== id)
        log(draft, 'Deleted storage area', id, `${s.label} removed.`)
        return draft
      })
      showToast(`${s.label} deleted.`)
    },
    [log, setState, showToast, state.ledger, state.storageLocations],
  )

  return useMemo(
    () => ({
      addStorageLocation,
      updateStorageLocation,
      setStorageLocationStatus,
      deleteStorageLocation,
    }),
    [
      addStorageLocation,
      updateStorageLocation,
      setStorageLocationStatus,
      deleteStorageLocation,
    ],
  )
}
