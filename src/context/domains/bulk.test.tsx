// @vitest-environment happy-dom
/**
 * The blend recipe gates that keep what the screen showed and what got stored the
 * same shape. A half-filled component row (a bulk with no share, a share with no
 * bulk) used to be filtered out silently on save — the recipe then stored fewer
 * components than the dialog listed, which reads from the floor as "components
 * not saved". The gate refuses it with a reason now; these pins hold that, the
 * complete-recipe happy path, and the edit whose target left this device's copy.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBulkProducts } from './bulk'
import { POSTED, type CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import { deepClone } from '../../lib/utils'
import type { AppState, Item } from '../../types'

const sf = (id: string, name: string): Item => ({
  id,
  name,
  type: 'Semi Finished',
  uom: 'Kg',
  lotControlled: true,
  reorder: 0,
  costMethod: 'Batch Actual',
})

function plant(): AppState {
  return migrateState({ items: [sf('SF-APPLE', 'Apple Juice'), sf('SF-BEET', 'Beet Juice'), sf('SF-CARROT', 'Carrot Juice')] })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps() {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const d: CoreDeps = {
    state: plant(),
    setState,
    nextId: vi.fn(() => 'MEL-0001'),
    nextLot: vi.fn(() => 'LOT-0001'),
    log,
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'blend@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast, log }
}

afterEach(cleanup)

describe('blend recipes', () => {
  it('refuses a half-filled component row with a reason instead of quietly storing fewer components', () => {
    const { d, setState, showToast } = deps()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.addMelange({
      name: 'ABC Juice',
      uom: 'Kg',
      description: '',
      // the third row names a bulk but carries no share — the quiet-drop shape
      components: [
        { item: 'SF-APPLE', share: 60 },
        { item: 'SF-BEET', share: 40 },
        { item: 'SF-CARROT', share: 0 },
      ],
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled() // nothing was stored
    expect(showToast).toHaveBeenCalledWith(
      'Every component needs an item and a share — complete or remove the half-filled rows.',
    )
  })

  it('lands a complete recipe with every component stored beside its bulk item', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.addMelange({
      name: 'ABC Juice',
      uom: 'Kg',
      description: '',
      components: [
        { item: 'SF-APPLE', share: 50 },
        { item: 'SF-BEET', share: 30 },
        { item: 'SF-CARROT', share: 20 },
      ],
    })
    expect(out).toBe(POSTED)
    expect(setState).toHaveBeenCalledTimes(1)
    const updater = setState.mock.calls[0][0] as (prev: AppState) => AppState
    const draft = updater(deepClone(d.state))
    expect(draft.melanges).toHaveLength(1)
    expect(draft.melanges[0].components).toEqual([
      { item: 'SF-APPLE', share: 50 },
      { item: 'SF-BEET', share: 30 },
      { item: 'SF-CARROT', share: 20 },
    ])
    // the recipe owns the semi-finished bulk it is booked as
    expect(draft.items.find((i) => i.id === 'SF-MEL-0001')).toMatchObject({
      name: 'ABC Juice (bulk)',
      type: 'Semi Finished',
    })
  })

  it('says so when the edit target left this device’s copy instead of closing silently', () => {
    const { d, setState, showToast } = deps()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.updateMelange('MEL-9999', {
      name: 'ABC Juice',
      uom: 'Kg',
      description: '',
      components: [
        { item: 'SF-APPLE', share: 60 },
        { item: 'SF-BEET', share: 40 },
      ],
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'That blend is no longer in this device’s copy — reload the page and edit it again.',
    )
  })
})

describe('bulk edits', () => {
  /** The preview's catalog: the bulk and the finished good share a name, and the
   *  vanilla bulk predates sources and was pressed from a material now used as bought. */
  function twins() {
    const { d, setState, showToast } = deps()
    d.state = migrateState({
      items: [
        { ...sf('SF-0009', 'Cold Brew Coffee'), uom: 'Litre', sourceItem: 'RM-COFFEE' },
        { ...sf('FG-0009', 'Cold Brew Coffee'), type: 'Finished Goods', uom: 'Pack' },
        { ...sf('RM-COFFEE', 'Arabica Coffee'), type: 'Raw Material' },
        { ...sf('SF-0008', 'Vanilla Bean Extract'), uom: 'Litre' },
        { ...sf('RM-VAN', 'Vanilla Extract'), type: 'Raw Material', uom: 'Litre', directUse: true },
      ],
      ledger: [
        { id: 'L1', type: 'Production Output', doc: 'B1', item: 'SF-0008', itemType: 'Semi Finished', lot: 'B1', location: 'S', status: 'Quarantine', qtyIn: 1, qtyOut: 0, uom: 'Litre', unitCost: 1, time: '2026-10-08T00:00:00.000Z' },
      ],
    })
    return { d, setState, showToast }
  }

  it('saves a bulk whose name a finished good already carries, as long as the name is not being changed', () => {
    const { d, setState, showToast } = twins()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.updateBulkProduct('SF-0009', {
      name: 'Cold Brew Coffee',
      uom: 'Litre',
      byProduct: false,
      sourceItem: 'RM-COFFEE',
      qcExempt: true,
    })
    expect(out).toBe('SF-0009')
    expect(setState).toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalledWith('Cold Brew Coffee already exists.')
  })

  it('still refuses renaming a bulk onto another item’s name', () => {
    const { d, showToast } = twins()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.updateBulkProduct('SF-0008', {
      name: 'cold brew coffee',
      uom: 'Litre',
      byProduct: false,
      sourceItem: '',
      qcExempt: false,
    })
    expect(out).toBeNull()
    expect(showToast).toHaveBeenCalledWith('cold brew coffee already exists.')
  })

  it('lets a bulk with history and no source be edited without inventing one', () => {
    const { d, setState } = twins()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.updateBulkProduct('SF-0008', {
      name: 'Vanilla Bean Extract',
      uom: 'Litre',
      byProduct: false,
      sourceItem: '',
      qcExempt: true,
    })
    expect(out).toBe('SF-0008')
    expect(setState).toHaveBeenCalled()
  })
})
