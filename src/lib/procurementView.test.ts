import { describe, expect, it } from 'vitest'
import { fixtureState } from './reports/fixtures.ts'
import {
  drawnLots,
  filterGrnRows,
  grnPreview,
  orderSuppliersByLink,
  pmReceiptConsumed,
  pmReceiptRows,
} from './procurementView.ts'
import type { Grn, LedgerEntry, Vendor } from '../types.ts'

/**
 * The procurement page's derivations on the reports' golden plant. The fixture's
 * ledger already carries one packing-material receipt that a packing run has
 * drawn on, which is exactly the freeze rule pmReceiptConsumed encodes.
 */

const draftReceipt: Grn = {
  ...fixtureState().grns[0],
  id: 'GRN-2026-0006',
  lot: 'LOT-20260914-006',
  status: 'Draft',
  farmerName: 'Grove House',
  area: 'Medchal',
}

const grns = [...fixtureState().grns, draftReceipt]

describe('filterGrnRows', () => {
  it('newest first when nothing is asked', () => {
    expect(filterGrnRows(grns, '', '').map((g) => g.id)).toEqual([
      'GRN-2026-0006',
      'GRN-2026-0005',
      'GRN-2026-0004',
      'GRN-2026-0003',
      'GRN-2026-0002',
      'GRN-2026-0001',
    ])
  })

  it('searches receipt, lot, source and area, case-insensitively', () => {
    expect(filterGrnRows(grns, 'lot-20260805', '').map((g) => g.id)).toEqual(['GRN-2026-0001'])
    expect(filterGrnRows(grns, 'medchal', '').map((g) => g.id)).toEqual(['GRN-2026-0006'])
    expect(filterGrnRows(grns, 'direct', '').map((g) => g.id)).toEqual(['GRN-2026-0002'])
  })

  it('the produce search is not trimmed — spaces are part of the needle', () => {
    expect(filterGrnRows(grns, '  Lakshmi  ', '')).toEqual([])
  })

  it('narrows by status first', () => {
    expect(filterGrnRows(grns, '', 'Draft').map((g) => g.id)).toEqual(['GRN-2026-0006'])
  })
})

describe('drawnLots', () => {
  it('every lot with a line that took stock out', () => {
    const ledger: LedgerEntry[] = [
      {
        id: 'L1', type: 'Receipt', doc: 'GRN-1', item: 'RM-1', itemType: 'Raw Material',
        lot: 'LOT-A', location: 'RM Store', status: 'Available', qtyIn: 100, qtyOut: 0,
        uom: 'Kg', unitCost: 10, time: '2026-09-01T10:00:00Z',
      },
      {
        id: 'L2', type: 'Production Consume', doc: 'BAT-1', item: 'RM-1', itemType: 'Raw Material',
        lot: 'LOT-A', location: 'RM Store', status: 'Available', qtyIn: 0, qtyOut: 40,
        uom: 'Kg', unitCost: 10, time: '2026-09-02T10:00:00Z',
      },
      {
        id: 'L3', type: 'Production Consume', doc: 'BAT-1', item: 'RM-2', itemType: 'Raw Material',
        lot: 'LOT-B', location: 'RM Store', status: 'Available', qtyIn: 0, qtyOut: 0,
        uom: 'Kg', unitCost: 10, time: '2026-09-02T10:00:00Z',
      },
    ]
    expect(drawnLots(ledger)).toEqual(new Set(['LOT-A']))
  })
})

describe('pmReceiptRows', () => {
  it('every packing-material receipt, newest first, searchable by material name', () => {
    const base = fixtureState()
    const older: LedgerEntry = {
      id: 'LED-PM-0',
      type: 'PM Receipt',
      doc: 'PMR-2026-0000',
      item: 'PM-CAP',
      itemType: 'Packing Material',
      lot: 'LOT-PM-0',
      location: 'PM Store',
      status: 'Available',
      qtyIn: 1000,
      qtyOut: 0,
      uom: 'Piece',
      unitCost: 2,
      time: '2026-08-30T10:00:00Z',
      vendorId: 'VEN-0003',
    }
    const state = { ...base, ledger: [...base.ledger, older] }

    expect(pmReceiptRows(state, '').map((l) => l.doc)).toEqual(['PMR-2026-0001', 'PMR-2026-0000'])
    // "5 l bib" is the item's name, not its id (PM-BIB-5L has no spaces) — the
    // search reads the master.
    expect(pmReceiptRows(state, '5 l bib').map((l) => l.doc)).toEqual(['PMR-2026-0001'])
    expect(pmReceiptRows(state, '  5 l bib  ').map((l) => l.doc)).toEqual(['PMR-2026-0001'])
    expect(pmReceiptRows(state, 'nothing')).toEqual([])
  })
})

describe('pmReceiptConsumed', () => {
  it('a packing run drawing the same item and lot freezes the receipt', () => {
    const state = fixtureState()
    // PKG-2026-0009 consumed 30 of PM-BIB-5L / LOT-PM-1.
    expect(pmReceiptConsumed(state.ledger, 'PMR-2026-0001')).toBe(true)
    expect(pmReceiptConsumed(state.ledger, 'no-such-receipt')).toBe(false)
  })
})

describe('orderSuppliersByLink', () => {
  const vendors: Vendor[] = [
    { id: 'VEN-1', name: 'Lakshmi Farms', vendorTypeId: 'VT-FARMER', phone: '', area: '', payment: '', status: 'Active' },
    { id: 'VEN-2', name: 'Pack Supplies', vendorTypeId: 'VT-VENDOR', phone: '', area: '', payment: '', status: 'Active' },
    { id: 'VEN-3', name: 'Retired Supplier', vendorTypeId: 'VT-VENDOR', phone: '', area: '', payment: '', status: 'Inactive' },
  ]

  it('linked suppliers first, then the rest; the form keeps its unapproved pick listed', () => {
    expect(orderSuppliersByLink(vendors, ['VEN-2'], 'VEN-3').map((v) => v.id)).toEqual([
      'VEN-2',
      'VEN-1',
      'VEN-3',
    ])
    expect(orderSuppliersByLink(vendors, [], '').map((v) => v.id)).toEqual(['VEN-1', 'VEN-2'])
  })
})

describe('grnPreview', () => {
  it('free sits inside the total but is never charged; accepted is the graded sum', () => {
    expect(
      grnPreview({ total: 1000, free: 50, rate: 30, transport: 500, a: 600, b: 250, c: 60, reject: 40 }),
    ).toEqual({
      chargeable: 950,
      landed: 29000,
      accepted: 910,
      graded: 950,
      ungraded: 50,
    })
  })

  it('more free than received clamps the charge at zero — only transport is paid', () => {
    expect(
      grnPreview({ total: 100, free: 120, rate: 30, transport: 500, a: 0, b: 0, c: 0, reject: 0 }),
    ).toEqual({ chargeable: 0, landed: 500, accepted: 0, graded: 0, ungraded: 100 })
  })
})
