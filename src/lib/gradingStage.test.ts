import { describe, expect, it } from 'vitest'
import { priceGrn } from './grn.ts'
import { gradingInput, pendingGrading, remainingToSort } from './gradingStage.ts'
import type { Grn } from '../types.ts'

const staged = (over: Partial<Grn> & Pick<Grn, 'id'>): Grn =>
  ({
    date: '2026-10-14T04:00:00.000Z',
    farmerId: '',
    farmerName: 'Ravi',
    lot: 'LOT-1',
    total: 100,
    a: 0,
    b: 0,
    c: 0,
    reject: 0,
    free: 0,
    rate: 35,
    transport: 500,
    accepted: 100,
    materialValue: 3500,
    landed: 4000,
    grossCost: 4000,
    usableCost: 40,
    status: 'Posted',
    purchaseProductId: 'PP-1',
    gradingMode: 'staged',
    ...over,
  }) as Grn

describe('pendingGrading — the Grading queue', () => {
  it('holds staged lots without gradedOn, oldest first; embedded and graded lots are out', () => {
    const queue = pendingGrading([
      staged({ id: 'GRN-3', date: '2026-10-14T09:00:00.000Z' }),
      staged({ id: 'GRN-1', date: '2026-10-12T04:00:00.000Z' }),
      staged({ id: 'GRN-2', gradingMode: 'embedded' }),
      staged({ id: 'GRN-4', gradedOn: '2026-10-14' }),
    ])
    expect(queue.map((g) => g.id)).toEqual(['GRN-1', 'GRN-3'])
  })

  it('breaks a date tie by id so the order is stable render to render', () => {
    const queue = pendingGrading([
      staged({ id: 'GRN-B', date: '2026-10-13T04:00:00.000Z' }),
      staged({ id: 'GRN-A', date: '2026-10-13T04:00:00.000Z' }),
    ])
    expect(queue.map((g) => g.id)).toEqual(['GRN-A', 'GRN-B'])
  })
})

describe('gradingInput — the staged lot re-priced as a gate-graded receipt', () => {
  const lot = staged({ id: 'GRN-1', total: 100, free: 5, rate: 35, transport: 500 })

  it('prices the typed grades with the load’s own numbers and the gate’s free count', () => {
    const input = gradingInput(lot, { a: 60, b: 20, c: 10, reject: 10 })
    expect(input.total).toBe(100)
    expect(input.free).toBe(5)
    expect(priceGrn(input)).toMatchObject({ ok: true, accepted: 90 })
  })

  it('an explicit free override replaces the gate’s count, as the endpoint does', () => {
    const input = gradingInput(lot, { a: 60, b: 20, c: 15, reject: 5, free: 10 })
    expect(input.free).toBe(10)
    expect(priceGrn(input).ok).toBe(true)
  })

  it('answers the mismatch with the write path’s own words when the grades do not sum to the load', () => {
    const math = priceGrn(gradingInput(lot, { a: 60, b: 20, c: 10, reject: 5 }))
    expect(math.ok).toBe(false)
    if (!math.ok) expect(math.error).toContain('Grade mismatch')
  })

  it('refuses an all-reject sort the same way the endpoint will', () => {
    const math = priceGrn(gradingInput(lot, { a: 0, b: 0, c: 0, reject: 100 }))
    expect(math.ok).toBe(false)
    if (!math.ok) expect(math.error).toContain('Accepted quantity must be greater than zero')
  })
})

describe('remainingToSort — the live count', () => {
  it('is what the typed grades have not accounted for yet', () => {
    const lot = staged({ id: 'GRN-1', total: 100 })
    expect(remainingToSort(lot, { a: 60, b: 20, c: 0, reject: 0 })).toBe(20)
    expect(remainingToSort(lot, { a: 0, b: 0, c: 0, reject: 0 })).toBe(100)
  })
})
