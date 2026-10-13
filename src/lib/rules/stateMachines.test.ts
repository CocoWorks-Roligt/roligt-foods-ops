/**
 * The state machines' contract with the frozen LEGAL_TRANSITIONS table: every
 * entity's legal moves pass, every illegal move refuses, and the guard lists
 * and plain-language refusable explanations read back exactly what ARCHITECTURE
 * §3 drew.
 */
import { describe, expect, it } from 'vitest'
import { LOT_STATUSES, RUN_STATUSES, ORDER_STATUSES, SHIPMENT_STATUSES, CHALLAN_STATUSES, RETURN_STATUSES, PURCHASE_ORDER_STATUSES } from '../contracts'
import {
  canTransition,
  evaluateGuards,
  explainEvaluation,
  explainGuard,
  explainRefusal,
  guardsRequired,
  legalTargets,
} from './stateMachines'

describe('canTransition — every entity', () => {
  it('lot: the legal receipt/QC moves and the terminal balances', () => {
    expect(canTransition('lot', 'Receipt', 'Quarantine')).toBe(true)
    expect(canTransition('lot', 'Receipt', 'Released')).toBe(true) // qc-at-receipt off (DECISIONS #5)
    expect(canTransition('lot', 'Quarantine', 'Released')).toBe(true)
    expect(canTransition('lot', 'Quarantine', 'Rejected')).toBe(true)
    expect(canTransition('lot', 'Quarantine', 'Quarantine')).toBe(true) // rework retest
    expect(canTransition('lot', 'Released', 'Consumed')).toBe(true)
    expect(canTransition('lot', 'Released', 'Dispatched')).toBe(true)
    expect(canTransition('lot', 'Rejected', 'Written Off')).toBe(true)
  })

  it('lot: the illegal moves — skips, backwards and out of terminals', () => {
    expect(canTransition('lot', 'Receipt', 'Consumed')).toBe(false)
    expect(canTransition('lot', 'Receipt', 'Dispatched')).toBe(false)
    expect(canTransition('lot', 'Quarantine', 'Dispatched')).toBe(false)
    expect(canTransition('lot', 'Released', 'Quarantine')).toBe(false) // no un-release
    expect(canTransition('lot', 'Released', 'Rejected')).toBe(false)
    expect(canTransition('lot', 'Written Off', 'Released')).toBe(false)
    expect(canTransition('lot', 'Consumed', 'Released')).toBe(false)
    expect(canTransition('lot', 'Dispatched', 'Quarantine')).toBe(false)
    expect(canTransition('lot', 'Sailng', 'Released')).toBe(false) // a status the machine does not know
  })

  it('lot: terminal statuses answer no legal targets at all', () => {
    for (const terminal of ['Written Off', 'Consumed', 'Dispatched']) {
      expect(legalTargets('lot', terminal)).toEqual([])
    }
  })

  it('run: Draft → In Progress → Awaiting QC → Closed, and nothing backwards', () => {
    expect(canTransition('run', 'Draft', 'In Progress')).toBe(true)
    expect(canTransition('run', 'In Progress', 'Awaiting QC')).toBe(true)
    expect(canTransition('run', 'Awaiting QC', 'Closed')).toBe(true)
    expect(canTransition('run', 'Draft', 'Closed')).toBe(false)
    expect(canTransition('run', 'In Progress', 'Closed')).toBe(false)
    expect(canTransition('run', 'Awaiting QC', 'In Progress')).toBe(false)
    expect(canTransition('run', 'Closed', 'Draft')).toBe(false)
  })

  it('order: partial dispatch self-loops, direct dispatch, cancel; terminal stays put', () => {
    expect(canTransition('order', 'Open', 'Partially Dispatched')).toBe(true)
    expect(canTransition('order', 'Open', 'Dispatched')).toBe(true)
    expect(canTransition('order', 'Open', 'Cancelled')).toBe(true)
    expect(canTransition('order', 'Partially Dispatched', 'Partially Dispatched')).toBe(true) // repeat part-dispatch
    expect(canTransition('order', 'Partially Dispatched', 'Dispatched')).toBe(true)
    expect(canTransition('order', 'Dispatched', 'Cancelled')).toBe(false)
    expect(canTransition('order', 'Cancelled', 'Open')).toBe(false)
  })

  it('shipment: the delivery lifecycle, failed reschedules back out', () => {
    expect(canTransition('shipment', 'Created', 'Dispatched')).toBe(true)
    expect(canTransition('shipment', 'Dispatched', 'Out for Delivery')).toBe(true)
    for (const outcome of ['Delivered', 'Partially Delivered', 'Returned', 'Failed']) {
      expect(canTransition('shipment', 'Out for Delivery', outcome)).toBe(true)
    }
    expect(canTransition('shipment', 'Failed', 'Rescheduled')).toBe(true)
    expect(canTransition('shipment', 'Rescheduled', 'Out for Delivery')).toBe(true)
    expect(canTransition('shipment', 'Created', 'Delivered')).toBe(false)
    expect(canTransition('shipment', 'Delivered', 'Rescheduled')).toBe(false)
    expect(canTransition('shipment', 'Dispatched', 'Returned')).toBe(false)
  })

  it('challan: only a correction supersedes; return: QC decides then closes', () => {
    expect(canTransition('challan', 'Issued', 'Superseded')).toBe(true)
    expect(canTransition('challan', 'Superseded', 'Issued')).toBe(false)
    expect(canTransition('return', 'Open', 'QcDecision')).toBe(true)
    expect(canTransition('return', 'QcDecision', 'Closed')).toBe(true)
    expect(canTransition('return', 'Open', 'Closed')).toBe(false)
  })

  it('purchaseOrder: the funnel, repeat receipts, fully-received close', () => {
    expect(canTransition('purchaseOrder', 'draft', 'sent')).toBe(true)
    expect(canTransition('purchaseOrder', 'sent', 'acknowledged')).toBe(true)
    expect(canTransition('purchaseOrder', 'sent', 'cancelled')).toBe(true)
    expect(canTransition('purchaseOrder', 'acknowledged', 'received')).toBe(true)
    expect(canTransition('purchaseOrder', 'received', 'received')).toBe(true) // further part-receipts
    expect(canTransition('purchaseOrder', 'received', 'closed')).toBe(true)
    expect(canTransition('purchaseOrder', 'draft', 'received')).toBe(false)
    expect(canTransition('purchaseOrder', 'closed', 'draft')).toBe(false)
  })

  it('every status the contracts declare is a key or a target the machine knows', () => {
    const statuses: [Parameters<typeof canTransition>[0], readonly string[]][] = [
      ['lot', LOT_STATUSES],
      ['run', RUN_STATUSES],
      ['order', ORDER_STATUSES],
      ['shipment', SHIPMENT_STATUSES],
      ['challan', CHALLAN_STATUSES],
      ['return', RETURN_STATUSES],
      ['purchaseOrder', PURCHASE_ORDER_STATUSES],
    ]
    for (const [entity, list] of statuses) {
      for (const from of list) expect(legalTargets(entity, from)).toBeDefined()
    }
  })
})

describe('guardsRequired', () => {
  it('released lot consumption carries the QC gate guards', () => {
    expect(guardsRequired('lot', 'Released', 'Consumed')).toEqual(['qc_gate_v2', 'released_only'])
    expect(guardsRequired('lot', 'Released', 'Dispatched')).toEqual(['qc_gate_v2', 'released_only'])
  })

  it('a run close carries spoilage and mass balance; an unguarded move carries none', () => {
    expect(guardsRequired('run', 'Awaiting QC', 'Closed')).toEqual(['spoilage_required', 'mass_balance_ok'])
    expect(guardsRequired('run', 'Draft', 'In Progress')).toEqual([])
    expect(guardsRequired('lot', 'Quarantine', 'Released')).toEqual([])
  })

  it('an illegal transition answers no guards — there is no move to satisfy', () => {
    expect(guardsRequired('lot', 'Receipt', 'Dispatched')).toEqual([])
  })

  it('order dispatches are the atomic carton transaction; PO close needs everything received', () => {
    expect(guardsRequired('order', 'Open', 'Dispatched')).toEqual(['atomic_carton_deduction'])
    expect(guardsRequired('purchaseOrder', 'received', 'closed')).toEqual(['fully_received'])
  })
})

describe('explanations', () => {
  it('explainGuard reads the contracts text', () => {
    expect(explainGuard('released_only')).toBe('Only released stock can be used or dispatched.')
    expect(explainGuard('spoilage_required')).toBe('Record spoilage first — zero is fine, but it must be said.')
  })

  it('explainRefusal names the legal moves for an illegal one, null for a legal one', () => {
    expect(explainRefusal('lot', 'Released', 'Quarantine')).toBe('Released cannot move to Quarantine. From there it may only move to Consumed, Dispatched.')
    expect(explainRefusal('run', 'Closed', 'Draft')).toMatch(/closed — nothing may move it/)
    expect(explainRefusal('lot', 'Quarantine', 'Released')).toBeNull()
  })
})

describe('evaluateGuards — the guard evaluation hook', () => {
  it('a legal move with no facts supplied passes (facts the caller cannot see are not judged here)', () => {
    const e = evaluateGuards('lot', 'Released', 'Consumed', {})
    expect(e.allowed).toBe(true)
    expect(e.failed).toEqual([])
    expect(explainEvaluation(e)).toBeNull()
  })

  it('a fact of false fails exactly that guard, in contract order', () => {
    const e = evaluateGuards('lot', 'Released', 'Consumed', { released_only: false, cas_version: true })
    expect(e.allowed).toBe(false)
    expect(e.failed).toEqual(['released_only'])
    expect(explainEvaluation(e)).toBe('Only released stock can be used or dispatched.')
  })

  it('every failed guard is explained, joined', () => {
    const e = evaluateGuards('run', 'Awaiting QC', 'Closed', { spoilage_required: false, mass_balance_ok: false })
    expect(e.failed).toEqual(['spoilage_required', 'mass_balance_ok'])
    expect(explainEvaluation(e)).toContain('Record spoilage first')
    expect(explainEvaluation(e)).toContain('do not balance')
  })

  it('an illegal move is refused even with every guard passing', () => {
    const e = evaluateGuards('lot', 'Receipt', 'Dispatched', { released_only: true })
    expect(e.allowed).toBe(false)
    expect(e.failed).toEqual([])
    expect(explainEvaluation(e)).toMatch(/cannot move to Dispatched/)
  })
})
