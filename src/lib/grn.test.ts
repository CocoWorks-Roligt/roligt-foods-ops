import { describe, expect, it } from 'vitest'
import { asReceived, gradedUnit, gradesPending, priceGrn, type GrnInput } from './grn.ts'

/**
 * Only produce counted by the piece is graded. A receipt in kilograms or litres asks
 * only for what came in, and is stored the way such receipts always were: nothing
 * free, nothing rejected, the whole load in grade A.
 */

const receipt = (over: Partial<GrnInput>): GrnInput => ({
  date: '2026-10-12',
  purchaseProductId: 'PP-1',
  farmerId: 'V-1',
  total: 0,
  free: 0,
  a: 0,
  b: 0,
  c: 0,
  reject: 0,
  rate: 0,
  transport: 0,
  ...over,
})

describe('gradedUnit', () => {
  it('grades pieces, and treats a missing unit as pieces', () => {
    expect(gradedUnit('Piece')).toBe(true)
    expect(gradedUnit('piece')).toBe(true)
    expect(gradedUnit(undefined)).toBe(true)
  })
  it('does not grade weight or volume', () => {
    expect(gradedUnit('Kg')).toBe(false)
    expect(gradedUnit('Litre')).toBe(false)
  })
})

describe('asReceived', () => {
  it('leaves a piece receipt exactly as entered', () => {
    const r = receipt({ uom: 'Piece', total: 100, free: 5, a: 60, b: 25, c: 10, reject: 5 })
    expect(asReceived(r)).toBe(r)
  })
  it('books a kilogram receipt whole as grade A, whatever stale grades the form held', () => {
    const r = receipt({ uom: 'Kg', total: 50, free: 3, a: 1, b: 2, c: 4, reject: 2.5 })
    expect(asReceived(r)).toMatchObject({ free: 0, a: 50, b: 0, c: 0, reject: 0, total: 50 })
  })
})

describe('priceGrn', () => {
  it('prices a kilogram receipt from total and rate alone, all of it accepted', () => {
    const math = priceGrn(receipt({ uom: 'Kg', total: 40, reject: 4, rate: 30, transport: 120 }))
    expect(math).toMatchObject({ ok: true, accepted: 40, material: 1200, landed: 1320 })
  })
  it('still asks a piece receipt to grade every piece', () => {
    const math = priceGrn(receipt({ uom: 'Piece', total: 100, a: 60, b: 20, reject: 5, rate: 20 }))
    expect(math.ok).toBe(false)
  })
})

describe('priceGrn — staged (grade later)', () => {
  it('prices the whole load as accepted and holds it for the grading form', () => {
    const math = priceGrn(receipt({ total: 500, free: 10, rate: 40, transport: 500, gradingMode: 'staged' }))
    expect(math.ok).toBe(true)
    if (math.ok) {
      expect(math.accepted).toBe(500) // the whole count — provisional until the grades land
      expect(math.material).toBe(490 * 40)
      expect(math.landed).toBe(490 * 40 + 500)
      expect(math.usableCost).toBe((490 * 40 + 500) / 500)
    }
  })

  it('asks only what the gate can answer — no grades to sort yet', () => {
    expect(priceGrn(receipt({ total: 0, rate: 40, gradingMode: 'staged' })).ok).toBe(false)
    expect(priceGrn(receipt({ total: 10, rate: 0, gradingMode: 'staged' })).ok).toBe(false)
    expect(priceGrn(receipt({ total: 10, free: 20, rate: 5, gradingMode: 'staged' })).ok).toBe(false)
  })

  it('still demands a product and a traceable source', () => {
    expect(priceGrn(receipt({ total: 10, rate: 5, purchaseProductId: '', gradingMode: 'staged' })).ok).toBe(false)
    expect(
      priceGrn(receipt({ total: 10, rate: 5, farmerId: '', farmer: '  ', gradingMode: 'staged' })).ok,
    ).toBe(false)
  })
})

describe('gradesPending', () => {
  it('is the staged receipt until its grades land, and nothing else', () => {
    expect(gradesPending({ gradingMode: 'staged' })).toBe(true)
    expect(gradesPending({ gradingMode: 'staged', gradedOn: '2026-10-14' })).toBe(false)
    expect(gradesPending({ gradingMode: 'embedded' })).toBe(false)
    expect(gradesPending({})).toBe(false)
  })
})
