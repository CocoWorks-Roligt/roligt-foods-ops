import { describe, expect, it } from 'vitest'
import { EMPTY_MONTH, SEP, fixtureState } from './fixtures.ts'
import { dispatchRows } from './dispatchReport.ts'

const state = fixtureState()

describe('dispatch report', () => {
  it('groups a month by SKU, delivered apart from outstanding', () => {
    const rows = dispatchRows(state, SEP, 'month')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.group).toBe('2026-09')
    expect(row.skuName).toBe('OG Tender Coconut Water 5 L')
    expect(row.uom).toBe('Pack')
    expect(row.qty).toBe(25)
    expect(row.deliveredQty).toBe(20)
    expect(row.pendingQty).toBe(5)
    expect(row.dispatchCount).toBe(2)
    expect(row.customers).toEqual(['Hyderabad Fresh'])
    expect(row.challans).toEqual(['DC0001/2026'])
    expect(row.orderIds).toEqual(['ORD-2026-0001'])
    // Delivered with no receiver written down.
    expect(row.podMissing).toBe(1)
  })

  it('groups by batch when the report is asked that way', () => {
    const rows = dispatchRows(state, SEP, 'batch')
    expect(rows).toHaveLength(1)
    expect(rows[0].group).toBe('BAT-2026-0001')
    expect(rows[0].qty).toBe(25)
  })

  it('keeps SKUs counted in different units as separate rows', () => {
    // A malai dispatch sits beside packs in the same month; adding 20 Packs to
    // 30 Kg would be a number with no physical meaning.
    const kgDispatch = {
      ...state.dispatches[0],
      id: 'DSP-2026-0003',
      sku: 'FG-MALAI',
      qty: 30,
      dispatchTime: '2026-09-09T10:00:00Z',
    }
    const mixed = { ...state, dispatches: [...state.dispatches, kgDispatch] }
    const rows = dispatchRows(mixed, SEP, 'month')
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.sku === 'FG-MALAI')!.uom).toBe('Kg')
    expect(rows.find((r) => r.sku === 'FG-TCW-5L')!.uom).toBe('Pack')
  })

  it('shows nothing for a month nothing left in', () => {
    expect(dispatchRows(state, EMPTY_MONTH, 'month')).toEqual([])
  })
})
