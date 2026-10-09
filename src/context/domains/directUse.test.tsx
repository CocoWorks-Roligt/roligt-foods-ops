// @vitest-environment happy-dom
/**
 * Raw materials bought ready to use, and bulks that skip QC.
 *
 * A flavour or an essence arrives finished: it is never pressed, so it has no bulk
 * and goes into blends straight off its receipt. A bulk is extracted from exactly one
 * raw material the plant does press, and says whether its lots wait on QC. These pins
 * hold the engine to that: what a batch may draw and book, where a QC-exempt lot
 * lands (released, with no record raised, and its packs dispatchable), that a blend's
 * own output is always tested, that a flavour lot is traced from its receipt into the
 * blend, and the guards on flipping either switch once history depends on it.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBulkProducts } from './bulk'
import { useCatalog } from './catalog'
import { useProduction } from './production'
import type { CoreDeps } from './deps'
import { linkedRecords } from '../../lib/links'
import { migrateState } from '../../lib/migrate'
import { checkBatch, postPackingLines, type BatchInput } from '../../lib/posting'
import { itemFlows } from '../../lib/reports/inventoryReports'
import { traceChain } from '../../lib/trace'
import { deepClone, localDay } from '../../lib/utils'
import type { AppState, Grn, Item, LedgerEntry, Product, PurchaseProduct, StorageLocation } from '../../types'

const COLD: StorageLocation = {
  id: 'SL-1', name: 'cold-a', label: 'Cold Room A', holds: 'Bulk', type: 'Cold Room', status: 'Active',
}

const item = (id: string, name: string, type: Item['type'], uom: string, extra: Partial<Item> = {}): Item => ({
  id, name, type, uom, lotControlled: true, reorder: 0, costMethod: 'Lot Actual', ...extra,
})

const COCO = item('RM-TCW-COCO', 'Tender Coconut', 'Raw Material', 'Piece')
const VANILLA = item('RM-VAN', 'Vanilla Essence', 'Raw Material', 'Litre', { directUse: true })
const BEET = item('RM-BEET', 'Beetroot', 'Raw Material', 'Kg')
const WATER = item('SF-TCW-WATER', 'Coconut Water (bulk)', 'Semi Finished', 'Litre')
// Malai names no source — it answers for itself as coming off coconut — and skips QC.
const MALAI = item('SF-TCW-MALAI', 'Malai (bulk)', 'Semi Finished', 'Kg', {
  costMethod: 'By-product', qcExempt: true,
})
const BEET_JUICE = item('SF-BEET', 'Beet Juice (bulk)', 'Semi Finished', 'Litre', { sourceItem: 'RM-BEET' })
// A blend's own bulk — set to skip QC to prove a blend output is tested regardless.
const BLEND = item('SF-MEL-0001', 'Vanilla Water (bulk)', 'Semi Finished', 'Litre', { qcExempt: true })
const MALAI_PACK = item('FG-M', 'Malai 3 kg', 'Finished Goods', 'Kg')

const receipt = (id: string, lot: string, it: Item, qty: number): LedgerEntry => ({
  id, type: 'Receipt', doc: `GRN-${lot}`, item: it.id, itemType: 'Raw Material', lot,
  location: 'rm-store', status: 'Available', qtyIn: qty, qtyOut: 0, uom: it.uom, unitCost: 10,
  time: '2026-09-24T08:00:00Z',
})
/** Water from an earlier pressing, already released — the bulk half of the blend. */
const WATER_LOT: LedgerEntry = {
  id: 'LED-W', type: 'Production Output', doc: 'B-0001', item: WATER.id, itemType: 'Semi Finished',
  lot: 'B-0001', location: 'cold-a', status: 'Released', qtyIn: 200, qtyOut: 0, uom: 'Litre',
  unitCost: 20, time: '2026-09-20T08:00:00Z',
}
const VANILLA_GRN = {
  id: 'GRN-0009', date: '2026-09-24', farmerId: 'V-1', farmerName: 'Essence Co', lot: 'LOT-V',
} as Grn

function plant(): AppState {
  return migrateState({
    storageLocations: [COLD],
    items: [COCO, VANILLA, BEET, WATER, MALAI, BEET_JUICE, BLEND, MALAI_PACK],
    products: [
      {
        id: 'FG-M', name: 'Malai 3 kg', type: 'Cover', size: 3, unit: 'kg', packVolume: 3,
        shelfLifeDays: 5, bom: [], bulkItem: MALAI.id, medium: 'Malai', packName: '3 kg cover',
      } as Product,
    ],
    grns: [VANILLA_GRN],
    ledger: [
      receipt('LED-C', 'LOT-C', COCO, 600),
      receipt('LED-V', 'LOT-V', VANILLA, 10),
      receipt('LED-B', 'LOT-B', BEET, 50),
      WATER_LOT,
    ],
  })
}

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(state: AppState = plant()) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const log = vi.fn()
  const seq: Record<string, number> = {}
  const d: CoreDeps = {
    state,
    setState,
    nextId: vi.fn((_draft: AppState, kind: string) => {
      seq[kind] = (seq[kind] || 0) + 1
      return kind === 'qc' ? `QC-000${seq[kind]}` : `BAT-000${seq[kind]}`
    }),
    nextLot: vi.fn(() => 'LOT-0001'),
    log,
    showToast,
    announcement: { current: null },
    forbidden: () => false,
    rows: [],
    actor: 'prod@roligt.local',
    vendorTypeName: () => 'Vendor',
  }
  return { d, setState, showToast, log }
}

/** Applies the updater the hook posted, against a copy of the state it read. */
const applied = (d: CoreDeps, setState: ReturnType<typeof vi.fn>, call = 0): AppState =>
  (setState.mock.calls[call][0] as (prev: AppState) => AppState)(deepClone(d.state))

const pressing = (outputs: BatchInput['outputs']): BatchInput => ({
  date: '2026-09-25',
  kind: 'Extraction',
  spoiled: 0,
  sourceLines: [{ item: COCO.id, lot: 'LOT-C', qty: 600 }],
  blendLines: [],
  outputs,
  location: 'cold-a',
})

const blending: BatchInput = {
  date: '2026-09-26',
  kind: 'Melange',
  spoiled: 0,
  sourceLines: [],
  blendLines: [
    { item: WATER.id, lot: 'B-0001', qty: 95 },
    { item: VANILLA.id, lot: 'LOT-V', qty: 5 },
  ],
  outputs: [{ item: BLEND.id, qty: 100, main: true }],
  location: 'cold-a',
}

afterEach(cleanup)

describe('a bulk that skips QC', () => {
  it('lands released with no QC record, and the batch reads Released', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(pressing([{ item: MALAI.id, qty: 40, main: true }]))
    const draft = applied(d, setState)
    const batch = draft.batches.find((b) => b.kind === 'Extraction')!
    expect(batch.outputLines?.[0]).toMatchObject({ item: MALAI.id, qcExempt: true })
    expect(draft.qcs).toHaveLength(0)
    expect(batch.status).toBe('Released')
    const out = draft.ledger.find((l) => l.doc === batch.id && l.type === 'Production Output')!
    expect(out.status).toBe('Released')
  })

  it('tests only the outputs that need it when a pressing makes both kinds', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(
      pressing([
        { item: WATER.id, qty: 180, main: true },
        { item: MALAI.id, qty: 40, main: false },
      ]),
    )
    const draft = applied(d, setState)
    const batch = draft.batches.find((b) => b.kind === 'Extraction')!
    expect(draft.qcs.map((q) => q.item)).toEqual([WATER.id])
    expect(batch.status).not.toBe('Released')
    const status = (it: string) =>
      draft.ledger.find((l) => l.doc === batch.id && l.item === it && l.type === 'Production Output')!.status
    expect(status(WATER.id)).toBe('Quarantine')
    expect(status(MALAI.id)).toBe('Released')
  })

  it('fills packs that are released at once, so they can be dispatched', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(pressing([{ item: MALAI.id, qty: 40, main: true }]))
    const draft = applied(d, setState)
    const batch = draft.batches.find((b) => b.kind === 'Extraction')!
    postPackingLines(
      draft,
      'PR-0009',
      { date: '2026-09-26', batchId: batch.id, bulkItem: MALAI.id, lines: [{ sku: 'FG-M', packs: 2 }] },
      { drawn: 6, pmNeeds: {}, bulkItem: MALAI.id, uom: 'Kg' },
    )
    const packs = draft.ledger.find((l) => l.doc === 'PR-0009' && l.type === 'Packing Output')!
    expect(packs.status).toBe('Released')
  })

  it('keeps the decision a lot was booked under when the switch later moves', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(pressing([{ item: MALAI.id, qty: 40, main: true }]))
    const draft = applied(d, setState)
    // The bulk now goes through QC — the lot already booked stays released.
    delete draft.items.find((i) => i.id === MALAI.id)!.qcExempt
    const batch = draft.batches.find((b) => b.kind === 'Extraction')!
    expect(batch.outputLines?.[0].qcExempt).toBe(true)
  })
})

describe('a raw material used as bought', () => {
  it('goes into a blend straight off its receipt, and the blend output is still tested', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(blending)
    const draft = applied(d, setState)
    const run = draft.batches.find((b) => b.kind === 'Melange')!
    expect(run.blendLines?.map((l) => l.lot)).toEqual(['B-0001', 'LOT-V'])
    const drawn = draft.ledger.find((l) => l.doc === run.id && l.item === VANILLA.id)!
    expect(drawn).toMatchObject({ type: 'Melange Consume', lot: 'LOT-V', qtyOut: 5 })
    // A blend's own output never skips QC, whatever its item says.
    expect(run.outputLines?.[0].qcExempt).toBeUndefined()
    expect(draft.qcs.map((q) => q.item)).toEqual([BLEND.id])
  })

  it('is traced from its receipt into the blend, and back', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(blending)
    const draft = applied(d, setState)
    const run = draft.batches.find((b) => b.kind === 'Melange')!
    expect(traceChain(draft, 'LOT-V')!.batches).toContain(run.id)
    expect(traceChain(draft, run.id)!.lots).toContain('LOT-V')
    expect(linkedRecords(draft, 'GRN-0009').wentInto.map((r) => r.id)).toContain(run.id)
  })

  it('counts the blend draw as an issue on the raw material flow report', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useProduction(d))
    result.current.createBatch(blending)
    const draft = applied(d, setState)
    const day = localDay(draft.ledger.find((l) => l.type === 'Melange Consume')!.time)
    const van = itemFlows(draft, { from: day, to: day }, ['Raw Material']).find((r) => r.item === VANILLA.id)!
    expect(van.issued).toBe(5)
  })
})

describe('what a batch may draw and book', () => {
  const state = plant()

  it('refuses to press a raw material used as bought', () => {
    expect(
      checkBatch(state, {
        ...pressing([{ item: BEET_JUICE.id, qty: 5, main: true }]),
        sourceLines: [{ item: VANILLA.id, lot: 'LOT-V', qty: 5 }],
      }),
    ).toBe('Vanilla Essence goes into blends as bought — it is not extracted. Blend it on the Blend tab.')
  })

  it('refuses to blend a raw material that needs extraction', () => {
    expect(
      checkBatch(state, {
        ...blending,
        blendLines: [
          { item: WATER.id, lot: 'B-0001', qty: 95 },
          { item: BEET.id, lot: 'LOT-B', qty: 5 },
        ],
      }),
    ).toBe('Beetroot is extracted before it is blended — draw the bulk pressed from it instead.')
  })

  it('refuses an output extracted from a raw material the batch did not issue', () => {
    expect(checkBatch(state, pressing([{ item: BEET_JUICE.id, qty: 5, main: true }]))).toBe(
      'Beet Juice (bulk) is extracted from Beetroot, and this batch issues none.',
    )
  })
})

describe('the switches', () => {
  const pp = (id: string, it: Item): PurchaseProduct => ({
    id, name: it.name, category: 'Farm Produce', uom: it.uom, description: '', vendorIds: ['V-1'],
    itemId: it.id, status: 'Active',
  })
  const withMasters = () => {
    const s = plant()
    s.purchaseProducts = [pp('PP-1', BEET), pp('PP-2', VANILLA)]
    return s
  }

  it('refuses a bulk off a raw material used as bought', () => {
    const { d, setState, showToast } = deps()
    const { result } = renderHook(() => useBulkProducts(d))
    const out = result.current.addBulkProduct({
      name: 'Vanilla Pulp', uom: 'Litre', byProduct: false, sourceItem: VANILLA.id, qcExempt: false,
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0][0]).toContain('goes into blends as bought')
  })

  it('stores the source and the QC choice on a new bulk', () => {
    const { d, setState } = deps()
    const { result } = renderHook(() => useBulkProducts(d))
    result.current.addBulkProduct({
      name: 'Beet Pomace', uom: 'Kg', byProduct: true, sourceItem: BEET.id, qcExempt: true,
    })
    const added = applied(d, setState).items.find((i) => i.name === 'Beet Pomace')!
    expect(added).toMatchObject({ sourceItem: BEET.id, qcExempt: true })
  })

  it('accepts a flavour as a blend component, refuses a raw material that needs extraction', () => {
    const { d, showToast } = deps()
    const { result } = renderHook(() => useBulkProducts(d))
    const recipe = (second: string) => ({
      name: 'Vanilla Water', uom: 'Litre', description: '',
      components: [{ item: WATER.id, share: 95 }, { item: second, share: 5 }],
    })
    expect(result.current.addMelange(recipe(VANILLA.id))).not.toBeNull()
    expect(result.current.addMelange({ ...recipe(BEET.id), name: 'Beet Water' })).toBeNull()
    expect(showToast).toHaveBeenLastCalledWith(
      'Beetroot is extracted before it is blended — use the bulk pressed from it.',
    )
  })

  it('will not turn extraction off while a bulk is extracted from the raw material', () => {
    const { d, setState, showToast } = deps(withMasters())
    const { result } = renderHook(() => useCatalog(d))
    const out = result.current.updatePurchaseProduct('PP-1', {
      name: BEET.name, uom: 'Kg', description: '', directUse: true,
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0][0]).toContain('Beet Juice (bulk) is extracted from Beetroot')
  })

  it('will not turn extraction back on while a recipe blends the raw material as bought', () => {
    const s = withMasters()
    s.melanges = [
      {
        id: 'MEL-0001', name: 'Vanilla Water', uom: 'Litre', description: '', status: 'Active',
        outputItem: BLEND.id,
        components: [{ item: WATER.id, share: 95 }, { item: VANILLA.id, share: 5 }],
      },
    ]
    const { d, setState, showToast } = deps(s)
    const { result } = renderHook(() => useCatalog(d))
    const out = result.current.updatePurchaseProduct('PP-2', {
      name: VANILLA.name, uom: 'Litre', description: '', directUse: false,
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Vanilla Water blends Vanilla Essence as bought — take it out of that recipe first.',
    )
  })

  it('measures a raw material used as bought in Litre or Kg', () => {
    const { d, setState, showToast } = deps(withMasters())
    const { result } = renderHook(() => useCatalog(d))
    const out = result.current.addPurchaseProduct({
      name: 'Rose Essence', category: 'Other', uom: 'Piece', description: '', vendorIds: ['V-1'],
      directUse: true,
    })
    expect(out).toBeNull()
    expect(setState).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0][0]).toContain('measured in Litre or Kg')
  })
})
