import { describe, expect, it } from 'vitest'
import { buildLinkMaps, columnsFor, ledgerColumns } from './mappers.js'
import type { LinkMaps } from './mappers.js'
import { T } from './baseSchema.js'
import type { ZohoRecord } from './zoho.js'

// The fork's Plan 2 mapping: every collection fills its real columns, keyed by
// field NAME the way columnsFor emits (columnsByFieldId translates to IDs).
// buildLinkMaps reads each table's own appId/dataJson ids, so a helper that rows
// a table by its real schema is what the dual-keying tests need.
const rowIn = (base: string, appId: string, doc: Record<string, unknown>): ZohoRecord => {
  const t = T[base]
  return { recordID: `z-${appId}`, data: { [t.appId]: appId, ...(t.dataJson ? { [t.dataJson]: JSON.stringify(doc) } : {}) } }
}

describe('buildLinkMaps — the eight tables the Plan 2 link columns read', () => {
  it('keys customers and products by BOTH app id and name, batches and staff by id', () => {
    const maps = buildLinkMaps(
      {
        vendors: [rowIn('Vendors', 'V1', { name: 'Farmer Joe' })],
        purchaseProducts: [rowIn('Purchase Products', 'P1', { name: 'Coconut' })],
        storageLocations: [rowIn('Storage Locations', 'L1', { name: 'Freezer 1' })],
        items: [rowIn('Items', 'I1', { name: 'Coconut Water' })],
        customers: [rowIn('Customers', 'C1', { name: 'Hotel Green' })],
        products: [rowIn('Products', 'PR1', { name: '250ml BiB' })],
        batches: [rowIn('Batches', 'BTH-2026-0007', { id: 'BTH-2026-0007' })],
        staff: [rowIn('Staff', 'S1', { name: 'Ravi' })],
      },
      {
        vendors: T['Vendors'], purchaseProducts: T['Purchase Products'], storageLocations: T['Storage Locations'], items: T['Items'],
        customers: T['Customers'], products: T['Products'], batches: T['Batches'], staff: T['Staff'],
      },
    )
    expect(maps.customers.get('C1')).toBe('z-C1')
    expect(maps.customers.get('Hotel Green')).toBe('z-C1')
    expect(maps.products.get('PR1')).toBe('z-PR1')
    expect(maps.products.get('250ml BiB')).toBe('z-PR1')
    expect(maps.batches.get('BTH-2026-0007')).toBe('z-BTH-2026-0007')
    expect(maps.staff.get('S1')).toBe('z-S1')
    expect(maps.items.get('Coconut Water')).toBe('z-I1')
    expect(maps.storageLocations.get('Freezer 1')).toBe('z-L1')
  })
})

const noLinks: LinkMaps = {
  vendors: new Map(), purchaseProducts: new Map(), storageLocations: new Map(), items: new Map(),
  customers: new Map(), products: new Map(), batches: new Map(), staff: new Map(),
}

describe('columnsFor — real columns for every collection (field names, best-effort)', () => {
  it('customers: plain columns, phone digits only', () => {
    const out = columnsFor('customers', { id: 'C1', name: 'Hotel Green', shipTo: 'MG Road', gst: '29ABCDE1234F1Z5', status: 'Active', phone: '+91 98450 12345', email: 'buy@green.in', contactPerson: 'Mr Rao', notes: 'AM delivery' }, noLinks)
    expect(out).toEqual({ Name: 'Hotel Green', 'Ship To': 'MG Road', GSTIN: '29ABCDE1234F1Z5', Status: 'Active', Phone: '919845012345', Email: 'buy@green.in', 'Contact Person': 'Mr Rao', Notes: 'AM delivery' })
  })

  it('products: pack facts and the bulk item link by name', () => {
    const links = { ...noLinks, items: new Map([['Coconut Water', 'z-i1']]) }
    const out = columnsFor('products', { id: 'PR1', name: '250ml BiB', type: 'BiB', size: 250, unit: 'ml', packVolume: 0.25, shelfLifeDays: 365, mrp: 40, bulkItem: 'Coconut Water' }, links)
    expect(out).toEqual({ Name: '250ml BiB', Format: 'BiB', Size: '250', Unit: 'ml', 'Pack Volume': '0.25', 'Shelf Life Days': '365', 'Chilled Shelf Life Days': undefined, MRP: '40', Medium: undefined, 'Bulk Item': 'z-i1' })
  })

  it('melanges: output item link by name', () => {
    const links = { ...noLinks, items: new Map([['ABC Melange', 'z-i2']]) }
    expect(columnsFor('melanges', { id: 'M1', name: 'ABC Blend', status: 'Active', outputItem: 'ABC Melange' }, links)).toEqual({ Name: 'ABC Blend', Status: 'Active', 'Output Item': 'z-i2' })
  })

  it('staff: staff no from the id, phone digits only', () => {
    const out = columnsFor('staff', { id: 'STF-001', name: 'Ravi', role: 'Operator', phone: '98450 12345', status: 'Active', addedOn: '2026-01-05' }, noLinks)
    expect(out).toEqual({ 'Staff No': 'STF-001', Name: 'Ravi', Role: 'Operator', Phone: '9845012345', Status: 'Active', 'Added On': '2026-01-05' })
  })

  it('batches: batch facts and the location link by name', () => {
    const links = { ...noLinks, storageLocations: new Map([['Freezer 1', 'z-l1']]) }
    const out = columnsFor('batches', { id: 'BTH-2026-0007', date: '2026-10-01', kind: 'Extraction', spoiled: 12, costPerL: 18.5, status: 'Released', location: 'Freezer 1' }, links)
    expect(out).toEqual({ 'Batch No': 'BTH-2026-0007', Date: '2026-10-01', Kind: 'Extraction', Spoiled: '12', 'Cost per Unit': '18.5', Status: 'Released', Location: 'z-l1' })
  })

  it('packing runs: batch, bulk item and location links', () => {
    const links = {
      ...noLinks,
      batches: new Map([['BTH-2026-0007', 'z-b1']]),
      items: new Map([['Coconut Water', 'z-i1']]),
      storageLocations: new Map([['Packing Store', 'z-l2']]),
    }
    const out = columnsFor('packingRuns', { id: 'PKG-2026-0003', date: '2026-10-02', batchId: 'BTH-2026-0007', bulkItem: 'Coconut Water', location: 'Packing Store', drawn: 120, status: 'Done' }, links)
    expect(out).toEqual({ 'Run No': 'PKG-2026-0003', Date: '2026-10-02', Drawn: '120', Status: 'Done', Batch: 'z-b1', 'Bulk Item': 'z-i1', Location: 'z-l2' })
  })

  it('orders: the customer link, lines stay in the Data JSON', () => {
    const links = { ...noLinks, customers: new Map([['C1', 'z-c1']]) }
    const out = columnsFor('orders', { id: 'ORD-2026-0009', date: '2026-10-03', status: 'Open', customerId: 'C1', lines: [{ sku: '250ml BiB', qty: 40 }] }, links)
    expect(out).toEqual({ 'Order No': 'ORD-2026-0009', Date: '2026-10-03', Status: 'Open', Notes: undefined, Customer: 'z-c1' })
  })

  it('qcs: tests as JSON without the attachment objects, batch and item links', () => {
    const links = {
      ...noLinks,
      batches: new Map([['BTH-2026-0007', 'z-b1']]),
      items: new Map([['Coconut Water', 'z-i1']]),
    }
    const out = columnsFor('qcs', { id: 'QC-2026-0011', batchId: 'BTH-2026-0007', item: 'Coconut Water', micro: 'Pass', pesticides: 'Fail', heavyMetals: 'Pass', physico: 'Pass', microReport: { fileName: 'x.pdf' }, tests: { sensory: { status: 'Pass' } }, disposition: 'Released' }, links)
    expect(out).toEqual({
      'Doc No': 'QC-2026-0011', Disposition: 'Released',
      'Tests JSON': JSON.stringify({ micro: 'Pass', pesticides: 'Fail', heavyMetals: 'Pass', physico: 'Pass', sensory: { status: 'Pass' } }),
      Batch: 'z-b1', Item: 'z-i1',
    })
  })

  it('dispatches: challan, sku-by-name and batch-by-lot links; no POD — the attachment poisons trailing fields', () => {
    const links = {
      ...noLinks,
      customers: new Map([['C1', 'z-c1']]),
      products: new Map([['250ml BiB', 'z-pr1']]),
      batches: new Map([['BTH-2026-0007', 'z-b1']]),
    }
    const out = columnsFor('dispatches', { id: 'DSP-2026-0004', customerId: 'C1', batchId: 'BTH-2026-0007', sku: '250ml BiB', qty: 40, expiry: '2027-10-01', challan: 'CH-2026-0018', vehicle: 'KA 01 AB 1234', dispatchTime: '2026-10-03T08:30:00.000Z', status: 'Dispatched', pod: 'Signed' }, links)
    expect(out).toEqual({ 'Challan No': 'CH-2026-0018', Date: '2026-10-03T08:30:00.000Z', Expiry: '2027-10-01', Qty: '40', Vehicle: 'KA 01 AB 1234', Status: 'Dispatched', Customer: 'z-c1', SKU: 'z-pr1', Batch: 'z-b1' })
    expect(out.POD).toBeUndefined()
  })

  it('stock issues: lines as JSON and the value', () => {
    const out = columnsFor('stockIssues', { id: 'ISS-2026-0002', date: '2026-10-04', reason: 'Lab / testing', recipient: 'Veritas Lab', lines: [{ item: '250ml BiB', qty: 2 }], value: 80 }, noLinks)
    expect(out).toEqual({ 'Doc No': 'ISS-2026-0002', Date: '2026-10-04', Reason: 'Lab / testing', 'Issued To': 'Veritas Lab', 'Lines JSON': JSON.stringify([{ item: '250ml BiB', qty: 2 }]), Value: '80' })
  })

  it('lab reports: scores as JSON, customer linked BY NAME, batch only when named', () => {
    const links = {
      ...noLinks,
      customers: new Map([['Hotel Green', 'z-c1']]),
      batches: new Map([['BTH-2026-0007', 'z-b1']]),
    }
    const withBatch = columnsFor('labReports', { id: 'LR-2026-0021', category: 'sensory', customerName: 'Hotel Green', batchId: 'BTH-2026-0007', sampleDate: '2026-10-01', issueDate: '2026-10-05', scores: [{ section: 'Aroma', score: 4 }] }, links)
    expect(withBatch).toEqual({ 'Report No': 'LR-2026-0021', 'Sample Date': '2026-10-01', 'Issue Date': '2026-10-05', 'Scores JSON': JSON.stringify([{ section: 'Aroma', score: 4 }]), Category: 'sensory', Batch: 'z-b1', Customer: 'z-c1' })
    // a trial number names no batch — the free text stays in the Data JSON only
    const trial = columnsFor('labReports', { id: 'LR-2026-0022', category: 'micro', customerName: 'Hotel Green', sampleDate: '2026-10-01', issueDate: '2026-10-05', batchLotDetails: 'TRIAL-7' }, links)
    expect(trial.Batch).toBeUndefined()
  })

  it('shifts and attendance: the staff link off staffId', () => {
    const links = { ...noLinks, staff: new Map([['S1', 'z-s1']]) }
    expect(columnsFor('shifts', { id: 'S1|2026-10-05', staffId: 'S1', date: '2026-10-05', shift: 'Morning', line: 'Extraction', note: 'late swap' }, links))
      .toEqual({ Key: 'S1|2026-10-05', Date: '2026-10-05', Shift: 'Morning', Line: 'Extraction', Note: 'late swap', Staff: 'z-s1' })
    expect(columnsFor('attendance', { id: 'S1|2026-10-05', staffId: 'S1', date: '2026-10-05', status: 'Present' }, links))
      .toEqual({ Key: 'S1|2026-10-05', Date: '2026-10-05', Status: 'Present', Staff: 'z-s1' })
  })

  it('production plans: the product link answers pack names, free text may not resolve', () => {
    const links = { ...noLinks, products: new Map([['250ml BiB', 'z-pr1']]) }
    const out = columnsFor('productionPlans', { id: 'PLAN-2026-0044', date: '2026-10-06', stage: 'Packing', product: '250ml BiB', qty: 500, uom: 'Packs', status: 'Planned' }, links)
    expect(out).toEqual({ 'Plan No': 'PLAN-2026-0044', Day: '2026-10-06', Stage: 'Packing', Product: 'z-pr1', Qty: '500', UOM: 'Packs', Note: undefined, Status: 'Planned' })
    // a bulk item or melange name is not a pack product — the column stays empty
    const bulk = columnsFor('productionPlans', { id: 'PLAN-2026-0045', date: '2026-10-06', stage: 'Extraction', product: 'Coconut Water', qty: 300, uom: 'Litre', status: 'Planned' }, links)
    expect(bulk.Product).toBeUndefined()
  })

  it('sticker templates and prints: template fields as JSON, copies as qty', () => {
    expect(columnsFor('stickerTemplates', { stage: 'pack', title: 'Pack Sticker', fields: [{ label: 'Lot' }] }, noLinks))
      .toEqual({ Name: 'Pack Sticker', Stage: 'pack', 'Template JSON': JSON.stringify([{ label: 'Lot' }]) })
    expect(columnsFor('stickerPrints', { id: 'STK-2026-0100', stage: 'pack', title: 'Pack Sticker', copies: 3, printedAt: '2026-10-06T09:00:00.000Z' }, noLinks))
      .toEqual({ 'Doc No': 'STK-2026-0100', Stage: 'pack', Title: 'Pack Sticker', 'Printed At': '2026-10-06T09:00:00.000Z', Qty: '3' })
  })

  it('test parameters and purchase products: plain columns plus the item link', () => {
    const links = { ...noLinks, items: new Map([['I1', 'z-i1']]) }
    expect(columnsFor('testParameters', { id: 'TP1', category: 'micro', name: 'Total Plate Count', method: 'ISO 4833', unit: 'CFU/g' }, noLinks))
      .toEqual({ Name: 'Total Plate Count', Method: 'ISO 4833', Unit: 'CFU/g', Category: 'micro' })
    expect(columnsFor('purchaseProducts', { id: 'PP1', name: 'Coconut', uom: 'Nos', itemId: 'I1' }, links))
      .toEqual({ Name: 'Coconut', 'Default UOM': 'Nos', Item: 'z-i1' })
  })

  it('ledger keeps its columns: names link by BOTH id and name keys', () => {
    const links = {
      ...noLinks,
      items: new Map([['I1', 'z-i1'], ['Coconut Water', 'z-i1']]),
      storageLocations: new Map([['Freezer 1', 'z-l1']]),
    }
    const out = ledgerColumns({ id: 'L1', type: 'in', doc: 'GRN-2026-0007', lot: 'BTH-2026-0007', item: 'Coconut Water', item_type: 'Bulk', location: 'Freezer 1', status: 'Released', qty_in: 120, qty_out: 0, unit_cost: 18.5, expiry: '2027-01-01', at: '2026-10-01T07:00:00.000Z', uom: 'Litre' }, links)
    expect(out).toEqual({ Doc: 'GRN-2026-0007', Type: 'in', Lot: 'BTH-2026-0007', Status: 'Released', 'Qty In': '120', 'Qty Out': '0', 'Unit Cost': '18.5', Expiry: '2027-01-01', Time: '2026-10-01T07:00:00.000Z', Item: 'z-i1', Location: 'z-l1' })
  })
})
