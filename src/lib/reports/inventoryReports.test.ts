import { describe, expect, it } from 'vitest'
import { AUG, SEP, TODAY, fixtureState } from './fixtures.ts'
import { stockRows } from '../stock.ts'
import { fgOnHand, itemFlows, lotAgeing } from './inventoryReports.ts'

const state = fixtureState()

describe('the ledger engine (raw material report)', () => {
  it('walks opening → received → issued → closing for the window', () => {
    const rows = itemFlows(state, AUG, ['Raw Material'])
    const coco = rows.find((r) => r.item === 'RM-TCW-COCO')!
    expect(coco.opening).toBe(0)
    expect(coco.received).toBe(950)
    expect(coco.issued).toBe(900)
    expect(coco.closing).toBe(50)

    const beet = rows.find((r) => r.item === 'RM-BEET')!
    expect(beet.received).toBe(98)
    expect(beet.issued).toBe(98)
    expect(beet.closing).toBe(0)
  })

  it('carries a closing stock forward as the next window’s opening', () => {
    const coco = itemFlows(state, SEP, ['Raw Material']).find((r) => r.item === 'RM-TCW-COCO')!
    expect(coco.opening).toBe(50)
    expect(coco.received).toBe(1280)
    expect(coco.issued).toBe(500)
    expect(coco.closing).toBe(830)
  })

  it('never disagrees with the stock the Inventory page would show', () => {
    // The compare-totals-not-rows rule: fold both sides to an item total.
    for (const type of ['Raw Material', 'Packing Material', 'Finished Goods']) {
      const closing = itemFlows(state, { from: '2000-01-01', to: TODAY }, [type]).reduce<
        Record<string, number>
      >((by, r) => ({ ...by, [r.item]: r.closing }), {})
      const onHand = stockRows(state)
        .filter((r) => r.itemType === type)
        .reduce<Record<string, number>>((by, r) => ({ ...by, [r.item]: (by[r.item] || 0) + r.qty }), {})
      for (const item of Object.keys(onHand)) {
        expect(Number((closing[item] || 0).toFixed(3)), item).toBe(Number(onHand[item].toFixed(3)))
      }
    }
  })
})

describe('the packing material report', () => {
  it('folds PM receipts and packing consumption, with reorder flags', () => {
    const rows = itemFlows(state, SEP, ['Packing Material'])
    expect(rows).toHaveLength(1)
    const bib = rows[0]
    expect(bib.name).toBe('5 L BiB')
    expect(bib.received).toBe(200)
    expect(bib.issued).toBe(30)
    expect(bib.closing).toBe(170)
    expect(bib.reorder).toBe(100)
    expect(bib.belowReorder).toBe(false)
  })

  it('flags an item that has fallen below its reorder level', () => {
    const drained = {
      ...state,
      ledger: [
        ...state.ledger,
        {
          id: 'LED-TEST-DRAIN',
          type: 'Stock Issue',
          doc: 'ISS-TEST',
          item: 'PM-BIB-5L',
          itemType: 'Packing Material',
          lot: 'LOT-PM-1',
          location: 'PM Store',
          status: 'Available',
          qtyIn: 0,
          qtyOut: 150,
          uom: 'Piece',
          unitCost: 15,
          time: '2026-09-11T10:00:00Z',
        },
      ],
    }
    const bib = itemFlows(drained, SEP, ['Packing Material'])[0]
    expect(bib.closing).toBe(20)
    expect(bib.belowReorder).toBe(true)
  })
})

describe('lot ageing', () => {
  it('ages lots still on hand from harvest where there is one', () => {
    const { rows, byAge } = lotAgeing(state, ['Raw Material'], TODAY)
    const byLot = new Map(rows.map((r) => [r.lot, r]))
    expect(byLot.get('LOT-20260805-001')!.from).toBe('2026-08-04') // harvestedOn
    expect(byLot.get('LOT-20260805-001')!.onHand).toBe(50)
    expect(byLot.get('LOT-20260903-003')!.from).toBe('2026-09-02')
    // Beetroot is fully pressed: not listed.
    expect(byLot.has('LOT-20260806-002')).toBe(false)

    const piece = byAge.filter((b) => b.uom === 'Piece')
    expect(piece.find((b) => b.bucket === '15+ days')!).toEqual({
      bucket: '15+ days',
      uom: 'Piece',
      lots: 1,
      qty: 50,
    })
    expect(piece.find((b) => b.bucket === '8–14 days')!.qty).toBe(485)
    expect(piece.find((b) => b.bucket === '4–7 days')!.qty).toBe(295)
  })
})

describe('finished goods on hand', () => {
  it('reads the position through the same fold the Inventory page uses', () => {
    const rows = fgOnHand(state, TODAY)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.item).toBe('FG-TCW-5L')
    expect(row.qty).toBe(3) // 30 packed − 20 delivered − 5 in transit − 2 issued
    expect(row.value).toBeCloseTo(3 * 585.28, 2)
    expect(row.locationLabel).toBe('Finished Goods Cold Room')
    expect(row.expiry).toBe('2026-10-30')
    expect(row.daysToExpiry).toBe(46)
    expect(row.bucket).toBe('> 30 d')
  })

  it('buckets stock past its expiry and inside the alert window', () => {
    const alerting = {
      ...state,
      ledger: state.ledger.map((l) =>
        l.expiry === '2026-10-30' ? { ...l, expiry: '2026-09-15' } : l,
      ),
    }
    const row = fgOnHand(alerting, TODAY)[0]
    expect(row.daysToExpiry).toBe(1)
    expect(row.bucket).toBe('≤ 2 d')
  })
})
