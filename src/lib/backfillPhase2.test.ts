import { describe, expect, it } from 'vitest'
import {
  APP_CONFIG_ADDITIONS,
  BIB_SIZES,
  PO_COUNTER_SEED,
  backfillBatch,
  backfillCustomer,
  backfillDefaults,
  backfillItem,
  backfillMelange,
  backfillProduct,
  backfillStorageLocation,
  cartonSpecSeedRows,
  flagSeedRows,
  mergeAppConfig,
  spoilageReasonSeedRows,
  type BackfillDefaults,
  type BatchDoc,
  type CustomerDoc,
  type MelangeDoc,
  type ProductDoc,
} from './backfillPhase2'
import { FLAG_KEYS, KPI_MODULES, SPOILAGE_REASON_SEEDS } from './contracts'
import type { Item, StorageLocation } from '../types'

/**
 * The Phase-2 backfill's contract with a running plant: every merge is
 * additive (absent keys only), idempotent (a re-run writes nothing) and
 * lossless (existing keys keep their values and their order verbatim), so the
 * script can land while people work. Fixtures are the shapes the scratch dump
 * actually stores — a Tender Coconut pressing item, a Vanilla Extract bought
 * ready to use, an ABC blend recipe, the SKU names off the Products page.
 */
const DEFAULTS: BackfillDefaults = { avgUnitWeightKg: 0.5, densityKgPerL: 1 }

const item = (over: Partial<Item>): Item => ({
  id: 'RM-TEST',
  name: 'Test material',
  type: 'Raw Material',
  uom: 'Kg',
  lotControlled: true,
  reorder: 0,
  costMethod: 'Lot Actual',
  ...over,
})

const COCONUT = item({ id: 'RM-PP-0001', name: 'Tender Coconut ', uom: 'Piece' })
const VANILLA = item({ id: 'RM-PP-0008', name: 'Vanilla Extract', uom: 'Litre', directUse: true })
const CARROT = item({ id: 'RM-PP-0002', name: 'Carrot', uom: 'Kg' })
const VTOP_BIB = item({ id: 'PM-PP-0010', name: '5 L Vtop Bib', type: 'Packing Material', uom: 'Piece' })
const BULK_WATER = item({ id: 'SF-0002', name: 'Tender Coconut Water', type: 'Semi Finished', uom: 'Litre' })

describe('backfillItem — the material-master flags', () => {
  it('the graded intake: Piece raw material is RAW, graded, extracted, ambient, with the configured nut weight', () => {
    const out = backfillItem(COCONUT, DEFAULTS)
    expect(out.procurementForm).toBe('RAW')
    expect(out.requiresGrading).toBe(true)
    expect(out.requiresExtraction).toBe(true)
    expect(out.storageCondition).toBe('ambient')
    expect(out.avgUnitWeight).toBe(0.5)
    // a counted material carries no density guess
    expect(out.densityKgPerL).toBeUndefined()
    // and no min/max appears — reorder keeps its job
    expect(out.minStock).toBeUndefined()
    expect(out.maxStock).toBeUndefined()
  })

  it('directUse wins over type: a raw flavour extract bought ready to blend is DIRECT_USE, never extracted', () => {
    const out = backfillItem(VANILLA, DEFAULTS)
    expect(out.procurementForm).toBe('DIRECT_USE')
    expect(out.requiresGrading).toBe(false)
    expect(out.requiresExtraction).toBe(false)
    expect(out.densityKgPerL).toBe(1)
    // not graded, so no average unit weight
    expect(out.avgUnitWeight).toBeUndefined()
  })

  it('a pressed raw material (Kg) is RAW and extracted, with neither conversion guessed', () => {
    const out = backfillItem(CARROT, DEFAULTS)
    expect(out.procurementForm).toBe('RAW')
    expect(out.requiresExtraction).toBe(true)
    expect(out.requiresGrading).toBe(false)
    expect(out.avgUnitWeight).toBeUndefined()
    expect(out.densityKgPerL).toBeUndefined()
  })

  it('anything the plant does not press or blend ready — packing materials — is READY_EXTRACT', () => {
    const out = backfillItem(VTOP_BIB, DEFAULTS)
    expect(out.procurementForm).toBe('READY_EXTRACT')
    expect(out.requiresExtraction).toBe(false)
    expect(out.storageCondition).toBe('ambient')
  })

  it('storage conditions: bulk and finished goods cold, raw and packing ambient', () => {
    expect(backfillItem(BULK_WATER, DEFAULTS).storageCondition).toBe('cold')
    expect(backfillItem(item({ type: 'Finished Goods' }), DEFAULTS).storageCondition).toBe('cold')
    expect(backfillItem(CARROT, DEFAULTS).storageCondition).toBe('ambient')
  })

  it('a litre-measured bulk gets the density conversion', () => {
    expect(backfillItem(BULK_WATER, DEFAULTS).densityKgPerL).toBe(1)
  })

  it('is idempotent — the second run returns the same reference and the same bytes', () => {
    const once = backfillItem(COCONUT, DEFAULTS)
    const twice = backfillItem(once, DEFAULTS)
    expect(twice).toBe(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('is lossless — every legacy key survives, in order, with its value verbatim', () => {
    const out = backfillItem(COCONUT, DEFAULTS)
    expect(Object.keys(out).slice(0, Object.keys(COCONUT).length)).toEqual(Object.keys(COCONUT))
    for (const [k, v] of Object.entries(COCONUT)) expect(out[k as keyof typeof out]).toEqual(v)
  })

  it('never overwrites a key a master already saved — only the missing ones are filled', () => {
    const partly = { ...CARROT, procurementForm: 'DIRECT_USE' as const, storageCondition: 'frozen' as const }
    const out = backfillItem(partly, DEFAULTS)
    expect(out.procurementForm).toBe('DIRECT_USE')
    expect(out.storageCondition).toBe('frozen')
    expect(out.requiresGrading).toBe(false)
    expect(out.requiresExtraction).toBe(true)
  })

  it('takes its conversions from the plant config, not the DECISIONS defaults', () => {
    const tuned = backfillDefaults({ avgNutWeightG: 600, defaultDensityKgPerL: 1.05 })
    const out = backfillItem(COCONUT, tuned)
    expect(out.avgUnitWeight).toBe(0.6)
    expect(backfillItem(VANILLA, tuned).densityKgPerL).toBe(1.05)
  })
})

const batch = (over: Partial<BatchDoc>): BatchDoc => ({
  id: 'BAT-2026-0001',
  kind: 'Extraction',
  date: '2026-10-03T11:38:00.000Z',
  location: 'Cold Room A',
  sourceLines: [{ lot: 'LOT-20261008-001', item: 'RM-PP-0001', uom: 'Piece', qty: 300, unitCost: 62 }],
  blendLines: [],
  outputLines: [
    { item: 'SF-0002', qty: 90.2, uom: 'Litre', costShare: 100, stockId: 'BAT-2026-0001/1' },
    { item: 'SF-0003', qty: 6, uom: 'Kg', costShare: 0, stockId: 'BAT-2026-0001/2' },
  ],
  coconuts: 300,
  inputQty: 300,
  inputUom: 'Piece',
  spoiled: 1,
  outputs: [],
  outputLitres: 90.2,
  yieldPerCoconut: 0.3,
  yieldPerUnit: 0.3,
  rmCost: 18600,
  pmCost: 0,
  directCost: 18600,
  costPerL: 206.2,
  status: 'Released',
  qcId: 'QC-2026-0001',
  qcIds: ['QC-2026-0001', 'QC-2026-0002'],
  ...over,
})

describe('backfillBatch — output typing and the stage clock', () => {
  it('a pressing: the first output is the MAIN, the rest are BY_PRODUCTs', () => {
    const out = backfillBatch(batch({}))
    expect(out.outputLines?.map((l) => l.type)).toEqual(['MAIN', 'BY_PRODUCT'])
  })

  it('a blend: every output is an INTERMEDIATE downstream blends consume', () => {
    const out = backfillBatch(batch({ id: 'MEL-2026-0002', kind: 'Melange' }))
    expect(out.outputLines?.every((l) => l.type === 'INTERMEDIATE')).toBe(true)
  })

  it('a batch with no kind predates blending — it types as a pressing', () => {
    const legacy = batch({ kind: undefined, outputLines: [{ item: 'SF-0002', qty: 10, uom: 'Litre', costShare: 100 }] })
    expect(backfillBatch(legacy).outputLines?.[0].type).toBe('MAIN')
  })

  it('the stage clock lands empty, even on a batch with no outputs to type', () => {
    const out = backfillBatch(batch({ outputLines: undefined }))
    expect(out.stageTimes).toEqual({})
    expect(out.outputLines).toBeUndefined()
  })

  it('line facts survive verbatim — stockId, costShare, qcExempt — beside the new type', () => {
    const out = backfillBatch(batch({ outputLines: [{ item: 'SF-0001', qty: 1.28, uom: 'Litre', costShare: 100, stockId: 'BAT-2026-0002/1', qcExempt: true }] }))
    expect(out.outputLines?.[0]).toEqual({
      item: 'SF-0001',
      qty: 1.28,
      uom: 'Litre',
      costShare: 100,
      stockId: 'BAT-2026-0002/1',
      qcExempt: true,
      type: 'MAIN',
    })
  })

  it('a type a later flow already wrote is never retyped', () => {
    const typed = batch({
      outputLines: [
        { item: 'SF-0002', qty: 90.2, uom: 'Litre', costShare: 100, type: 'CO_PRODUCT' },
        { item: 'SF-0003', qty: 6, uom: 'Kg', costShare: 0, type: 'MAIN' },
      ],
    })
    const out = backfillBatch(typed)
    expect(out).not.toBe(typed) // stageTimes still lands
    expect(out.outputLines?.map((l) => l.type)).toEqual(['CO_PRODUCT', 'MAIN'])
  })

  it('an already-started stage clock is never reset', () => {
    const started = batch({ stageTimes: { started: '2026-10-10T04:00:00.000Z' }, outputLines: [] })
    expect(backfillBatch(started).stageTimes).toEqual({ started: '2026-10-10T04:00:00.000Z' })
  })

  it('is idempotent — the second run returns the same reference', () => {
    const once = backfillBatch(batch({}))
    expect(backfillBatch(once)).toBe(once)
  })
})

const melange = (over: Partial<MelangeDoc>): MelangeDoc => ({
  id: 'MLG-0001',
  name: 'ABC Melange',
  outputItem: 'SF-MLG-0001',
  uom: 'Litre',
  components: [{ item: 'SF-0002', share: 50 }, { item: 'SF-0001', share: 50 }],
  description: '',
  status: 'Active',
  ...over,
})

describe('backfillMelange — recipes become versioned templates', () => {
  it('a legacy recipe points at itself, versions at 1, and normalises Active to active', () => {
    const out = backfillMelange(melange({}))
    expect(out.recipeId).toBe('MLG-0001')
    expect(out.version).toBe(1)
    expect(out.status).toBe('active')
  })

  it('an Inactive recipe retires rather than reactivating', () => {
    expect(backfillMelange(melange({ status: 'Inactive' })).status).toBe('retired')
  })

  it('an already-backfilled recipe is returned untouched', () => {
    const done = backfillMelange(melange({}))
    expect(backfillMelange(done)).toBe(done)
    const handEdited = { ...done, version: 3 }
    expect(backfillMelange(handEdited).version).toBe(3)
  })
})

const customer = (over: Partial<CustomerDoc>): CustomerDoc => ({
  id: 'CUS-00001',
  name: 'Fernandez Bogulkunta',
  shipTo: 'Fernandez Hospital',
  gst: '36AALCR6912J1ZZ',
  status: 'Active',
  ...over,
})

describe('backfillCustomer — the packaging question defaults to ASK', () => {
  it('every customer is asked at dispatch until they are set otherwise', () => {
    expect(backfillCustomer(customer({})).dispatchPackaging).toBe('ASK')
  })

  it('a saved preference is kept, and a re-run writes nothing', () => {
    const boxed = backfillCustomer(customer({ dispatchPackaging: 'BOXED' }))
    expect(boxed.dispatchPackaging).toBe('BOXED')
    expect(backfillCustomer(boxed)).toBe(boxed)
  })
})

const product = (over: Partial<ProductDoc>): ProductDoc => ({
  id: 'FG-0001',
  name: 'TCW 5L C-Box',
  type: 'BiB',
  size: 5,
  unit: 'L',
  packVolume: 5,
  shelfLifeDays: 90,
  bom: [{ item: 'PM-PP-0010', qty: 1 }],
  ...over,
})

describe('backfillProduct — pack format and BIB size from the SKU names', () => {
  it("reads 'BiB' out of the name or pack type, and the litres the name spells", () => {
    const out = backfillProduct(product({}))
    expect(out.packFormat).toBe('bib')
    expect(out.bibSize).toBe(5)
  })

  it('a decimal size in the name parses — TCW 2.5L', () => {
    expect(backfillProduct(product({ id: 'FG-0003', name: 'TCW 2.5L', size: 2.5, packVolume: 2.5 })).bibSize).toBe(2.5)
  })

  it('a size the plant does not fill (2L) stays unset for a master to answer', () => {
    const out = backfillProduct(product({ id: 'FG-0006', name: 'Screwcap Bib - 2L', size: 2, packVolume: 2 }))
    expect(out.packFormat).toBe('bib')
    expect(out.bibSize).toBeUndefined()
  })

  it("a name without a size stays unset even when the master's size field says one", () => {
    const out = backfillProduct(product({ id: 'FG-0007', name: 'ABC Melange', size: 2.5, packVolume: 2.5 }))
    expect(out.packFormat).toBe('bib')
    expect(out.bibSize).toBeUndefined()
  })

  it('a glass SKU is glass with no pouch size', () => {
    const out = backfillProduct(product({ id: 'FG-0002', name: 'Glass Bottles - 100ml', type: 'Glass Bottle', size: 120, unit: 'ml', packVolume: 0.12 }))
    expect(out.packFormat).toBe('glass')
    expect(out.bibSize).toBeUndefined()
  })

  it('is idempotent, and never retypes a SKU a master already set', () => {
    const once = backfillProduct(product({}))
    expect(backfillProduct(once)).toBe(once)
    const handSet = { ...product({}), packFormat: 'glass' as const }
    expect(backfillProduct(handSet).packFormat).toBe('glass')
  })
})

const location = (over: Partial<StorageLocation>): StorageLocation => ({
  id: 'LOC-0002',
  name: 'Cold Room A',
  label: 'Cold Room A',
  holds: 'All the packed TCW, blends are stored before dispatch',
  type: 'Cold Room',
  status: 'Active',
  ...over,
})

describe('backfillStorageLocation — the zone layer', () => {
  it('maps every legacy type onto its zone', () => {
    expect(backfillStorageLocation(location({})).zone).toBe('cold_room')
    expect(backfillStorageLocation(location({ id: 'LOC-0001', type: 'Dry Store' })).zone).toBe('ambient')
    expect(backfillStorageLocation(location({ id: 'LOC-0003', name: 'Deep Freezer', type: 'Hold Area' })).zone).toBe('quarantine')
    const npd = backfillStorageLocation(location({ id: 'LOC-0006', name: 'NPD Area', type: 'NPD Area' }))
    expect(npd.zone).toBe('ambient')
    expect(npd.type).toBe('NPD Area') // the tag itself survives — that is what tells an NPD area apart
  })

  it('creates nothing and invents nothing: an unknown type, or a zoned row, is untouched', () => {
    const alien = location({ id: 'LOC-X', type: 'Freezer' as StorageLocation['type'] })
    expect(backfillStorageLocation(alien)).toBe(alien)
    const zoned = backfillStorageLocation(location({}))
    expect(backfillStorageLocation(zoned)).toBe(zoned)
  })
})

describe('mergeAppConfig — the configurable business parameters', () => {
  it('adds every DECISIONS default the config lacks, preserving all its own keys', () => {
    const stored = { yieldTolerance: 12, reportCustomerName: 'Roligt Foods' }
    const out = mergeAppConfig(stored)
    expect(out.yieldTolerance).toBe(12)
    expect(out.reportCustomerName).toBe('Roligt Foods')
    for (const [k, v] of Object.entries(APP_CONFIG_ADDITIONS)) expect(out[k]).toEqual(v)
  })

  it('keeps the plant’s own value for a key it already tuned', () => {
    expect(mergeAppConfig({ avgNutWeightG: 650, fefoMode: 'strict' }).avgNutWeightG).toBe(650)
    expect(mergeAppConfig({ fefoMode: 'strict' }).fefoMode).toBe('strict')
  })

  it('returns the same reference when there is nothing to add; a missing row becomes just the additions', () => {
    const full = mergeAppConfig({ avgNutWeightG: 500 })
    expect(mergeAppConfig(full)).toBe(full)
    expect(full).toEqual({ avgNutWeightG: 500, ...APP_CONFIG_ADDITIONS })
    expect(mergeAppConfig(null)).toEqual(APP_CONFIG_ADDITIONS)
  })

  it('backfillDefaults reads the merged config with the DECISIONS fallbacks', () => {
    expect(backfillDefaults(mergeAppConfig(null))).toEqual({ avgUnitWeightKg: 0.5, densityKgPerL: 1 })
    expect(backfillDefaults({})).toEqual({ avgUnitWeightKg: 0.5, densityKgPerL: 1 })
  })
})

describe('the seeds — new collections, insert-only', () => {
  it('spoilage_reasons carries the frozen DECISIONS #3 rows under stable ids', () => {
    const rows = spoilageReasonSeedRows()
    expect(rows).toHaveLength(SPOILAGE_REASON_SEEDS.length)
    expect(rows.map((r) => r.id)).toEqual(SPOILAGE_REASON_SEEDS.map((s) => `${s.stage}:${s.code}`))
    expect(rows.every((r) => r.doc.active === true)).toBe(true)
    expect(rows.map((r) => r.doc)).toEqual([...SPOILAGE_REASON_SEEDS])
  })

  it('carton_specs seeds the three BIB sizes as inactive placeholders holding nulls (DECISIONS #14)', () => {
    const rows = cartonSpecSeedRows()
    expect(rows.map((r) => r.doc.bibSize)).toEqual([1, 2.5, 5])
    expect(rows.map((r) => r.id)).toEqual(['carton-1L', 'carton-2.5L', 'carton-5L'])
    for (const r of rows) {
      expect(r.doc.cartonItemId).toBeNull()
      expect(r.doc.pouchesPerCarton).toBeNull()
      expect(r.doc.active).toBe(false)
    }
    expect(BIB_SIZES).toEqual([1, 2.5, 5])
  })

  it('flags seeds every phase flag OFF — the six named keys plus one per KPI module', () => {
    const rows = flagSeedRows('2026-10-13T00:00:00.000Z')
    expect(rows.map((r) => r.id)).toEqual([...FLAG_KEYS, ...KPI_MODULES.map((m) => `dashboards_${m}`)])
    expect(rows).toHaveLength(16)
    expect(rows.every((r) => r.doc.enabled === false)).toBe(true)
    const keys = rows.map((r) => r.id)
    expect(keys).toContain('dashboards_procurement')
    expect(keys).toContain('dashboards_shipment-tracking')
    expect(rows[0].doc).toMatchObject({ key: 'shell_nav', note: expect.any(String), updatedBy: 'system', updatedAt: '2026-10-13T00:00:00.000Z' })
  })

  it('the PO counter starts the series at 1', () => {
    expect(PO_COUNTER_SEED).toEqual({ series: 'po', next: 1 })
  })
})
