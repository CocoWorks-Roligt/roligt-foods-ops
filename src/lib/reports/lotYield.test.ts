import { describe, expect, it } from 'vitest'
import { AUG, SEP, fixtureState } from './fixtures.ts'
import { lotYieldRows } from './lotYield.ts'
import type { Batch, Grn } from '../../types.ts'

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

  it('attributes a mixed-unit batch within each unit group — never off the cross-unit sum', () => {
    const s = fixtureState()
    // One pressing of three lots: two counted in pieces, one in kilograms. There is
    // no whole-issue number (840 of what?), so each lot's share is of the issue
    // counted in its own unit — pieces against pieces, kilograms against kilograms.
    const grn = (lot: string, uom: string): Grn => ({
      id: `GRN-${lot}`, date: '2026-09-18', farmerId: 'VEN-0001', farmerName: 'Lakshmi Farms',
      lot, total: 100, free: 0, a: 100, b: 0, c: 0, reject: 0, rate: 1, transport: 0,
      accepted: 100, materialValue: 100, landed: 100, grossCost: 1, usableCost: 1,
      status: 'Posted', purchaseProductId: 'PP-COCO', itemId: 'RM-TCW-COCO', uom,
      productName: 'Tender Coconut', location: 'RM Store',
    })
    s.grns.push(grn('LOT-P', 'Piece'), grn('LOT-P2', 'Piece'), grn('LOT-K', 'Kg'))
    const mixed: Batch = {
      id: 'BAT-2026-0006', kind: 'Extraction', date: '2026-09-20',
      sourceLines: [
        { lot: 'LOT-P', item: 'RM-TCW-COCO', uom: 'Piece', qty: 600, unitCost: 30 },
        { lot: 'LOT-P2', item: 'RM-TCW-COCO', uom: 'Piece', qty: 200, unitCost: 30 },
        { lot: 'LOT-K', item: 'RM-TCW-COCO', uom: 'Kg', qty: 40, unitCost: 30 },
      ],
      outputLines: [{ stockId: 'BAT-2026-0006/1', item: 'SF-TCW-WATER', qty: 180, uom: 'Litre', costShare: 100 }],
      coconuts: 840, inputQty: 840, inputUom: '', spoiled: 20, outputs: [], outputLitres: 180,
      yieldPerCoconut: 0, yieldPerUnit: 0, rmCost: 25200, pmCost: 0, directCost: 25200, costPerL: 140,
      status: 'Awaiting QC', qcId: '',
    }
    s.batches.push(mixed)
    const rows = lotYieldRows(s, SEP)
    const p = rows.find((r) => r.lot === 'LOT-P')!
    const p2 = rows.find((r) => r.lot === 'LOT-P2')!
    const k = rows.find((r) => r.lot === 'LOT-K')!
    // Within the Piece group (600 of 800): three quarters and one quarter of the
    // pressing — not 128.6 and 42.9 off 840, which would weigh pieces against kilograms.
    expect(p.mainQty).toBeCloseTo(135, 6)
    expect(p2.mainQty).toBeCloseTo(45, 6)
    expect(p.spoiled).toBeCloseTo(15, 6) // 20 spoiled × 600/800, within the group
    // The kilogram lot stands alone in its group, so the pressing reads against its
    // own 40 kg — a yield in L per kg, never 8.6 L off 600+200+40.
    expect(k.mainQty).toBeCloseTo(180, 6)
    expect(k.yieldPerUnit).toBeCloseTo(180 / 40, 6)
    expect(p.yieldPerUnit).toBeCloseTo(135 / 600, 6)
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
