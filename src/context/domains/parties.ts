/**
 * Everyone the plant buys from and sells to.
 *
 * Split out of AppContext, which had grown to nearly three thousand lines and every
 * write the application can make. Nothing here changed in the move: the rules, the
 * checks and the ledger lines are the ones that were there before.
 */

import { useCallback, useMemo } from 'react'
import { deepClone } from '../../lib/utils'
import type { Customer, Vendor } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export function useParties({ state, setState, nextId, log, showToast, vendorTypeName }: CoreDeps) {
  const addVendor = useCallback(
    (input: Omit<Vendor, 'id' | 'status'>): string | null => {
      // "Farmer" and "Vendor" are two words for the same record, and the operator
      // only ever sees the one they picked — a farmer told "Vendor name is required"
      // thinks they opened the wrong form.
      const kind = vendorTypeName(input.vendorTypeId) || 'Supplier'
      if (!input.name.trim()) {
        showToast(`${kind} name is required.`)
        return null
      }
      if (!input.vendorTypeId) {
        showToast('Select a source type — Farmer or Vendor.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const v: Vendor = { ...input, id: nextId(draft, 'vendor'), status: 'Active' }
        draft.vendors.push(v)
        log(draft, 'Created vendor', v.id, v.name)
        createdId = v.id
        return draft
      })
      showToast(`${kind} created.`)
      return createdId || POSTED
    },
    [log, nextId, setState, showToast, vendorTypeName],
  )

  const setVendorStatus = useCallback(
    (id: string, status: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const v = draft.vendors.find((x) => x.id === id)
        if (!v) return prev
        v.status = status
        log(draft, 'Updated vendor status', v.id, `${v.name}: ${status}`)
        return draft
      })
      showToast('Supplier status updated.')
    },
    [log, setState, showToast],
  )

  const updateVendor = useCallback(
    (id: string, patch: Omit<Vendor, 'id' | 'status' | 'vendorTypeId'>): string | null => {
      const kind = vendorTypeName(state.vendors.find((x) => x.id === id)?.vendorTypeId || '')
      if (!patch.name.trim()) {
        showToast(`${kind || 'Supplier'} name is required.`)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const v = draft.vendors.find((x) => x.id === id)
        if (!v) return prev
        Object.assign(v, patch)
        log(draft, 'Edited vendor', v.id, v.name)
        return draft
      })
      showToast(`${kind || 'Supplier'} updated.`)
      return id
    },
    [log, setState, showToast, state.vendors, vendorTypeName],
  )

  const deleteVendor = useCallback(
    (id: string) => {
      if (state.grns.some((g) => g.farmerId === id)) {
        showToast('Cannot delete: this supplier has procurement receipts on record. Deactivate instead.')
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const v = draft.vendors.find((x) => x.id === id)
        if (!v) return prev
        draft.vendors = draft.vendors.filter((x) => x.id !== id)
        draft.purchaseProducts.forEach((p) => {
          p.vendorIds = p.vendorIds.filter((vid) => vid !== id)
        })
        log(draft, 'Deleted vendor', id, v.name)
        return draft
      })
      showToast('Supplier deleted.')
    },
    [log, setState, showToast, state.grns],
  )

  const addCustomer = useCallback(
    (input: Omit<Customer, 'id' | 'status'>): string | null => {
      if (!input.name.trim()) {
        showToast('Name is required.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const c: Customer = { ...input, id: nextId(draft, 'customer'), status: 'Active' }
        draft.customers.push(c)
        log(draft, 'Created customer', c.id, c.name)
        createdId = c.id
        return draft
      })
      showToast('Customer created.')
      return createdId || POSTED
    },
    [log, nextId, setState, showToast],
  )

  const setCustomerStatus = useCallback(
    (id: string, status: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const c = draft.customers.find((x) => x.id === id)
        if (!c) return prev
        c.status = status
        log(draft, 'Updated customer status', c.id, `${c.name}: ${status}`)
        return draft
      })
      showToast('Customer status updated.')
    },
    [log, setState, showToast],
  )

  const updateCustomer = useCallback(
    (id: string, patch: Omit<Customer, 'id' | 'status'>): string | null => {
      if (!patch.name.trim()) {
        showToast('Name is required.')
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const c = draft.customers.find((x) => x.id === id)
        if (!c) return prev
        Object.assign(c, patch)
        log(draft, 'Edited customer', c.id, c.name)
        return draft
      })
      showToast('Customer updated.')
      return id
    },
    [log, setState, showToast],
  )

  const deleteCustomer = useCallback(
    (id: string) => {
      if (state.dispatches.some((d) => d.customerId === id)) {
        showToast('Cannot delete: this customer has dispatch history on record. Deactivate instead.')
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const c = draft.customers.find((x) => x.id === id)
        if (!c) return prev
        draft.customers = draft.customers.filter((x) => x.id !== id)
        log(draft, 'Deleted customer', id, c.name)
        return draft
      })
      showToast('Customer deleted.')
    },
    [log, setState, showToast, state.dispatches],
  )

  return useMemo(
    () => ({
      addVendor,
      setVendorStatus,
      updateVendor,
      deleteVendor,
      addCustomer,
      setCustomerStatus,
      updateCustomer,
      deleteCustomer,
    }),
    [
      addVendor,
      setVendorStatus,
      updateVendor,
      deleteVendor,
      addCustomer,
      setCustomerStatus,
      updateCustomer,
      deleteCustomer,
    ],
  )
}
