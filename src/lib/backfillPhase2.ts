/**
 * Phase 2 backfill — the one-off additive merges that carry the live plant's
 * documents onto the frozen Phase-1 contracts (ARCHITECTURE §2), as pure
 * functions so the script that applies them (scripts/overhaul/
 * backfill-phase2.mjs) and the tests that pin them share one definition with
 * no database in sight.
 *
 * The rules every function here keeps, because the plant is running on this
 * data while the backfill lands:
 *
 *   ADDITIVE — only keys that are absent are written. A key a master has
 *   already saved (or an earlier run of this backfill) is never touched, so a
 *   re-run after a manual edit reconciles nothing and clobbers nothing.
 *
 *   IDEMPOTENT — when there is nothing to add the input reference is returned
 *   unchanged (`out === doc` is the script's "no write" signal, and the
 *   version column never moves).
 *
 *   LOSSLESS — existing keys keep their order and their values verbatim; new
 *   keys are appended. Nothing is renamed, deleted or reordered.
 *
 * The one deliberate value (not key) change: a melange's legacy `status`
 * ('Active'/'Inactive') is normalised onto the contract's lowercase recipe
 * statuses ('active'/'retired') — the task specifies `+status 'active'`, and
 * the key already exists on every melange, so adding it means normalising it.
 */
import {
  FLAG_KEYS,
  KPI_MODULES,
  SPOILAGE_REASON_SEEDS,
  isRecipeStatus,
  type AppConfigExtension,
  type BatchExtension,
  type BatchOutputExtension,
  type BibSize,
  type CustomerExtension,
  type FlagRecord,
  type ItemExtension,
  type MelangeExtension,
  type OutputType,
  type ProductExtension,
  type SpoilageReason,
  type StorageLocationExtension,
  type StorageZone,
} from './contracts'
import type {
  Batch,
  BatchKind,
  BulkOutputLine,
  Customer,
  Item,
  Melange,
  Product,
  StorageLocation,
  StorageType,
} from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// items
// ─────────────────────────────────────────────────────────────────────────────

/** A stored item, possibly already carrying Phase-2 keys (a re-run). */
export type ItemDoc = Item & Partial<ItemExtension>

/** The per-material conversions mass balance converts through, taken from
 *  meta.app_config (DECISIONS #2) — the kg a counting unit weighs and the kg a
 *  litre weighs, plant-wide until a master overrides them per material. */
export interface BackfillDefaults {
  avgUnitWeightKg: number
  densityKgPerL: number
}

const isPiece = (uom?: string) => (uom ?? '').toLowerCase() === 'piece'
const isLitre = (uom?: string) => /^(l|liter|litre|liters|litres)$/.test((uom ?? '').trim().toLowerCase())

/** DECISIONS #4 default conditions by the legacy item type — a starting
 *  point the masters page edits per material afterwards; no per-item override
 *  is attempted by the backfill. */
const STORAGE_CONDITION_BY_TYPE: Partial<Record<Item['type'], ItemExtension['storageCondition']>> = {
  'Raw Material': 'ambient',
  'Packing Material': 'ambient',
  'Semi Finished': 'cold',
  'Finished Goods': 'cold',
}

export function backfillItem(item: ItemDoc, defaults: BackfillDefaults): ItemDoc {
  const procurementForm: ItemExtension['procurementForm'] = item.directUse
    ? 'DIRECT_USE'
    : item.type === 'Raw Material'
      ? 'RAW'
      : 'READY_EXTRACT'
  const requiresGrading = isPiece(item.uom) && item.type === 'Raw Material'
  const storageCondition = STORAGE_CONDITION_BY_TYPE[item.type]

  const patch: Partial<ItemExtension> = {}
  if (item.procurementForm === undefined) patch.procurementForm = procurementForm
  if (item.requiresGrading === undefined) patch.requiresGrading = requiresGrading
  if (item.requiresExtraction === undefined) patch.requiresExtraction = procurementForm === 'RAW'
  if (item.storageCondition === undefined && storageCondition !== undefined) {
    patch.storageCondition = storageCondition
  }
  // only the graded intake converts through an average unit weight, and only
  // litre-measured materials through a density — nothing else gets a guess
  if (item.avgUnitWeight === undefined && requiresGrading) patch.avgUnitWeight = defaults.avgUnitWeightKg
  if (item.densityKgPerL === undefined && isLitre(item.uom)) patch.densityKgPerL = defaults.densityKgPerL

  if (Object.keys(patch).length === 0) return item
  return { ...item, ...patch }
}

// ─────────────────────────────────────────────────────────────────────────────
// batches — output typing and the stage clock
// ─────────────────────────────────────────────────────────────────────────────

/** A stored batch, possibly already carrying Phase-2 keys. */
export interface BatchDoc extends Batch, BatchExtension {
  outputLines?: (BulkOutputLine & Partial<BatchOutputExtension>)[]
}

/** The output's place in the chain (ARCHITECTURE §2 backfill rule): a
 *  pressing run's first output is the MAIN, the rest are BY_PRODUCTs; a
 *  blend's bulk is an INTERMEDIATE downstream blends consume. A batch with no
 *  kind predates blending — every such batch is a pressing (types.ts). */
const outputTypeFor = (kind: BatchKind | undefined, index: number): OutputType =>
  kind === 'Melange' ? 'INTERMEDIATE' : index === 0 ? 'MAIN' : 'BY_PRODUCT'

export function backfillBatch(batch: BatchDoc): BatchDoc {
  let out: BatchDoc | undefined
  const patchWith = (patch: Partial<BatchDoc>) => {
    out = { ...(out ?? batch), ...patch }
  }

  if (Array.isArray(batch.outputLines)) {
    let typed = false
    const lines = batch.outputLines.map((line, i) => {
      if (line.type !== undefined) return line
      typed = true
      return { ...line, type: outputTypeFor(batch.kind, i) }
    })
    if (typed) patchWith({ outputLines: lines })
  }

  // the stage clock starts empty — a closed legacy batch has no timestamps to
  // recover, and an open one starts collecting them under batch_v2
  if (batch.stageTimes === undefined) patchWith({ stageTimes: {} })

  return out ?? batch
}

// ─────────────────────────────────────────────────────────────────────────────
// melanges — versioned recipe templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stored melange, possibly already carrying Phase-2 keys. `status` stays the
 * legacy string on the way in — 'Active'/'Inactive' is what the plant saved —
 * so the transform can tell a legacy value from an already-normalised one.
 */
export interface MelangeDoc extends Melange {
  /** The recipe this row is a version of — the melange's own id. */
  recipeId?: string
  version?: number
}

export function backfillMelange(melange: MelangeDoc): MelangeDoc {
  const patch: Partial<MelangeDoc> = {}
  if (melange.recipeId === undefined) patch.recipeId = melange.id
  if (melange.version === undefined) patch.version = 1
  if (!isRecipeStatus(melange.status)) {
    // 'Inactive' retires; anything else (including absent) starts active
    const next: MelangeExtension['status'] = melange.status?.toLowerCase() === 'inactive' ? 'retired' : 'active'
    if (melange.status !== next) patch.status = next
  }
  if (Object.keys(patch).length === 0) return melange
  return { ...melange, ...patch }
}

// ─────────────────────────────────────────────────────────────────────────────
// customers — the dispatch-packaging question
// ─────────────────────────────────────────────────────────────────────────────

export type CustomerDoc = Customer & Partial<CustomerExtension>

export function backfillCustomer(customer: CustomerDoc): CustomerDoc {
  if (customer.dispatchPackaging !== undefined) return customer
  return { ...customer, dispatchPackaging: 'ASK' }
}

// ─────────────────────────────────────────────────────────────────────────────
// products — pack format and BIB size from the SKU names
// ─────────────────────────────────────────────────────────────────────────────

export type ProductDoc = Product & Partial<ProductExtension>

/** The pouch sizes the plant fills, in litres. */
export const BIB_SIZES: readonly BibSize[] = [1, 2.5, 5]

/** 'BiB' in the name or the admin-named pack type → bib; everything else
 *  (glass bottles, covers, pouches) reads as the not-bib format: glass. */
const inferPackFormat = (p: ProductDoc): ProductExtension['packFormat'] =>
  `${p.name} ${p.type}`.toLowerCase().includes('bib') ? 'bib' : 'glass'

/** The litres the SKU's name spells — 'TCW 5L C-Box' → 5, 'TCW 2.5L' → 2.5.
 *  Only the three sizes the plant fills count; a 2 L SKU stays unset for a
 *  master to answer (contracts BibSize), and nothing is guessed from `size`. */
const parseBibSize = (name: string): BibSize | undefined => {
  const m = /(\d+(?:\.\d+)?)\s*l\b/i.exec(name)
  const parsed = m ? Number(m[1]) : undefined
  return parsed !== undefined && BIB_SIZES.includes(parsed as BibSize) ? (parsed as BibSize) : undefined
}

export function backfillProduct(product: ProductDoc): ProductDoc {
  const packFormat = product.packFormat ?? inferPackFormat(product)
  const patch: Partial<ProductExtension> = {}
  if (product.packFormat === undefined) patch.packFormat = packFormat
  if (product.bibSize === undefined && packFormat === 'bib') {
    const bibSize = parseBibSize(product.name)
    if (bibSize !== undefined) patch.bibSize = bibSize
  }
  if (Object.keys(patch).length === 0) return product
  return { ...product, ...patch }
}

// ─────────────────────────────────────────────────────────────────────────────
// storage_locations — the zone layer
// ─────────────────────────────────────────────────────────────────────────────

export type StorageLocationDoc = StorageLocation & Partial<StorageLocationExtension>

/** The zone each legacy storage type maps onto (ARCHITECTURE §2). An NPD area
 *  is ambient; it stays told apart by its untouched `type` — 'NPD Area' —
 *  which is the tag ARCHITECTURE keeps, so no extra flag is invented. A
 *  dispatch-staging zone arrives with new rows later; the backfill creates
 *  nothing. */
const ZONE_BY_TYPE: Partial<Record<StorageType, StorageZone>> = {
  'Cold Room': 'cold_room',
  'Dry Store': 'ambient',
  'Hold Area': 'quarantine',
  'NPD Area': 'ambient',
}

export function backfillStorageLocation(location: StorageLocationDoc): StorageLocationDoc {
  if (location.zone !== undefined) return location
  const zone = ZONE_BY_TYPE[location.type]
  if (zone === undefined) return location
  return { ...location, zone }
}

// ─────────────────────────────────────────────────────────────────────────────
// meta.app_config — the overhaul's configurable business parameters
// ─────────────────────────────────────────────────────────────────────────────

/** DECISIONS register defaults, one line each: #2 mass balance + conversions,
 *  #7 cold chain, #8 FEFO, #5 QC-at-receipt, #12 OTP, #10 challan FY prefix. */
export const APP_CONFIG_ADDITIONS: AppConfigExtension = {
  massBalanceTolerancePct: 2,
  avgNutWeightG: 500,
  defaultDensityKgPerL: 1.0,
  coldChainTimeoutMin: 30,
  fefoMode: 'relaxed',
  qcAtReceiptDefault: false,
  otpAtDelivery: false,
  challanFyPrefix: false,
}

/**
 * Merge-add the additions into a stored app_config, preserving every existing
 * key and value. Returns the same reference when there was nothing to add
 * (re-run after apply); a null/undefined config (a base with no row) becomes
 * a fresh object holding just the additions.
 */
export function mergeAppConfig(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!config) return { ...APP_CONFIG_ADDITIONS }
  const out = { ...config }
  let added = false
  for (const [key, value] of Object.entries(APP_CONFIG_ADDITIONS)) {
    if (!(key in out)) {
      out[key] = value
      added = true
    }
  }
  return added ? out : config
}

/** The item-backfill conversions, read off the (merged) app_config so a plant
 *  that has already tuned avgNutWeightG or defaultDensityKgPerL gets its own
 *  numbers, not the DECISIONS defaults. */
export function backfillDefaults(config: Record<string, unknown>): BackfillDefaults {
  const grams = Number(config.avgNutWeightG)
  const density = Number(config.defaultDensityKgPerL)
  return {
    avgUnitWeightKg: (Number.isFinite(grams) && grams > 0 ? grams : 500) / 1000,
    densityKgPerL: Number.isFinite(density) && density > 0 ? density : 1,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// new collections and the PO counter — seeds, insert-only
// ─────────────────────────────────────────────────────────────────────────────

/** A row the script inserts into `documents`: the business key plus the JSON
 *  the new endpoints read. Existing rows are never replaced — the seeds land
 *  as `ON CONFLICT DO NOTHING` so reference-data edits survive a re-run. */
export interface SeedRow<T> {
  id: string
  doc: T
}

/** spoilage_reasons, from the frozen SPOILAGE_REASON_SEEDS (DECISIONS #3). */
export function spoilageReasonSeedRows(): SeedRow<SpoilageReason>[] {
  return SPOILAGE_REASON_SEEDS.map((seed) => ({
    id: `${seed.stage}:${seed.code}`,
    doc: { ...seed },
  }))
}

/**
 * carton_specs, three placeholder rows (DECISIONS #14): which carton item a
 * BIB size fills and how many pouches fit are entered at rollout, so the
 * placeholders carry nulls and sit inactive rather than guessing. Null is a
 * deliberate divergence from CartonSpec's string/number fields — the rollout
 * edit replaces the whole row.
 */
export interface CartonSpecPlaceholder {
  id: string
  bibSize: BibSize
  cartonItemId: null
  pouchesPerCarton: null
  active: false
}

export function cartonSpecSeedRows(): SeedRow<CartonSpecPlaceholder>[] {
  return BIB_SIZES.map((bibSize) => {
    const id = `carton-${bibSize}L`
    return { id, doc: { id, bibSize, cartonItemId: null, pouchesPerCarton: null, active: false } }
  })
}

const FLAG_NOTES: Record<string, string> = {
  shell_nav: 'Process-order sidebar (Phase 2)',
  pipeline: 'Pipeline Home (Phase 3)',
  batch_v2: 'Batch v2 stage forms (Phase 3)',
  qc_gate_v2: 'Server-enforced QC release gate (Phase 3)',
  dispatch_v2: 'Dispatch v2: packaging decision + partials (Phase 4)',
  shipments: 'Shipment tracking + delivery PWA (Phase 4)',
}

/** flags — every phase rides a flag and rolls back by switching it off
 *  (ARCHITECTURE §7): the six named keys plus one dashboards_<module> per
 *  KPI module (KPI_MODULES build order), all OFF. */
export function flagSeedRows(now: string, updatedBy = 'system'): SeedRow<FlagRecord>[] {
  const keys = [...FLAG_KEYS, ...KPI_MODULES.map((m) => `dashboards_${m}`)]
  return keys.map((key) => ({
    id: key,
    doc: {
      key,
      enabled: false,
      note: FLAG_NOTES[key] ?? `Dashboards module: ${key.slice('dashboards_'.length)}`,
      updatedBy,
      updatedAt: now,
    },
  }))
}

/** The purchase-order series' counter row (ARCHITECTURE §2, purchase_orders) —
 *  inserted only when absent, so a later run never rewinds a number already
 *  minted. */
export const PO_COUNTER_SEED = { series: 'po', next: 1 } as const
