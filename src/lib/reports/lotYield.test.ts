import { describe, expect, it } from 'vitest'
import { AUG, SEP, fixtureState } from './fixtures.ts'
import { lotYieldRows } from './lotYield.ts'

const state = fixtureState()

const byLot = (w: { from: string; to: string }) => {
  const rows = lotYieldRows(state, w)
  return new Map(rows.map((r) => [r.lot, r]))
}

describe('lot yield', () => {
  it('credits a lot with every batch that pressed it, across all of history', () => {
    const lot1 = byLot(AUG).get('LOT-20260805-001')!
    expect(lot1.issued).toBe(900)
    expect(lot1.batches).toEqual(['BAT-2026-0001', 'BAT-2026-0002'])
    expect(lot1.mainQty).toBe(240) // 180 + 60 litres of water
    expect(lot1.byQty).toBe(52) // 40 + 12 kg of malai
    // Spoiled at the press, across both batches.
    expect(lot1.spoiled).toBe(30)
    expect(lot1.netPressed).toBe(870)
    // The whole landed cost over the litres the lot became.
    expect(lot1.costPerUnit).toBeCloseTo(29000 / 240, 3)
    expect(lot1.yieldPerUnit).toBeCloseTo(240 / 900, 4)
  })

  it('attributes pro-rata when one batch draws several lots', () => {
    const sep = byLot(SEP)
    const lot3 = sep.get('LOT-20260903-003')!
    const lot4 = sep.get('LOT-20260904-004')!
    // BAT-2026-0005 drew 400 + 100 and pressed 90 L, spoiled 5.
    expect(lot3.mainQty).toBeCloseTo(90 * (400 / 500), 6)
    expect(lot4.mainQty).toBeCloseTo(90 * (100 / 500), 6)
    expect(lot3.spoiled).toBeCloseTo(4, 6)
    expect(lot4.spoiled).toBeCloseTo(1, 6)
    expect(lot3.yieldPerUnit).toBeCloseTo(72 / 400, 6)
    expect(lot4.costPerUnit).toBeCloseTo(6000 / 18, 3)
  })

  it('reads a batch written in the deprecated coconut-only shape', () => {
    // BAT-2026-0002 carries coconuts/waterLitres/malaiKg and no outputLines; its
    // 60 litres reach the lot through the fallback in lib/batches.
    const lot1 = byLot(AUG).get('LOT-20260805-001')!
    expect(lot1.mainQty).toBe(240)
  })

  it('marks a lot nothing has pressed as pending, out of the ₹/L maths', () => {
    const lot5 = byLot(SEP).get('LOT-20260910-005')!
    expect(lot5.pending).toBe(true)
    expect(lot5.issued).toBe(0)
    expect(lot5.yieldPerUnit).toBeNull()
    expect(lot5.costPerUnit).toBeNull()
    expect(lot5.storedCostPerUnit).toBeNull()
  })

  it('cross-checks the derived ₹/L against the batches’ stored costPerL', () => {
    const lot1 = byLot(AUG).get('LOT-20260805-001')!
    // Weighted mean of the two batches' stored costPerL by attributed litres.
    const b1 = ((29000 / 910) * 600 + 500) / 180
    const b2 = ((29000 / 910) * 300 + 200) / 60
    expect(lot1.storedCostPerUnit).toBeCloseTo((b1 * 180 + b2 * 60) / 240, 3)
  })
})
