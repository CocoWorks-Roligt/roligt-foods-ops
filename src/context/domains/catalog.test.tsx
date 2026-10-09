// @vitest-environment happy-dom
/**
 * The pack catalog. A pack is a stored master (state.packs) and each finished SKU
 * points at it by packId (lib/packs.ts). savePack is the only writer — it writes
 * the master, mints a SKU per recipe, propagates the physical pack onto every
 * member, and
 * refuses the edits stock history cannot survive (unassigning a packed recipe,
 * re-uniting a pack with ledger lines behind it). retirePack and deletePack are
 * the two off-ramps, one reversible, one refused while any recipe has history.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCatalog } from './catalog'
import { POSTED, type CoreDeps } from './deps'
import { packDefs, packKeyOfDef } from '../../lib/packs'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { PackDefInput } from '../../lib/posting'
import type { AppState, Item, LedgerEntry, Product, PurchaseProduct, Vendor } from '../../types'

const BULK: Item = {
  id: 'SF-TCW-WATER', name: 'Coconut Water (bulk)', type: 'Semi Finished', uom: 'Litre',
  lotControlled: true, reorder: 0, costMethod: 'Lot Actual',
}
const OTHER_BULK: Item = {
  ...BULK, id: 'SF-ABC', name: 'ABC Melange (bulk)',
}
const fgItem = (id: string, name: string): Item => ({
  id, name, type: 'Finished Goods', uom: 'Pack',
  lotControlled: true, reorder: 0, costMethod: 'Batch Actual',
})
/** Two recipes of one physical pack — the shape the pivot moved to. */
const PACK_1: Product = {
  id: 'FG-1', name: 'TCW 250 ml', type: 'BiB', size: 250, unit: 'ml', packVolume: 0.25,
  shelfLifeDays: 30, bom: [], bulkItem: 'SF-TCW-WATER', medium: 'Water', packName: '250 ml BiB',
}
const PACK_2: Product = {
  ...PACK_1, id: 'FG-2', name: 'ABC 250 ml', bulkItem: 'SF-ABC',
}

/** One posted run's packs — the history the guards key on (ledger lines by item). */
const HISTORY: LedgerEntry = {
  id: 'LED-1', type: 'Packing Output', doc: 'PR-0001', item: 'FG-1', itemType: 'Finished Goods',
  lot: 'B-0001', location: 'freezer', status: 'Available', qtyIn: 40, qtyOut: 0, uom: 'Pack',
  unitCost: 5, time: '2026-09-22T08:00:00Z',
}

const PACK_KEY = packKeyOfDef('250 ml BiB', 'BiB', 250, 'ml')

function plant(lines: LedgerEntry[]): AppState {
  return migrateState({
    items: [BULK, OTHER_BULK, fgItem('FG-1', PACK_1.name), fgItem('FG-2', PACK_2.name)],
    products: [PACK_1, PACK_2],
    ledger: lines,
  })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(lines: LedgerEntry[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  let seq = 0
  const d: CoreDeps = {
    state: plant(lines),
    setState,
    nextId: vi.fn(() => `FG-N${++seq}`),
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

/** Applies every updater in order — a second save reads the state the first wrote. */
function appliedAll(d: CoreDeps, setState: ReturnType<typeof vi.fn>): AppState {
  let s = deepClone(d.state)
  for (const call of setState.mock.calls) s = (call[0] as (prev: AppState) => AppState)(s)
  return s
}

const packInput = (over: Partial<PackDefInput> = {}): PackDefInput => ({
  name: '250 ml BiB',
  type: 'BiB',
  size: 250,
  unit: 'ml',
  bom: [],
  recipes: [
    { skuId: 'FG-1', name: 'TCW 250 ml', shelfLifeDays: 90, chilledShelfLifeDays: 7, mrp: 60 },
    { skuId: 'FG-2', name: 'ABC 250 ml', shelfLifeDays: 90, chilledShelfLifeDays: 7, mrp: 60 },
  ],
  ...over,
})

afterEach(cleanup)

describe('savePack', () => {
  it('mints a finished SKU — and its ledger item — per recipe on create', () => {
    const { d, setState } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    const ok = result.current.savePack(null, {
      name: '5 L BiB',
      type: 'BiB',
      size: 5,
      unit: 'L',
      bom: [{ item: 'PM-1', qty: 2 }],
      recipes: [{ bulkItem: 'SF-TCW-WATER', name: 'TCW 5 L', shelfLifeDays: 120 }],
    })
    expect(ok).toBe(POSTED)
    const draft = applied(d, setState)
    const p = draft.products.find((x) => x.name === 'TCW 5 L')
    expect(p).toMatchObject({
      type: 'BiB', size: 5, unit: 'L', packVolume: 5,
      bulkItem: 'SF-TCW-WATER', medium: 'Water', packName: '5 L BiB', bom: [{ item: 'PM-1', qty: 2 }],
    })
    expect(draft.packs.find((pack) => pack.id === p!.packId)).toMatchObject(
      { id: p!.packId, name: '5 L BiB', type: 'BiB', size: 5, unit: 'L', bom: [{ item: 'PM-1', qty: 2 }] },
    )
    // The ledger books packs against an item, so the SKU lands with one at its side.
    expect(draft.items.find((i) => i.id === p!.id)).toMatchObject({
      type: 'Finished Goods', uom: 'Pack', name: 'TCW 5 L',
    })
  })

  it('groups by key, not by row: a second save with the same key joins the pack', () => {
    const { d, setState } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    const input = (recipe: PackDefInput['recipes'][number]): PackDefInput => ({
      name: '5 L BiB', type: 'BiB', size: 5, unit: 'L', bom: [], recipes: [recipe],
    })
    expect(result.current.savePack(null, input({ bulkItem: 'SF-TCW-WATER', name: 'TCW 5 L', shelfLifeDays: 90 }))).toBeTruthy()
    expect(result.current.savePack(null, input({ bulkItem: 'SF-ABC', name: 'ABC 5 L', shelfLifeDays: 90 }))).toBeTruthy()
    const defs = packDefs(appliedAll(d, setState).products).filter((x) => x.name === '5 L BiB')
    expect(defs).toHaveLength(1)
    expect(defs[0].members.map((m) => m.name)).toEqual(['ABC 5 L', 'TCW 5 L'])
  })

  it('a create merging into an existing pack keeps its packing materials', () => {
    const { d, setState } = deps([])
    d.state.items.push({ ...BULK, id: 'SF-MANGO', name: 'Mango Blend (bulk)' })
    d.state.packs[0].bom = [{ item: 'PM-1', qty: 1 }]
    const { result } = renderHook(() => useCatalog(d))
    expect(
      result.current.savePack(null, packInput({
        bom: [{ item: 'PM-9', qty: 3 }],
        recipes: [{ bulkItem: 'SF-MANGO', name: 'Mango 250 ml', shelfLifeDays: 90 }],
      })),
    ).toBe(POSTED)
    const draft = applied(d, setState)
    expect(draft.packs).toHaveLength(1)
    expect(draft.packs[0].bom).toEqual([{ item: 'PM-1', qty: 1 }])
    const mango = draft.products.find((p) => p.name === 'Mango 250 ml')
    expect(mango).toMatchObject({ packId: draft.packs[0].id, bom: [{ item: 'PM-1', qty: 1 }] })
    // the members already in the pack stay in it
    expect(draft.products.filter((p) => p.packId === draft.packs[0].id)).toHaveLength(3)
  })

  it('a create merging into an existing pack refuses a bulk that pack already fills', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    expect(
      result.current.savePack(null, packInput({
        recipes: [{ bulkItem: 'SF-ABC', name: 'ABC again', shelfLifeDays: 90 }],
      })),
    ).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0][0]).toMatch(/assigned to this pack twice/)
  })

  it('refuses an edit that lands on another pack’s name, type and size', () => {
    const { d, setState, showToast } = deps([])
    d.state = migrateState({
      ...d.state,
      products: [
        ...d.state.products,
        { ...PACK_1, id: 'FG-3', name: 'TCW 300 ml', size: 300, packVolume: 0.3, packName: '300 ml BiB', packId: undefined },
      ],
    })
    const otherId = d.state.products.find((p) => p.id === 'FG-3')!.packId!
    const { result } = renderHook(() => useCatalog(d))
    expect(
      result.current.savePack(otherId, packInput({
        recipes: [{ skuId: 'FG-3', name: 'TCW 300 ml', shelfLifeDays: 90 }],
      })),
    ).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0][0]).toMatch(/^250 ml BiB already exists with this type and size/)
  })

  it('a renamed pack keeps its id, and a new pack under the old name does not overwrite it', () => {
    const { d, setState } = deps([])
    d.state.packs[0].name = '250 ml Pouch'
    for (const p of d.state.products) p.packName = '250 ml Pouch'
    const renamedId = d.state.packs[0].id
    const { result } = renderHook(() => useCatalog(d))
    expect(
      result.current.savePack(null, packInput({
        recipes: [{ bulkItem: 'SF-TCW-WATER', name: 'TCW 250 ml BiB', shelfLifeDays: 90 }],
      })),
    ).toBe(POSTED)
    const draft = applied(d, setState)
    expect(new Set(draft.packs.map((p) => p.id)).size).toBe(2)
    expect(draft.packs.find((p) => p.id === renamedId)?.name).toBe('250 ml Pouch')
    expect(draft.products.filter((p) => p.packId === renamedId).map((p) => p.id)).toEqual(['FG-1', 'FG-2'])
    const fresh = draft.products.find((p) => p.name === 'TCW 250 ml BiB')!
    expect(fresh.packId).not.toBe(renamedId)
    expect(draft.packs.find((p) => p.id === fresh.packId)?.name).toBe('250 ml BiB')
  })

  it('propagates edited physicals onto every member, and renames their items', () => {
    const { d, setState } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    expect(
      result.current.savePack(PACK_KEY, packInput({ name: '300 ml BiB', size: 300, type: 'Glass Bottle' })),
    ).toBeTruthy()
    const draft = applied(d, setState)
    for (const p of draft.products) {
      expect(p.packName).toBe('300 ml BiB')
      expect(p.type).toBe('Glass Bottle')
      expect(p.size).toBe(300)
      expect(p.packVolume).toBeCloseTo(0.3, 10)
    }
    expect(draft.items.find((i) => i.id === 'FG-1')?.name).toBe('TCW 250 ml')
  })

  it('refuses a pack-unit change once any recipe has stock history', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.savePack(PACK_KEY, packInput({ unit: 'L', size: 0.25 }))).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      '250 ml BiB has stock history — its pack unit cannot change. Size and the rest may still be edited.',
    )
  })

  it('still lets size move with history — posted runs carry their own perPack', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.savePack(PACK_KEY, packInput({ size: 300 }))).toBeTruthy()
    const draft = applied(d, setState)
    expect(draft.products.every((p) => p.size === 300 && p.packVolume === 0.3)).toBe(true)
    expect(showToast).toHaveBeenCalledWith('250 ml BiB saved.')
  })

  it('allows the unit to move while there is no history to re-dimension', () => {
    const { d, setState } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.savePack(PACK_KEY, packInput({ unit: 'L', size: 0.25 }))).toBeTruthy()
    const draft = applied(d, setState)
    expect(draft.products.every((p) => p.unit === 'L' && p.packVolume === 0.25)).toBe(true)
  })

  it('refuses unassigning a recipe that has already been packed', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    const withoutTcw = packInput({ recipes: [packInput().recipes[1]] })
    expect(result.current.savePack(PACK_KEY, withoutTcw)).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'TCW 250 ml has already been packed — it has stock history and cannot be removed from the pack. Retire the pack instead if it is no longer filled.',
    )
  })

  it('deletes an unassigned recipe SKU and its item when nothing is behind it', () => {
    const { d, setState } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    const withoutAbc = packInput({ recipes: [packInput().recipes[0]] })
    expect(result.current.savePack(PACK_KEY, withoutAbc)).toBeTruthy()
    const draft = applied(d, setState)
    expect(draft.products.some((p) => p.id === 'FG-2')).toBe(false)
    expect(draft.items.some((i) => i.id === 'FG-2')).toBe(false)
    expect(draft.products.some((p) => p.id === 'FG-1')).toBe(true)
  })

  it('refuses a pack with no recipes — an empty pack cannot exist', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.savePack(PACK_KEY, packInput({ recipes: [] }))).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'A pack exists to be filled — assign at least one recipe. To drop the pack entirely, delete it from its card.',
    )
  })

  it('refuses the same bulk twice — each recipe is its own bulk', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    const twice = {
      ...packInput(),
      recipes: [
        { skuId: 'FG-1', name: 'TCW 250 ml', shelfLifeDays: 90 },
        { bulkItem: 'SF-TCW-WATER', name: 'TCW 250 ml special', shelfLifeDays: 90 },
      ] as PackDefInput['recipes'],
    }
    expect(result.current.savePack(PACK_KEY, twice)).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Coconut Water (bulk) is assigned to this pack twice — each recipe is its own bulk.',
    )
  })

  it('refuses a recipe named like a product that already exists', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    const clash = packInput({
      recipes: [
        { skuId: 'FG-1', name: 'TCW 250 ml', shelfLifeDays: 90 },
        { skuId: 'FG-2', name: 'TCW 250 ml', shelfLifeDays: 90 },
      ],
    })
    expect(result.current.savePack(PACK_KEY, clash)).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('TCW 250 ml already exists.')
  })

  it('refuses a recipe whose bulk is measured in the other dimension', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    expect(result.current.savePack(PACK_KEY, packInput({ unit: 'kg' }))).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Coconut Water (bulk) is held in litre, so a pack sized in kg cannot be filled from it.',
    )
  })
})

describe('retirePack', () => {
  it('marks every member retired, and a restore clears the flag off the key', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    result.current.retirePack(PACK_KEY, true)
    let draft = applied(d, setState)
    expect(draft.products.every((p) => p.retired === true)).toBe(true)
    // The roll-up: a def whose every member is retired is a retired def.
    expect(packDefs(draft.products).find((x) => x.key === PACK_KEY)?.retired).toBe(true)

    result.current.retirePack(PACK_KEY, false)
    draft = appliedAll(d, setState)
    expect(draft.products.every((p) => p.retired === undefined)).toBe(true)
    expect(showToast).toHaveBeenCalledWith('250 ml BiB is back on the line.')
  })
})

describe('deletePack', () => {
  it('refuses while any recipe has stock history, naming the blocker', () => {
    const { d, setState, showToast } = deps([HISTORY])
    const { result } = renderHook(() => useCatalog(d))
    result.current.deletePack(PACK_KEY)
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'TCW 250 ml has already been packed — it has stock history, so the pack cannot be deleted. Retire it instead.',
    )
  })

  it('removes every member SKU and its item when nothing is behind them', () => {
    const { d, setState, showToast } = deps([])
    const { result } = renderHook(() => useCatalog(d))
    result.current.deletePack(PACK_KEY)
    const draft = applied(d, setState)
    expect(draft.products).toHaveLength(0)
    expect(draft.items.some((i) => i.id === 'FG-1' || i.id === 'FG-2')).toBe(false)
    expect(showToast).toHaveBeenCalledWith('250 ml BiB deleted.')
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
