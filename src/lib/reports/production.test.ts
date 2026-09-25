import { describe, expect, it } from 'vitest'
import { AUG, AUG_TO_SEP, SEP, fixtureState } from './fixtures.ts'
import { batchWiseRows, netNewOutputs, productionCompare, productionReport } from './production.ts'
import type { Batch } from '../../types.ts'

const state = fixtureState()

describe('net-new bulk (the mélange rule)', () => {
  it('counts a blend only for what it added over the bulk it drew', () => {
    const melange = state.batches.find((b) => b.id === 'BAT-2026-0004')!
    expect(netNewOutputs(melange)).toEqual([{ uom: 'Litre', qty: 20 }])
  })

  it('counts every output of an extraction as new, by-products included', () => {
    const extraction = state.batches.find((b) => b.id === 'BAT-2026-0001')!
    expect(netNewOutputs(extraction)).toEqual([
      { uom: 'Litre', qty: 180 },
      { uom: 'Kg', qty: 40 },
    ])
  })

  it('brings a draw in a unit no output uses off that unit’s net-new figure', () => {
    const odd: Batch = {
      ...state.batches.find((b) => b.id === 'BAT-2026-0004')!,
      blendLines: [{ item: 'SF-TCW-WATER', lot: 'BAT-2026-0001', uom: 'Kg', qty: 10, unitCost: 1 }],
    }
    expect(netNewOutputs(odd)).toEqual([
      { uom: 'Litre', qty: 120 },
      { uom: 'Kg', qty: -10 },
    ])
  })
})

describe('production report', () => {
  it('totals a month of extractions without counting the blend twice', () => {
    const aug = productionReport(state, AUG)
    expect(aug.rows).toHaveLength(1)
    const row = aug.rows[0]
    expect(row.extractions).toBe(3)
    expect(row.melanges).toBe(0)
    expect(row.netNew).toEqual([
      { uom: 'Litre', qty: 285 },
      { uom: 'Kg', qty: 52 },
    ])
    expect(row.spoiled).toEqual([
      { uom: 'Piece', qty: 30 },
      { uom: 'Kg', qty: 3 },
    ])
    expect(row.packsFilled).toBe(0)
  })

  it('separates the mélange’s addition and counts the packs a run filled', () => {
    const sep = productionReport(state, SEP)
    const row = sep.rows[0]
    expect(row.extractions).toBe(1)
    expect(row.melanges).toBe(1)
    // 90 L pressed + (120 L booked − 100 L drawn) blended.
    expect(row.netNew).toEqual([{ uom: 'Litre', qty: 110 }])
    expect(row.packsFilled).toBe(30)
    expect(row.packRuns).toBe(1)
    expect(row.pmCost).toBe(3000)
  })

  it('keeps the two-month total honest — the golden double-count number', () => {
    const both = productionReport(state, AUG_TO_SEP)
    expect(both.totals.netNew).toEqual([
      { uom: 'Litre', qty: 395 }, // not 515: the blend’s 120 L is not added on top
      { uom: 'Kg', qty: 52 },
    ])
    expect(both.totals.extractions).toBe(4)
    expect(both.totals.melanges).toBe(1)
    expect(both.totals.packsFilled).toBe(30)
    expect(both.rows.map((r) => r.month)).toEqual(['2026-08', '2026-09'])
  })

  it('averages yield per pairing of output unit and input unit', () => {
    const aug = productionReport(state, AUG).rows[0]
    const perPiece = aug.avgYield.find((y) => y.pair === 'L / piece')!
    const perKg = aug.avgYield.find((y) => y.pair === 'L / kg')!
    // Both coconut batches are L/piece — the modern one's 180/580 and the
    // deprecated one's yieldPerCoconut 60/290; beetroot alone is L/kg.
    expect(perPiece.avg).toBeCloseTo((180 / 580 + 60 / 290) / 2, 3)
    expect(perKg.avg).toBeCloseTo(45 / 95, 3)
  })

  it('compares two months', () => {
    const lines = productionCompare(
      productionReport(state, AUG).totals,
      productionReport(state, SEP).totals,
    )
    const netNew = lines.find((l) => l.label === 'Net-new bulk (L)')!
    expect(netNew.a).toBe('285')
    expect(netNew.b).toBe('110')
    expect(netNew.delta).toBe('-61.4%')
    const packs = lines.find((l) => l.label === 'Packs filled')!
    expect(packs.b).toBe('30')
  })
})

describe('batch-wise production', () => {
  it('lists each batch with its outputs, costs and QC links', () => {
    const rows = batchWiseRows(state, AUG)
    expect(rows.map((r) => r.batchId)).toEqual(['BAT-2026-0001', 'BAT-2026-0003', 'BAT-2026-0002'])

    const bat1 = rows[0]
    expect(bat1.label).toBe('Coconut Water (bulk)')
    expect(bat1.outputs).toEqual([
      { item: 'SF-TCW-WATER', name: 'Coconut Water (bulk)', qty: 180, uom: 'Litre', costShare: 100 },
      { item: 'SF-TCW-MALAI', name: 'Malai (bulk)', qty: 40, uom: 'Kg', costShare: 0 },
    ])
    expect(bat1.qcIds).toEqual(['QC-2026-0001', 'QC-2026-0002'])
    expect(bat1.totalCost).toBeCloseTo((29000 / 910) * 600 + 500, 2)
    expect(bat1.yieldPerUnit).toBeCloseTo(180 / 580, 4)
  })

  it('reads the deprecated shape through the same fallbacks the registers use', () => {
    const bat2 = batchWiseRows(state, AUG).find((r) => r.batchId === 'BAT-2026-0002')!
    expect(bat2.inputQty).toBe(300) // coconuts
    expect(bat2.outputs.map((o) => o.qty)).toEqual([60, 12])
    expect(bat2.mainQty).toBe(60)
    expect(bat2.yieldPerUnit).toBeCloseTo(0.2069, 4) // yieldPerCoconut
  })

  it('names a mélange run by its recipe and reads its blend as input', () => {
    const bat4 = batchWiseRows(state, SEP).find((r) => r.batchId === 'BAT-2026-0004')!
    expect(bat4.kind).toBe('Melange')
    expect(bat4.label).toBe('ABC Melange')
    expect(bat4.inputQty).toBe(100)
    expect(bat4.inputUom).toBe('Litre')
    expect(bat4.yieldPerUnit).toBeNull() // only extractions carry a yield per input
  })
})
