import { describe, expect, it } from 'vitest'
import { migrateState } from './migrate'
import { defaultTemplates } from './stickers'
import type { AppState, Item } from '../types'

const ITEM: Item = {
  id: 'SF-TEST',
  name: 'Test bulk',
  type: 'Semi Finished',
  uom: 'Litre',
  lotControlled: true,
  reorder: 0,
  costMethod: 'Batch Actual',
}

/**
 * The no-seeding contract. The app used to carry a demo plant (items, packs,
 * rooms, staff, shifts, plans) inside the code and fold it into every state it
 * read back, so an empty database filled itself with masters nobody entered and
 * a wiped plant quietly refilled on the next load. Nothing is seeded now: what
 * these tests pin is that a state with nothing in it migrates to nothing but
 * defaults, and that a state's own masters are the only masters it has.
 */
describe('migrateState never seeds', () => {
  it('an empty state migrates to empty collections — no demo plant appears', () => {
    const s = migrateState({})
    expect(s.items).toEqual([])
    expect(s.products).toEqual([])
    expect(s.storageLocations).toEqual([])
    expect(s.vendors).toEqual([])
    expect(s.customers).toEqual([])
    expect(s.purchaseProducts).toEqual([])
    expect(s.grns).toEqual([])
    expect(s.batches).toEqual([])
    expect(s.ledger).toEqual([])
    expect(s.audits).toEqual([])
    expect(s.staff).toEqual([])
    expect(s.shifts).toEqual([])
    expect(s.productionPlans).toEqual([])
    expect(s.orders).toEqual([])
  })

  it('a saved state keeps exactly its own masters — nothing is folded in', () => {
    const s = migrateState({ items: [ITEM] })
    expect(s.items).toEqual([ITEM])
  })

  it('defaults are settings, not rows: config merges, sticker templates are code', () => {
    const s = migrateState({})
    // the plant's operational defaults exist without any Config rows
    expect(s.config.yieldTolerance).toBe(12)
    expect(s.config.reportCustomerName).toBe('Roligt Foods Private Limited')
    // a setting the plant did save is theirs; one it did not gets the default
    const edited = migrateState({ config: { yieldTolerance: 20 } as Partial<AppState['config']> })
    expect(edited.config.yieldTolerance).toBe(20)
    expect(edited.config.reportCustomerName).toBe('Roligt Foods Private Limited')
    // label templates are reconciled from code, so an empty state still has them
    expect(s.stickerTemplates).toEqual(defaultTemplates())
  })
})
