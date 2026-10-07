import { describe, expect, it } from 'vitest'
import { overdrawnLots } from './stock.ts'
import type { AppState } from '../types.ts'

/**
 * The over-draw fold (the audit's S2-8): availability checks are client-only,
 * so two offline devices can both pass them against the same released lot, both
 * ledger sets land, and the fold quietly answers a negative balance nobody was
 * reading. Detection runs after the fact on the same fold the stock view uses —
 * these tests pin what it flags, what it does not, and that a lot split by
 * expiry is two lots.
 */
const line = (o: {
  id: string
  doc: string
  qtyIn?: number
  qtyOut?: number
  item?: string
  expiry?: string
}) => ({
  item: 'SKU-1',
  itemType: 'Finished Goods',
  lot: 'LOT-1',
  location: 'Cold Room A',
  status: 'Available',
  uom: 'Piece',
  qtyIn: 0,
  qtyOut: 0,
  unitCost: 10,
  ...o,
})

const asState = (ledger: unknown) => ({ ledger }) as unknown as AppState

describe('overdrawnLots', () => {
  it('flags the two-device collision — the negative row names every document that drew it, once each', () => {
    // 100 in, 30 + 30 out on DSP-1 and 60 out on DSP-2: the lot is over-drawn by
    // 20 and both dispatches are named — DSP-1 once despite its two lines
    const ods = overdrawnLots(
      asState([
        line({ id: 'L1', doc: 'GRN-1', qtyIn: 100 }),
        line({ id: 'L2', doc: 'DSP-1', qtyOut: 30 }),
        line({ id: 'L3', doc: 'DSP-1', qtyOut: 30 }),
        line({ id: 'L4', doc: 'DSP-2', qtyOut: 60 }),
      ]),
    )
    expect(ods).toHaveLength(1)
    expect(ods[0].row.qty).toBe(-20)
    expect(ods[0].docs).toEqual(['DSP-1', 'DSP-2'])
  })

  it('flags nothing on a healthy plant — stocked, partly drawn and exactly drained alike', () => {
    expect(
      overdrawnLots(
        asState([
          line({ id: 'L1', doc: 'GRN-1', qtyIn: 100 }),
          line({ id: 'L2', doc: 'DSP-1', qtyOut: 40 }),
          line({ id: 'L3', doc: 'GRN-2', qtyIn: 50, item: 'SKU-2' }),
          line({ id: 'L4', doc: 'DSP-9', qtyOut: 50, item: 'SKU-2' }), // exactly drained: qty 0 drops out
        ]),
      ),
    ).toEqual([])
  })

  it('keys the fold on the full row identity — the same lot under two expiries is two lots', () => {
    // the October lot is exactly drained; the December lot is over-drawn by 30 —
    // pooling them by lot alone would hide one behind the other
    const ods = overdrawnLots(
      asState([
        line({ id: 'L1', doc: 'GRN-1', qtyIn: 100, expiry: '2026-10-01' }),
        line({ id: 'L2', doc: 'DSP-1', qtyOut: 100, expiry: '2026-10-01' }),
        line({ id: 'L3', doc: 'GRN-2', qtyIn: 100, expiry: '2026-12-01' }),
        line({ id: 'L4', doc: 'DSP-2', qtyOut: 130, expiry: '2026-12-01' }),
      ]),
    )
    expect(ods).toHaveLength(1)
    expect(ods[0].row.expiry).toBe('2026-12-01')
    expect(ods[0].row.qty).toBe(-30)
    expect(ods[0].docs).toEqual(['DSP-2'])
  })
})
