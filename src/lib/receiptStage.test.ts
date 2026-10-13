import { describe, expect, it } from 'vitest'
import { canStage, matchProduct, receiptFormOf, receivedAgainst } from './receiptStage.ts'
import type { StageItem } from './receiptStage.ts'
import type { Grn, Item, PurchaseProduct } from '../types.ts'

const item = (over: Partial<StageItem> & Pick<Item, 'name'>): StageItem => ({
  id: over.name,
  type: 'Raw Material',
  uom: 'Piece',
  lotControlled: true,
  reorder: 0,
  costMethod: 'average',
  ...over,
} as StageItem)

const product = (over: Partial<PurchaseProduct> & Pick<PurchaseProduct, 'id' | 'name'>): PurchaseProduct =>
  ({
    category: 'Farm Produce',
    uom: 'Piece',
    description: '',
    status: 'Active',
    vendorIds: [],
    ...over,
  }) as PurchaseProduct

const grn = (over: Partial<Grn> & Pick<Grn, 'id' | 'accepted'>): Grn =>
  ({ date: '2026-10-14', farmerId: '', farmerName: '', lot: 'LOT-1', total: 0, a: 0, b: 0, c: 0, reject: 0, rate: 0, transport: 0, materialValue: 0, landed: 0, grossCost: 0, usableCost: 0, status: 'Posted', ...over }) as Grn

describe('receiptFormOf — which receipt a material gets', () => {
  it('reads the stamped flag first', () => {
    expect(receiptFormOf(item({ name: 'Tender coconut', procurementForm: 'RAW' }))).toBe('RAW')
    expect(receiptFormOf(item({ name: 'Tea extract', procurementForm: 'READY_EXTRACT' }))).toBe('READY_EXTRACT')
  })

  it('derives what the backfill would derive for an unstamped item', () => {
    expect(receiptFormOf(item({ name: 'Tender coconut' }))).toBe('RAW')
    expect(receiptFormOf(item({ name: 'Stabilizer', directUse: true }))).toBe('DIRECT_USE')
    expect(receiptFormOf(item({ name: 'Bulk bulk', type: 'Semi Finished' }))).toBe('READY_EXTRACT')
  })

  it('answers undefined when nothing is picked', () => {
    expect(receiptFormOf(undefined)).toBeUndefined()
  })
})

describe('canStage — only the graded intake grades later', () => {
  it('is the piece-counted raw material', () => {
    expect(canStage(item({ name: 'Tender coconut' }))).toBe(true)
  })

  it('is not weighed produce, extracts or direct-use material', () => {
    expect(canStage(item({ name: 'Beetroot', uom: 'Kg' }))).toBe(false)
    expect(canStage(item({ name: 'Tea extract', uom: 'Litre', procurementForm: 'READY_EXTRACT' }))).toBe(false)
    expect(canStage(item({ name: 'Stabilizer', uom: 'Kg', directUse: true }))).toBe(false)
    expect(canStage(undefined)).toBe(false)
  })
})

describe('matchProduct — the product a PO line means', () => {
  const products = [
    product({ id: 'PP-1', name: 'Tender coconut', itemId: 'IT-1' }),
    product({ id: 'PP-2', name: 'Beetroot box', itemId: 'IT-2' }),
  ]
  const itemName = (id: string) => (id === 'IT-2' ? 'Beetroot' : '')

  it('matches by the product name, then by the item it books', () => {
    expect(matchProduct({ item: 'tender coconut' }, products, itemName)?.id).toBe('PP-1')
    expect(matchProduct({ item: 'Beetroot' }, products, itemName)?.id).toBe('PP-2')
  })

  it('leaves a line that names nothing the plant buys for a hand-pick', () => {
    expect(matchProduct({ item: 'Dragon fruit' }, products, itemName)).toBeUndefined()
    expect(matchProduct({ item: '  ' }, products, itemName)).toBeUndefined()
  })
})

describe('receivedAgainst — what the order’s lines have had booked', () => {
  const lines = [
    { item: 'Tender coconut', qty: 500, uom: 'Piece', rate: 40 },
    { item: 'Beetroot', qty: 20, uom: 'Kg', rate: 30 },
  ]
  const grns = [
    grn({ id: 'GRN-1', accepted: 300, poId: 'PO-1', productName: 'Tender coconut' }),
    grn({ id: 'GRN-2', accepted: 10, itemId: 'IT-2' }), // linked through the order's own list, not poId
    grn({ id: 'GRN-3', accepted: 999, poId: 'PO-9', productName: 'Tender coconut' }), // another order
  ]
  const itemName = (id: string) => (id === 'IT-2' ? 'Beetroot' : '')

  it('folds both link directions, per line, by material name', () => {
    expect(receivedAgainst(lines, 'PO-1', ['GRN-2'], grns, itemName)).toEqual([300, 10])
  })

  it('counts nothing when nothing links', () => {
    expect(receivedAgainst(lines, 'PO-2', [], grns, itemName)).toEqual([0, 0])
  })
})
