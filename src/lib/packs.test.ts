/**
 * The derived pack catalog. A pack is never stored: SKUs that share a pack name,
 * type, size and unit ARE the pack, and packDefs is the view that groups them.
 * These tests pin the grouping contract the catalog page and the run form lean on.
 */
import { describe, expect, it } from 'vitest'
import { formatSize, packDefs, packKeyOfDef, packLabel } from './packs'
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
