import { describe, expect, it } from 'vitest'
import { asReceived, gradedUnit, priceGrn, type GrnInput } from './grn.ts'

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
