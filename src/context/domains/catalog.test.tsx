// @vitest-environment happy-dom
/**
 * The pack-product freeze. deleteProduct has refused on stock history since the
 * beginning, but the edit path let a pack that had already been packed swap its
 * unit or the bulk it draws: a new unit re-dimensions every pack line already on
 * the ledger (40 packs at 250 ml would silently read as 40 L), and a different
 * bulk orphans the cost trail behind them. Those two fields freeze at the first
 * ledger line; size and shelf life may still move, because posted runs carry
 * their own perPack copy.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCatalog } from './catalog'
import type { CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { ProductInput } from '../../lib/posting'
import type { AppState, Item, LedgerEntry, Product, PurchaseProduct, Vendor } from '../../types'

const BULK: Item = {
  id: 'SF-TCW-WATER', name: 'Coconut Water (bulk)', type: 'Semi Finished', uom: 'Litre',
  lotControlled: true, reorder: 0, costMethod: 'Lot Actual',
}
const OTHER_BULK: Item = {
  ...BULK, id: 'SF-ABC', name: 'ABC Melange (bulk)',
}
const PACK: Product = {
  id: 'FG-1', name: 'TCW 250 ml', type: 'BiB', size: 250, unit: 'ml', packVolume: 0.25,
  shelfLifeDays: 30, bom: [], bulkItem: 'SF-TCW-WATER', medium: 'Water',
}

/** One posted run's packs — the history the freeze keys on (ledger lines by item). */
const HISTORY: LedgerEntry = {
  id: 'LED-1', type: 'Packing Output', doc: 'PR-0001', item: 'FG-1', itemType: 'Finished Goods',
  lot: 'B-0001', location: 'freezer', status: 'Available', qtyIn: 40, qtyOut: 0, uom: 'Pack',
  unitCost: 5, time: '2026-09-22T08:00:00Z',
}

function plant(lines: LedgerEntry[]): AppState {
  return migrateState({ items: [BULK, OTHER_BULK], products: [PACK], ledger: lines })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(lines: LedgerEntry[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const d: CoreDeps = {
    state: plant(lines),
    setState,
    nextId: vi.fn(() => 'FG-2'),
    nextLot: vi.fn(() => 'LOT-0001'),
    log,
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'admin@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast, log }
}

/** Applies the updater the hook posted, against a copy of the state it read. */
function applied(d: CoreDeps, setState: ReturnType<typeof vi.fn>): AppState {
  const updater = setState.mock.calls[0][0] as (prev: AppState) => AppState
  return updater(deepClone(d.state))
}

const input = (over: Partial<ProductInput> = {}): ProductInput => ({
  name: 'TCW 250 ml',
  type: 'BiB',
  size: 250,
  unit: 'ml',
  bulkItem: 'SF-TCW-WATER',
  shelfLifeDays: 30,
  bom: [],
  ...over,
})

const FREEZE_TOAST =
  'TCW 250 ml has stock history — its pack unit and the bulk it draws cannot change. Size and shelf life may still be edited.'

afterEach(cleanup)

describe('updateProduct', () => {
  it('refuses a pack-unit change once the pack has stock history', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updateProduct('FG-1', input({ unit: 'L' }))).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(FREEZE_TOAST)
  })

  it('refuses pointing the pack at a different bulk for the same reason', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updateProduct('FG-1', input({ bulkItem: 'SF-ABC' }))).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(FREEZE_TOAST)
  })

  it('still lets size and shelf life move — posted runs carry their own perPack', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updateProduct('FG-1', input({ size: 300, shelfLifeDays: 45 }))).toBe('FG-1')
    const draft = applied(d, setState)
    expect(draft.products[0].size).toBe(300)
    expect(draft.products[0].packVolume).toBeCloseTo(0.3, 10) // 300 ml in base units
    expect(draft.products[0].shelfLifeDays).toBe(45)
    expect(showToast).toHaveBeenCalledWith('TCW 250 ml updated.')
  })

  it('allows the unit to move while there is no history to re-dimension', () => {
    const { d, setState } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updateProduct('FG-1', input({ unit: 'L', size: 0.3 }))).toBe('FG-1')
    const draft = applied(d, setState)
    expect(draft.products[0].unit).toBe('L')
    expect(draft.products[0].packVolume).toBeCloseTo(0.3, 10)
  })
})

/**
 * The edit dialog's dropped supplier list. The form has always offered the
 * supplier picker on edit, but its save posted only name/uom/description — a
 * changed supplier list kept the old one, while the Suppliers button on the
 * card (updatePurchaseProductVendors) applied it fine. The edit path now
 * carries vendorIds through, under the same at-least-one-supplier rule add
 * enforces for anything that is not packing material.
 */
describe('updatePurchaseProduct — suppliers', () => {
  const PP: PurchaseProduct = {
    id: 'PP-1', name: 'Tender Coconut', category: 'Farm Produce', uom: 'Nos',
    description: '', vendorIds: ['VEN-1'], itemId: 'RM-PP-1', status: 'Active',
  }
  const PM: PurchaseProduct = {
    ...PP, id: 'PP-2', name: '5 L BiB', category: 'Packing Material', uom: 'Piece',
    vendorIds: ['VEN-1'], itemId: 'PM-PP-2',
  }
  const edit = (over: Partial<{ name: string; uom: string; description: string; vendorIds: string[] }> = {}) => ({
    name: 'Tender Coconut', uom: 'Nos', description: '', ...over,
  })

  /** Suppliers survive migration only when the vendor exists — migrate.ts drops
   *  dead links — so the fixture carries the vendors the products point at. */
  const vendor = (id: string): Vendor => ({
    id, name: `Vendor ${id}`, vendorTypeId: id === 'VEN-1' ? 'VT-FARMER' : 'VT-VENDOR',
    phone: '', area: '', payment: '', status: 'Active',
  })

  function ppDeps(rows: PurchaseProduct[]) {
    const base = deps([])
    const state = migrateState({
      vendors: [vendor('VEN-1'), vendor('VEN-2'), vendor('VEN-3')],
      purchaseProducts: rows,
    })
    return { ...base, d: { ...base.d, state } }
  }

  it('applies a changed supplier list from the edit dialog', () => {
    const { d, setState } = ppDeps([PP])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updatePurchaseProduct('PP-1', edit({ vendorIds: ['VEN-2', 'VEN-3'] }))).toBe('PP-1')
    const draft = applied(d, setState)
    expect(draft.purchaseProducts[0].vendorIds).toEqual(['VEN-2', 'VEN-3'])
  })

  it('keeps the existing suppliers when the caller does not mention them', () => {
    const { d, setState } = ppDeps([PP])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updatePurchaseProduct('PP-1', edit({ name: 'Tender Coconuts' }))).toBe('PP-1')
    const draft = applied(d, setState)
    expect(draft.purchaseProducts[0].vendorIds).toEqual(['VEN-1'])
    expect(draft.purchaseProducts[0].name).toBe('Tender Coconuts')
  })

  it('refuses clearing every supplier off farm produce — the rule add enforces', () => {
    const { d, setState, showToast } = ppDeps([PP])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updatePurchaseProduct('PP-1', edit({ vendorIds: [] }))).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Select at least one farmer or vendor.')
  })

  it('lets a packing material float free of suppliers', () => {
    const { d, setState } = ppDeps([PM])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.updatePurchaseProduct('PP-2', edit({ name: '5 L BiB', vendorIds: [] }))).toBe('PP-2')
    const draft = applied(d, setState)
    expect(draft.purchaseProducts[0].vendorIds).toEqual([])
  })
})
