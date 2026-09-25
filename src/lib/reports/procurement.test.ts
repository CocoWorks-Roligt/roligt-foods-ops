import { describe, expect, it } from 'vitest'
import { AUG, AUG_TO_SEP, EMPTY_MONTH, SEP, fixtureState } from './fixtures.ts'
import {
  isFruitReceipt,
  procurementCompare,
  procurementLotRows,
  procurementSummary,
} from './procurement.ts'

const state = fixtureState()

describe('procurement lot rows', () => {
  it('reads each receipt in the window, landed cost and all', () => {
    const rows = procurementLotRows(state, AUG)
    expect(rows.map((r) => r.lot)).toEqual(['LOT-20260805-001', 'LOT-20260806-002'])

    const coco = rows[0]
    expect(coco.grnId).toBe('GRN-2026-0001')
    expect(coco.accepted).toBe(910)
    expect(coco.landed).toBe(29000)
    expect(coco.perAccepted).toBeCloseTo(31.868, 2)
    expect(coco.supplier).toBe('Lakshmi Farms')
    expect(coco.uom).toBe('Piece')

    const beet = rows[1]
    expect(beet.supplier).toBe('Suresh Reddy')
    expect(beet.perAccepted).toBeCloseTo(40, 2)
  })

  it('summarises a month per unit, never across them', () => {
    const s = procurementSummary(procurementLotRows(state, AUG))
    expect(s.receipts).toBe(2)
    expect(s.landed).toBe(32920)
    expect(s.qtyByUom).toEqual([
      { uom: 'Piece', qty: 1000 },
      { uom: 'Kg', qty: 100 },
    ])
    expect(s.acceptedByUom).toEqual([
      { uom: 'Piece', qty: 910 },
      { uom: 'Kg', qty: 98 },
    ])
  })

  it('shows nothing for a month nothing arrived in', () => {
    const rows = procurementLotRows(state, EMPTY_MONTH)
    expect(rows).toEqual([])
    expect(procurementSummary(rows).landed).toBe(0)
  })
})

describe('fruits procurement', () => {
  it('keeps produce that is not tender coconut, by item and not by date', () => {
    const rows = procurementLotRows(state, AUG_TO_SEP, { fruitsOnly: true })
    expect(rows.map((r) => r.lot)).toEqual(['LOT-20260806-002'])

    // A receipt naming no item is a pre-fruit record: tender coconut by design.
    const legacy = state.grns.find((g) => g.id === 'GRN-2026-0001')!
    const withoutItem = { ...legacy, itemId: undefined, purchaseProductId: undefined }
    expect(isFruitReceipt(state, withoutItem)).toBe(false)
    expect(isFruitReceipt(state, state.grns.find((g) => g.id === 'GRN-2026-0002')!)).toBe(true)
  })
})

describe('month against month', () => {
  it('compares landed cost, quantities and unit cost per uom', () => {
    const { lines } = procurementCompare(
      procurementLotRows(state, AUG),
      procurementLotRows(state, SEP),
    )
    const landed = lines.find((l) => l.label === 'Landed cost (₹)')!
    expect(landed.a).toBe('32920')
    expect(landed.b).toBe('41000')
    expect(landed.delta).toBe('+24.5%')

    const received = lines.find((l) => l.label === 'Received (Piece)')!
    expect(received.a).toBe('1000')
    expect(received.b).toBe('1300')
  })

  it('says nothing rather than infinity when the base is zero', () => {
    const { lines } = procurementCompare([], procurementLotRows(state, SEP))
    const landed = lines.find((l) => l.label === 'Landed cost (₹)')!
    expect(landed.a).toBe('0')
    expect(landed.delta).toBe('—')
  })
})
