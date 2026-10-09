/**
 * The pack catalog. On D1 a pack is a stored master and each SKU points at it by
 * packId; rows from Zoho or the first import carry only the product projection, so
 * materializePacks derives their master deterministically. packDefs is the view
 * the catalog page and the run form lean on.
 */
import { describe, expect, it } from 'vitest'
import { formatSize, materializePacks, packDefs, packKeyOfDef, packLabel } from './packs'
import { migrateState } from './migrate'
import type { AppState, Product } from '../types'

const member = (over: Partial<Product>): Product => ({
  id: 'FG-1',
  name: 'TCW 250 ml',
  type: 'BiB',
  size: 250,
  unit: 'ml',
  packVolume: 0.25,
  shelfLifeDays: 90,
  bom: [],
  bulkItem: 'SF-TCW-WATER',
  medium: 'Water',
  ...over,
})

/** migrateState is the honest path in — it fills anything a pack SKU carries today. */
const stateOf = (products: Product[]): AppState => migrateState({ products })

describe('packLabel', () => {
  it('prefers the pack name the pack was saved with', () => {
    expect(packLabel(member({ packName: '4 × 120 ml bottle' }))).toBe('4 × 120 ml bottle')
  })

  it('falls back to size-and-type for SKUs saved before packs had names', () => {
    expect(packLabel(member({}))).toBe(`${formatSize(250, 'ml')} BiB`)
  })
})

describe('packDefs', () => {
  it('backfills one stable D1 master and SKU pointers from legacy product rows', () => {
    const products = [
      member({ id: 'FG-1', packName: '250 ml BiB' }),
      member({ id: 'FG-2', name: 'ABC 250 ml', bulkItem: 'SF-ABC', packName: '250 ml BiB' }),
    ]
    const materialized = materializePacks(products, [])
    expect(materialized.packs).toHaveLength(1)
    expect(materialized.products.map((p) => p.packId)).toEqual([
      materialized.packs[0].id,
      materialized.packs[0].id,
    ])
  })

  it('uses the stored D1 master as the format source, not a SKU projection', () => {
    const state = stateOf([member({ packName: 'legacy 250 ml BiB' })])
    const master = { ...state.packs[0], name: 'D1 300 ml bottle', type: 'Glass Bottle', size: 300, packVolume: 0.3 }
    const def = packDefs(state.products, [master])[0]
    expect(def).toMatchObject({ key: master.id, name: 'D1 300 ml bottle', type: 'Glass Bottle', size: 300 })
  })

  it('re-projects a drifted member onto its stored master, so packing draws the right materials', () => {
    // FG-0016 on the preview: grouped under the 120 ml bottle, still carrying a
    // BiB pouch in its own bom — packing reads p.bom and would have spent pouches.
    const master = {
      id: 'PACK:bottle',
      name: '120 ml Glass Bottle',
      type: 'Glass Bottle',
      size: 120,
      unit: 'ml' as const,
      packVolume: 0.12,
      bom: [{ item: 'PM-BOTTLE-120', qty: 1 }],
    }
    const drifted = member({ id: 'FG-2', packId: master.id, bom: [{ item: 'PM-BIB-2.5', qty: 1 }] })
    const converged = member({
      id: 'FG-3',
      packId: master.id,
      packName: master.name,
      type: master.type,
      size: 120,
      packVolume: 0.12,
      bom: [{ item: 'PM-BOTTLE-120', qty: 1 }],
    })
    const { products } = materializePacks([drifted, converged], [master])
    expect(products[0]).toMatchObject({
      packName: '120 ml Glass Bottle',
      type: 'Glass Bottle',
      size: 120,
      packVolume: 0.12,
      bom: [{ item: 'PM-BOTTLE-120', qty: 1 }],
    })
    expect(products[1]).toBe(converged)
  })

  it('groups by name, type, size and unit — one pack, many recipes', () => {
    const state = stateOf([
      member({ id: 'FG-1', name: 'TCW 250 ml', packName: '250 ml BiB' }),
      member({ id: 'FG-2', name: 'ABC 250 ml', bulkItem: 'SF-ABC', packName: '250 ml BiB' }),
    ])
    const defs = packDefs(state.products)
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('250 ml BiB')
    expect(defs[0].members.map((m) => m.name)).toEqual(['ABC 250 ml', 'TCW 250 ml'])
  })

  it('splits on every part of the key — a same-named pack of another size stands apart', () => {
    const state = stateOf([
      member({ id: 'FG-1', packName: 'Coco pack', size: 250, packVolume: 0.25 }),
      member({ id: 'FG-2', packName: 'Coco pack', size: 500, packVolume: 0.5 }),
    ])
    const defs = packDefs(state.products)
    expect(defs).toHaveLength(2)
    expect(defs.map((d) => d.size)).toEqual([250, 500])
  })

  it('takes the BOM from the first member — propagation keeps them identical', () => {
    const bom = [{ item: 'PM-1', qty: 1 }, { item: 'PM-2', qty: 4 }]
    const state = stateOf([
      member({ id: 'FG-1', packName: '250 ml BiB', bom }),
      member({ id: 'FG-2', packName: '250 ml BiB', bom }),
    ])
    expect(packDefs(state.products)[0].bom).toEqual(bom)
  })

  it('rolls retirement up: a def is retired when every member is', () => {
    const state = stateOf([
      member({ id: 'FG-1', packName: '250 ml BiB', retired: true }),
      member({ id: 'FG-2', packName: '250 ml BiB', retired: true }),
      member({ id: 'FG-3', name: 'Malai 3 kg', packName: '3 kg cover', retired: false }),
    ])
    const byName = Object.fromEntries(packDefs(state.products).map((d) => [d.name, d.retired]))
    expect(byName['250 ml BiB']).toBe(true)
    expect(byName['3 kg cover']).toBe(false)
  })
})

describe('packKeyOfDef', () => {
  it('is the exact grouping key — same parts, same pack', () => {
    expect(packKeyOfDef('5 L BiB', 'BiB', 5, 'L')).toBe(packKeyOfDef('5 L BiB', 'BiB', 5, 'L'))
    expect(packKeyOfDef('5 L BiB', 'BiB', 5, 'L')).not.toBe(packKeyOfDef('5 L BiB', 'Glass Bottle', 5, 'L'))
  })
})
