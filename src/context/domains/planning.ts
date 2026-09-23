/**
 * Production planning — what the plant intends to make, written before it makes it.
 *
 * A plan touches no stock: nothing is issued, nothing is booked, and cancelling one
 * leaves no trace in the ledger. When the day comes the run is posted as usual on
 * the Production or Packing page; the plan only ever said what was coming, and its
 * status is the planner's own tick-box, not a posting.
 */

import { useCallback } from 'react'
import { deepClone } from '../../lib/utils'
import type { PlanStage, PlanStatus, ProductionPlan } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export interface PlanInput {
  date: string
  stage: PlanStage
  product: string
  qty: number
  uom: ProductionPlan['uom']
  note?: string
  /** Which open orders the plan serves. Absent on a hand-made plan; on edit,
   *  undefined keeps what the plan already serves. */
  serves?: string[]
}

const STATUSES: PlanStatus[] = ['Planned', 'In progress', 'Done', 'Cancelled']

export function usePlanning({ state, setState, nextId, log, showToast }: CoreDeps) {
  const describe = (p: { stage: string; product: string; qty: number; uom: string; date: string }) =>
    `${p.stage} · ${p.product} · ${p.qty} ${p.uom.toLowerCase()} · ${p.date}`

  const addPlan = useCallback(
    (input: PlanInput): string | null => {
      const product = input.product.trim()
      if (!input.date) {
        showToast('Pick the day this plan is for.')
        return null
      }
      if (!product) {
        showToast('Say what is being made.')
        return null
      }
      if (!(input.qty > 0)) {
        showToast('Planned quantity has to be more than zero.')
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const plan: ProductionPlan = {
          id: nextId(draft, 'plan'),
          date: input.date,
          stage: input.stage,
          product,
          qty: input.qty,
          uom: input.uom,
          note: input.note?.trim() || undefined,
          serves: input.serves?.length ? [...input.serves] : undefined,
          status: 'Planned',
          createdOn: new Date().toISOString().slice(0, 10),
        }
        draft.productionPlans.push(plan)
        log(draft, 'Added plan', plan.id, describe(plan))
        createdId = plan.id
        return draft
      })
      showToast(`Plan created for ${fmtShort(input.date)}.`)
      return createdId || POSTED
    },
    [log, nextId, setState, showToast],
  )

  const updatePlan = useCallback(
    (id: string, input: PlanInput): string | null => {
      const product = input.product.trim()
      const existing = state.productionPlans.find((p) => p.id === id)
      if (!existing) return null
      if (!product) {
        showToast('Say what is being made.')
        return null
      }
      if (!(input.qty > 0)) {
        showToast('Planned quantity has to be more than zero.')
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const plan = draft.productionPlans.find((p) => p.id === id)
        if (!plan) return prev
        plan.date = input.date
        plan.stage = input.stage
        plan.product = product
        plan.qty = input.qty
        plan.uom = input.uom
        plan.note = input.note?.trim() || undefined
        if (input.serves !== undefined) {
          plan.serves = input.serves.length ? [...input.serves] : undefined
        }
        log(draft, 'Updated plan', plan.id, describe(plan))
        return draft
      })
      showToast(`${id} updated.`)
      return POSTED
    },
    [log, setState, showToast, state.productionPlans],
  )

  /** The planner's tick-box. Any status may be set from any other — re-opening a
   *  cancelled plan is exactly what a change of mind looks like. */
  const setPlanStatus = useCallback(
    (id: string, status: PlanStatus) => {
      if (!STATUSES.includes(status)) return
      const existing = state.productionPlans.find((p) => p.id === id)
      if (!existing || existing.status === status) return
      setState((prev) => {
        const draft = deepClone(prev)
        const plan = draft.productionPlans.find((p) => p.id === id)
        if (!plan) return prev
        plan.status = status
        log(draft, 'Updated plan status', plan.id, `${plan.id}: ${status}`)
        return draft
      })
      showToast(status === 'Done' ? `${id} done.` : status === 'Cancelled' ? `${id} cancelled.` : `${id} ${status.toLowerCase()}.`)
    },
    [log, setState, showToast, state.productionPlans],
  )

  const deletePlan = useCallback(
    (id: string) => {
      setState((prev) => {
        const draft = deepClone(prev)
        const before = draft.productionPlans.length
        draft.productionPlans = draft.productionPlans.filter((p) => p.id !== id)
        if (draft.productionPlans.length === before) return prev
        log(draft, 'Deleted plan', id, id)
        return draft
      })
      showToast(`${id} deleted.`)
    },
    [log, setState, showToast],
  )

  return { addPlan, updatePlan, setPlanStatus, deletePlan }
}

const fmtShort = (date: string) => {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
