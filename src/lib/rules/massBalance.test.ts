/**
 * The mass-balance rules: everything converts to kg before it is summed,
 * count through an average unit weight, litres through density — and a unit
 * with no configured path is an error, never a guess. The canonical example
 * is the plant's own: 100 nuts at 500 g against 46 kg water + 3 kg malai +
 * 1 kg recorded spoilage.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MASS_BALANCE_CONFIG,
  MassBalanceError,
  computeMassBalance,
  conversionOf,
  massBalanceConfigOf,
  toBaseKg,
  type MassBalanceConfig,
  type MassBalanceItems,
  type MassBalanceLine,
} from './massBalance'

const config = (over: Partial<MassBalanceConfig> = {}): MassBalanceConfig => ({
  ...DEFAULT_MASS_BALANCE_CONFIG,
  ...over,
})

const items: MassBalanceItems = {
  NUT: { uom: 'Piece', avgUnitWeight: 0.5 }, // kg per nut — an item override
  WATER: { uom: 'Litre', densityKgPerL: 1.03 },
  MALAI: { uom: 'Kg' },
}

const line = (item: string, qty: number, uom: string): MassBalanceLine => ({ item, qty, uom })

describe('toBaseKg — one line, in kg', () => {
  it('count converts through the average unit weight', () => {
    expect(toBaseKg(line('NUT', 100, 'Piece'), items, config())).toBeCloseTo(50, 10)
  })

  it('kg passes through; grams and millilitres convert too', () => {
    expect(toBaseKg(line('MALAI', 3, 'Kg'), items, config())).toBe(3)
    expect(toBaseKg(line('X', 500, 'g'), {}, config())).toBeCloseTo(0.5, 12)
    expect(toBaseKg(line('WATER', 250, 'ml'), items, config())).toBeCloseTo(0.2575, 10)
  })

  it('litres convert through the item density, else the plant default', () => {
    expect(toBaseKg(line('WATER', 10, 'Litre'), items, config())).toBeCloseTo(10.3, 10)
    expect(toBaseKg(line('TEA', 10, 'Litre'), {}, config({ defaultDensityKgPerL: 0.98 }))).toBeCloseTo(9.8, 10)
  })

  it('a count with no configured weight anywhere is an error, not a guess', () => {
    expect(() => toBaseKg(line('NUT', 5, 'Piece'), {}, config({ avgUnitWeightG: 0 }))).toThrow(MassBalanceError)
    expect(() => conversionOf(line('NUT', 5, 'Piece'), {}, config({ avgUnitWeightG: 0 }))).toThrow(/average unit weight/i)
  })

  it('a litre with no density anywhere, and a unit nobody knows, are errors', () => {
    expect(() => toBaseKg(line('X', 5, 'Litre'), {}, config({ defaultDensityKgPerL: 0 }))).toThrow(/density/i)
    expect(() => toBaseKg(line('X', 5, 'Pack'), {}, config())).toThrow(MassBalanceError)
  })
})

describe('computeMassBalance', () => {
  it('the plant example: 100 nuts × 500 g in; 46 kg water + 3 kg malai + 1 kg spoilage out', () => {
    const r = computeMassBalance(
      [line('NUT', 100, 'Piece')],
      [line('WATER', 46, 'Kg'), line('MALAI', 3, 'Kg')],
      [line('', 1, 'Kg')],
      items,
      config(),
    )
    expect(r.inputBaseUnits).toBeCloseTo(50, 10)
    expect(r.outputBaseUnits).toBeCloseTo(49, 10)
    expect(r.variancePct).toBeCloseTo(0, 10)
    expect(r.withinTolerance).toBe(true)
  })

  it('mixed-unit inputs and outputs are summed in kg, never raw', () => {
    const r = computeMassBalance(
      [line('NUT', 100, 'Piece'), line('WATER', 10, 'Litre')],
      [line('WATER', 95, 'Kg')],
      [],
      items,
      config(),
    )
    expect(r.inputBaseUnits).toBeCloseTo(60.3, 10) // 50 kg nuts + 10.3 kg water
    expect(r.outputBaseUnits).toBeCloseTo(95, 10)
    expect(r.variancePct).toBeCloseTo((60.3 - 95) / 60.3 * 100, 8) // negative: more out than in
    expect(r.withinTolerance).toBe(false)
  })

  it('spoilage explains variance: exactly at the tolerance passes', () => {
    // 50 in, 49 out, 0 recorded → 2% exactly, at the 2% line
    const at = computeMassBalance(
      [line('NUT', 100, 'Piece')],
      [line('WATER', 46, 'Kg'), line('MALAI', 3, 'Kg')],
      [],
      items,
      config(),
    )
    expect(at.variancePct).toBeCloseTo(2, 10)
    expect(at.withinTolerance).toBe(true)
  })

  it('a hair over the tolerance refuses', () => {
    const over = computeMassBalance(
      [line('NUT', 100, 'Piece')],
      [line('WATER', 45, 'Kg'), line('MALAI', 3, 'Kg')], // 48 out of 50
      [],
      items,
      config(),
    )
    expect(over.variancePct).toBeCloseTo(4, 10)
    expect(over.withinTolerance).toBe(false)
  })

  it('negative variance (more accounted than issued) is out of tolerance too', () => {
    const r = computeMassBalance(
      [line('NUT', 100, 'Piece')],
      [line('WATER', 55, 'Kg')],
      [],
      items,
      config(),
    )
    expect(r.variancePct).toBeLessThan(-2)
    expect(r.withinTolerance).toBe(false)
  })

  it('the tolerance is the configured one, not a constant', () => {
    const r = computeMassBalance(
      [line('NUT', 100, 'Piece')],
      [line('WATER', 46, 'Kg'), line('MALAI', 3, 'Kg')],
      [],
      items,
      config({ massBalanceTolerancePct: 1 }),
    )
    expect(r.variancePct).toBeCloseTo(2, 10)
    expect(r.withinTolerance).toBe(false)
  })

  it('a batch with no inputs answers 0 variance (empty batches are refused upstream)', () => {
    const r = computeMassBalance([], [line('WATER', 5, 'Kg')], [], items, config())
    expect(r.variancePct).toBe(0)
    expect(r.withinTolerance).toBe(true)
  })

  it('an unknown conversion anywhere in the fold surfaces as the error, never a silent sum', () => {
    expect(() =>
      computeMassBalance(
        [line('NUT', 100, 'Piece')],
        [line('PACK-500', 40, 'Pack')],
        [],
        items,
        config(),
      ),
    ).toThrow(/no conversion to kg/i)
  })
})

describe('massBalanceConfigOf', () => {
  it('reads app_config with the DECISIONS #2 defaults for anything missing', () => {
    expect(massBalanceConfigOf(null)).toEqual(DEFAULT_MASS_BALANCE_CONFIG)
    expect(massBalanceConfigOf({ avgNutWeightG: 450, massBalanceTolerancePct: 3 })).toMatchObject({
      avgUnitWeightG: 450,
      massBalanceTolerancePct: 3,
      defaultDensityKgPerL: 1.0,
    })
  })

  it('invalid values fall back rather than poison the balance', () => {
    expect(massBalanceConfigOf({ avgNutWeightG: 'heavy', defaultDensityKgPerL: -1 })).toEqual(DEFAULT_MASS_BALANCE_CONFIG)
  })
})
