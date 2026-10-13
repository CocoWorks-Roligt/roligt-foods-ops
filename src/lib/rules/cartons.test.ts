/**
 * The carton math: the suggestion pick/pack offers (pouches pooled per BIB
 * size against that size's active spec, partial cartons allowed), the
 * deduction plan (pouches always, cartons only when BOXED, LOOSE leaves carton
 * stock untouched) and the reconciliation fold.
 */
import { describe, expect, it } from 'vitest'
import type { CartonSpec } from '../contracts'
import { planDeduction, reconcileCartons, suggestCartons } from './cartons'

const specs: CartonSpec[] = [
  { id: 'carton-1L', bibSize: 1, cartonItemId: 'CTN-1L', pouchesPerCarton: 12, active: true },
  { id: 'carton-2.5L', bibSize: 2.5, cartonItemId: 'CTN-2.5L', pouchesPerCarton: 4, active: true },
  { id: 'carton-5L', bibSize: 5, cartonItemId: 'CTN-5L', pouchesPerCarton: 2, active: false }, // not rolled out yet
]

describe('suggestCartons', () => {
  it('full and partial cartons off the active spec', () => {
    const [suggestion] = suggestCartons([{ bibSize: 1, pouches: 27 }], specs, 'BOXED')
    expect(suggestion).toMatchObject({
      bibSize: 1,
      cartonItemId: 'CTN-1L',
      totalPouches: 27,
      fullCartons: 2,
      partialPouches: 3,
      cartonsNeeded: 3, // the part-filled carton still costs one
    })
  })

  it('pools duplicate lines of the same BIB size before dividing', () => {
    const [suggestion] = suggestCartons(
      [
        { bibSize: 2.5, pouches: 3 },
        { bibSize: 2.5, pouches: 5 },
      ],
      specs,
      'ASK',
    )
    expect(suggestion).toMatchObject({ bibSize: 2.5, totalPouches: 8, fullCartons: 2, partialPouches: 0, cartonsNeeded: 2 })
  })

  it('one suggestion per size, in the order the sizes first appear', () => {
    const out = suggestCartons(
      [
        { bibSize: 2.5, pouches: 4 },
        { bibSize: 1, pouches: 12 },
      ],
      specs,
      'BOXED',
    )
    expect(out.map((s) => s.bibSize)).toEqual([2.5, 1])
  })

  it('a LOOSE customer is offered nothing — carton stock stays untouched', () => {
    expect(suggestCartons([{ bibSize: 1, pouches: 27 }], specs, 'LOOSE')).toEqual([])
  })

  it('a size with no active spec is left out rather than guessed (DECISIONS #14)', () => {
    const out = suggestCartons(
      [
        { bibSize: 5, pouches: 10 },
        { bibSize: 1, pouches: 12 },
      ],
      specs,
      'BOXED',
    )
    expect(out.map((s) => s.bibSize)).toEqual([1])
  })

  it('an exact multiple leaves no partial carton', () => {
    const [suggestion] = suggestCartons([{ bibSize: 1, pouches: 24 }], specs, 'BOXED')
    expect(suggestion).toMatchObject({ fullCartons: 2, partialPouches: 0, cartonsNeeded: 2 })
  })
})

describe('planDeduction', () => {
  it('BOXED decrements pouches and cartons together', () => {
    expect(planDeduction('BOXED', { pouches: 27, cartons: 3, cartonItemId: 'CTN-1L' })).toEqual({
      pouches: 27,
      cartons: 3,
      cartonItemId: 'CTN-1L',
    })
  })

  it('LOOSE decrements the pouches and leaves carton stock untouched', () => {
    expect(planDeduction('LOOSE', { pouches: 27, cartons: 3, cartonItemId: 'CTN-1L' })).toEqual({
      pouches: 27,
      cartons: 0,
    })
  })

  it('a partial carton deducts one whole carton (the operator confirms or edits the count)', () => {
    expect(planDeduction('BOXED', { pouches: 15, cartons: 2 }).cartons).toBe(2) // 12 + a part-filled one
  })

  it('a BOXED line with no cartons wanted deducts none', () => {
    expect(planDeduction('BOXED', { pouches: 4, cartons: 0, cartonItemId: 'CTN-1L' })).toEqual({ pouches: 4, cartons: 0 })
  })
})

describe('reconcileCartons', () => {
  it('folds issued / used / damaged per carton item, unaccounted the difference', () => {
    const out = reconcileCartons([
      { cartonItemId: 'CTN-1L', issued: 100, used: 90, damaged: 5 },
      { cartonItemId: 'CTN-1L', issued: 20, used: 20, damaged: 0 },
      { cartonItemId: 'CTN-2.5L', issued: 10, used: 9, damaged: 1 },
    ])
    expect(out).toEqual([
      { cartonItemId: 'CTN-1L', issued: 120, used: 110, damaged: 5, unaccounted: 5 },
      { cartonItemId: 'CTN-2.5L', issued: 10, used: 9, damaged: 1, unaccounted: 0 },
    ])
  })

  it('over-accounting shows as a negative unaccounted, not a silent clamp', () => {
    const [total] = reconcileCartons([{ cartonItemId: 'CTN-1L', issued: 10, used: 12, damaged: 0 }])
    expect(total.unaccounted).toBe(-2)
  })
})
