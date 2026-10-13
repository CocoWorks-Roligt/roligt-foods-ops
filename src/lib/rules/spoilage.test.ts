/**
 * The run-close guards: a batch cannot close without a spoilage record for
 * THAT batch (an explicit zero is a deliberate entry and satisfies it), and
 * the recomputed mass balance must sit within tolerance.
 */
import { describe, expect, it } from 'vitest'
import type { SpoilageRecord } from '../contracts'
import { closeRunGuards, failedRunGuards } from './spoilage'

const record = (over: Partial<SpoilageRecord> = {}): SpoilageRecord => ({
  id: 'SP-1',
  batchId: 'B-1',
  stage: 'extraction',
  qty: 1,
  uom: 'Kg',
  reasonCode: 'rotten',
  at: '2026-10-12T08:00:00Z',
  actor: 'op@roligt.local',
  ...over,
})

const balanced = { inputBaseUnits: 50, outputBaseUnits: 49, variancePct: 0, withinTolerance: true }
const offBalance = { inputBaseUnits: 50, outputBaseUnits: 44, variancePct: 12, withinTolerance: false }

describe('closeRunGuards', () => {
  it('no spoilage record at all fails the mandatory-record guard', () => {
    const verdicts = closeRunGuards({ id: 'B-1' }, [], balanced)
    expect(verdicts.find((v) => v.guard === 'spoilage_required')?.passed).toBe(false)
    expect(failedRunGuards(verdicts)).toEqual(['spoilage_required'])
  })

  it('a record with qty 0 satisfies the guard — zero is a deliberate entry', () => {
    const verdicts = closeRunGuards({ id: 'B-1' }, [record({ qty: 0 })], balanced)
    expect(failedRunGuards(verdicts)).toEqual([])
  })

  it("another batch's records do not count for this one", () => {
    const verdicts = closeRunGuards({ id: 'B-1' }, [record({ batchId: 'B-2' })], balanced)
    expect(failedRunGuards(verdicts)).toEqual(['spoilage_required'])
  })

  it('a record with no batchId does not count either', () => {
    const stray = { ...record(), batchId: '' }
    expect(failedRunGuards(closeRunGuards({ id: 'B-1' }, [stray], balanced))).toEqual(['spoilage_required'])
  })

  it('spoilage present but the mass balance out of tolerance fails that guard only', () => {
    const verdicts = closeRunGuards({ id: 'B-1' }, [record()], offBalance)
    expect(failedRunGuards(verdicts)).toEqual(['mass_balance_ok'])
    expect(verdicts.find((v) => v.guard === 'spoilage_required')?.passed).toBe(true)
  })

  it('both guards pass together, each with its plain-language refusal empty', () => {
    const verdicts = closeRunGuards({ id: 'B-1' }, [record()], balanced)
    expect(failedRunGuards(verdicts)).toEqual([])
    for (const v of verdicts) expect(v.explanation).toBe('')
  })

  it('a failed guard carries the contracts explanation text', () => {
    const verdicts = closeRunGuards({ id: 'B-1' }, [], balanced)
    expect(verdicts.find((v) => v.guard === 'spoilage_required')?.explanation).toBe(
      'Record spoilage first — zero is fine, but it must be said.',
    )
    expect(closeRunGuards({ id: 'B-1' }, [record()], offBalance).find((v) => v.guard === 'mass_balance_ok')?.explanation).toBe(
      'Inputs and outputs do not balance within tolerance.',
    )
  })
})
