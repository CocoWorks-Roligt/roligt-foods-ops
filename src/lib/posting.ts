/**
 * The posting engine: what a batch, a packing run and a dispatch are allowed to do,
 * and the ledger lines they write when they do it. Kept out of the React context so
 * the rules can be read — and exercised — without a component tree around them.
 *
 * Every function here takes a draft of the state and mutates it in place. The context
 * is what owns cloning, so nothing below ever has to think about immutability.
 */

import { COCONUT_ITEM, batchOutputs, fmtBulk, itemUom } from './batches'
import { bulkItemOf, mediumForUom } from './packs'
import { withStockIds } from './stockIds'
import { isRow, itemName, product, rowKey, stockRows, areaRefusal, defaultArea, inHoldArea } from './stock'
import { fitsWithin, localDay, nowISO, toDateKey, QTY_EPSILON, sameQty, uid } from './utils'
import { addDays, retentionDays } from './controlSamples'
import type {
  AppState,
  Batch,
  BatchKind,
  BlendLine,
  BomLine,
  BulkOutputLine,
  ControlSample,
  MelangeComponent,
  PackUnit,
  QcTestResult,
  PackingLine,
  PackingRun,
  SourceLine,
  StockRow,
  StorageLocation,
} from '../types'

/** One issue line as the form hands it over. What it costs is read off stock when
 *  the batch is posted, so a form can never book a price that is no longer true. */
export interface IssueInput {
  item: string
  lot: string
  qty: number
}

/** What came out of a batch. Exactly one line is `main` and carries the whole cost. */
export interface OutputInput {
  item: string
  qty: number
  main: boolean
}

export interface BatchInput {
  date: string
  /** Extraction presses raw produce; Melange blends bulk that other batches made. */
  kind: BatchKind
  /** Recipe a melange run followed. */
  melangeId?: string
  spoiled: number
  /** Raw material issued — the produce an extraction presses. */
  sourceLines: IssueInput[]
  /** Bulk drawn from other batches — the components a melange blends. */
  blendLines: IssueInput[]
  outputs: OutputInput[]
  /** Cold room the bulk it makes is put away in. Defaults to the plant's bulk cold
   *  room for a run posted before the floor could choose. */
  location?: string
}

export interface PackingInput {
  date: string
  batchId: string
  /** Bulk the run draws — coconut water, malai, an ABC melange. */
  bulkItem: string
  /** How many of each pack to fill. What one pack holds comes off the product
   *  master, so a run can no longer contradict the size the admin published. */
  lines: { sku: string; packs: number }[]
  /** Where the filled packs are put away. */
  location?: string
  /** Bottles kept back as control samples — they draw bulk but make no stock. */
  controlSamples?: ControlSampleInput[]
}

/** One product's control samples, as the packing form states them. */
export interface ControlSampleInput {
  /** Pack the bottles were filled into; empty for any other container. */
  sku?: string
  count: number
  /** Another container only: what one held, in ml (g for bulk sold by weight). */
  sizeMl?: number
  collectedBy?: string
}

/** Which line of a run's samples this is, across an edit of the run. */
const sampleKey = (s: { sku?: string; sizeMl?: number }) =>
  s.sku ? `sku:${s.sku}` : `ml:${Number(s.sizeMl) || 0}`

/** Bulk one control-sample line takes off the batch, in the bulk's base unit. */
export function sampleBulk(state: AppState, s: { sku?: string; count: number; sizeMl?: number }) {
  const count = Number(s.count) || 0
  if (count <= 0) return 0
  if (s.sku) return count * (product(state, s.sku)?.packVolume || 0)
  return (count * (Number(s.sizeMl) || 0)) / 1000
}

/** Everything the admin sets on a pack product; `medium` and `packVolume` follow
 *  from the unit and the bulk it is filled from, and are derived, never typed. */
export interface ProductInput {
  name: string
  type: string
  size: number
  unit: PackUnit
  /** Semi-finished item a packing run draws to fill this pack. */
  bulkItem: string
  shelfLifeDays: number
  chilledShelfLifeDays?: number
  mrp?: number
  bom: BomLine[]
}

/** A bulk (semi-finished) output production or a melange can book. */
export interface BulkProductInput {
  name: string
  /** 'Litre' or 'Kg' — every cost and stock figure downstream is in this unit. */
  uom: string
  /**
   * True for something a batch produces alongside its real output — malai beside
   * coconut water, pomace beside beetroot juice. A by-product carries none of the
   * batch cost, so the main output's cost per litre does not move with how much of
   * it a pressing happens to throw off.
   */
  byProduct: boolean
}

/** Stored on the item, so the rule survives without a second field to keep in step. */
export const BY_PRODUCT_COST_METHOD = 'By-product'
export const isByProduct = (item: { costMethod?: string } | undefined) =>
  item?.costMethod === BY_PRODUCT_COST_METHOD

export interface MelangeInput {
  name: string
  uom: string
  components: MelangeComponent[]
  description: string
}

/**
 * A QC review: each test's result, by report type. What the results add up to is
 * `qcDecision` in lib/qcCategories.
 */
export interface QcUpdate {
  tests: Record<string, QcTestResult>
}

/**
 * What a batch as a whole is, given a verdict on each thing it made.
 *
 * A coconut pressing gives water and malai, and they are tested apart — so the batch
 * itself no longer has one verdict, it has a summary of several. Released only when
 * every output is; rejected only when every output is; and `Partly Released` for the
 * real case this exists for, where the water is cleared and the malai is not.
 */
export function batchDisposition(records: { disposition: string }[]): string {
  if (!records.length) return 'Awaiting QC'
  const all = records.map((r) => r.disposition)
  if (all.every((x) => x === 'Released')) return 'Released'
  if (all.every((x) => x === 'Rejected')) return 'Rejected'
  // A retest is the loudest thing on the list: something has to be done before the
  // batch can move at all, whatever the other outputs say.
  if (all.includes('Retest')) return 'On Hold'
  if (all.includes('Pending')) return 'Awaiting QC'
  return 'Partly Released'
}

/** The QC record covering one bulk output of one batch. */
export const qcFor = (state: AppState, batchId: string, item: string) =>
  state.qcs.find((q) => q.batchId === batchId && q.item === item)

export interface DispatchInput {
  customerId: string
  sku: string
  batchId: string
  location: string
  /** Which of the batch's dates this stock carries. Two runs off one batch into one
   *  freezer are two rows, and only this tells them apart — see `rowKey`. */
  expiry?: string
  qty: number
  vehicle: string
  expected?: string
  notes?: string
}

/** Everything the operator controls; `name` is derived once and hidden. */
export type StorageLocationInput = Omit<StorageLocation, 'id' | 'status' | 'name'>

export interface MoveStockInput {
  item: string
  lot: string
  status: string
  from: string
  to: string
  /** Which of the lot's dates this stock carries. Part of which row this is — see
   *  `rowKey`. Without it a move found whichever row came first. */
  expiry?: string
  qty: number
  note?: string
}

/**
 * What a check answers with.
 *
 * Two shapes, and the difference is deliberate. `Problem` is for a check that only
 * says whether something may be posted; `Checked<T>` is for one that also works out
 * figures the caller then needs, so refusing and computing are the same pass over the
 * data and cannot disagree with each other.
 *
 * There used to be three names for this second shape — `PackingMath`, `DispatchCheck`,
 * `OrderDispatchCheck` — all structurally identical, which is how a codebase ends up
 * with three subtly different ideas of what "ok" means.
 */
export type Problem = string | null

export type Checked<T> = ({ ok: true } & T) | { ok: false; error: string }

export function activityScore(s: AppState) {
  return s.grns.length + s.batches.length + s.dispatches.length + s.audits.length
}

/**
 * Stock as it stood before `doc` was posted. Editing a document re-posts its ledger
 * lines, so every check behind an edit has to leave the document's own lines out —
 * otherwise a batch would be told the coconuts it already issued are unavailable.
 */
export const withoutDoc = (state: AppState, doc?: string): AppState =>
  doc ? { ...state, ledger: state.ledger.filter((l) => l.doc !== doc) } : state

/**
 * Bulk in any of these can be drawn by a document downstream — blended into a melange
 * or filled into packs. Stock QC has rejected is in none of them: a batch that failed
 * its tests must not reach a bottle any more than it may reach a blend.
 */
export const DRAWABLE = ['Available', 'Quarantine', 'Released']

/** What is on hand of one item's lot, across every place it sits and every status allowed. */
export function onHand(state: AppState, item: string, lot: string, statuses?: string[]) {
  return stockRows(state)
    .filter(
      (r) => r.item === item && r.lot === lot && (!statuses || statuses.includes(r.status)),
    )
    .reduce((a, b) => a + b.qty, 0)
}

/**
 * Books consume lines for `qty` of one item's lot, taking it from wherever it is
 * actually sitting and at whatever it is actually carrying, and reports back what it
 * cost. Reading the price off stock at post time is what keeps a form from booking a
 * cost that has since moved.
 */
function drawStock(
  draft: AppState,
  opts: { doc: string; type: string; item: string; lot: string; qty: number; statuses?: string[] },
) {
  const rows = stockRows(draft).filter(
    (r) =>
      r.item === opts.item &&
      r.lot === opts.lot &&
      r.qty > 0 &&
      (!opts.statuses || opts.statuses.includes(r.status)),
  )
  let remaining = opts.qty
  let cost = 0
  let uom = ''
  for (const r of rows) {
    if (remaining <= QTY_EPSILON) break
    const use = Math.min(remaining, r.qty)
    draft.ledger.push({
      id: uid('LED'),
      type: opts.type,
      doc: opts.doc,
      item: r.item,
      itemType: r.itemType,
      lot: r.lot,
      location: r.location,
      status: r.status,
      qtyIn: 0,
      qtyOut: use,
      uom: r.uom,
      unitCost: r.unitCost,
      time: nowISO(),
    })
    cost += use * r.unitCost
    uom = uom || r.uom
    remaining -= use
  }
  return { cost, uom, unitCost: opts.qty ? cost / opts.qty : 0 }
}

/** "128 L Coconut Water (bulk) + 12 kg Malai (bulk)" — how an audit line reads. */
export const describeOutputs = (state: AppState, lines: BulkOutputLine[]) =>
  lines.map((l) => `${fmtBulk(l.qty, l.uom)} ${itemName(state, l.item)}`).join(' + ') || 'nothing'

const liveLines = (lines: IssueInput[]) => lines.filter((l) => l.item && l.lot && l.qty > 0)
const liveOutputs = (lines: OutputInput[]) => lines.filter((l) => l.item && l.qty > 0)

/** Everything a batch put into the ledger. Frozen once anything downstream draws on it. */
export function batchQuantitiesChanged(b: Batch, input: BatchInput) {
  const issuesMatch = (
    existing: { item?: string; lot: string; qty: number }[],
    incoming: IssueInput[],
  ) =>
    existing.length === incoming.length &&
    existing.every(
      (x, i) =>
        (x.item || COCONUT_ITEM) === incoming[i].item &&
        x.lot === incoming[i].lot &&
        x.qty === incoming[i].qty,
    )

  if (!issuesMatch(b.sourceLines || [], liveLines(input.sourceLines))) return true
  if (!issuesMatch(b.blendLines || [], liveLines(input.blendLines))) return true
  const existing = batchOutputs(b)
  const incoming = liveOutputs(input.outputs)
  if (existing.length !== incoming.length) return true
  return existing.some(
    (o, i) =>
      o.item !== incoming[i].item ||
      o.qty !== incoming[i].qty ||
      (o.costShare > 0) !== incoming[i].main,
  )
}

/**
 * Where new stock goes when nobody picked an area: the default set for it on the Storage
 * page. It used to be guessed — the first active area of the right type whose name looked
 * right, and failing that a hard-coded seed name — which put finished packs into the bulk
 * cold room and booked receipts into areas that had been deactivated or no longer
 * existed. A default that is not set is simply not there now, and the posting asks.
 */
export const defaultBulkStore = (state: AppState) => defaultArea(state, 'bulk')?.name
export const defaultPackStore = (state: AppState) => defaultArea(state, 'packs')?.name
export const defaultRawStore = (state: AppState) => defaultArea(state, 'produce')?.name
export const defaultPackingStore = (state: AppState) => defaultArea(state, 'packingMaterial')?.name

const PUT_AWAY: Record<string, string> = {
  'Raw Material': 'the produce',
  'Packing Material': 'the packing material',
  'Semi Finished': 'the bulk',
  'Finished Goods': 'the packs',
}

/** Where a document's own stock was put, read off its ledger lines. */
export const postedLocation = (state: AppState, doc: string, itemType: string) =>
  state.ledger.find((l) => l.doc === doc && l.itemType === itemType && l.qtyIn > 0)?.location

/**
 * Refuses an area that may not hold this stock, and says which rule it broke — see
 * `areaRefusal`. `keep` is the area a document being edited already has: an edit that
 * leaves it where it is must not be refused for a rule the area has since fallen foul of,
 * or correcting a date would be blocked by a room somebody deactivated.
 */
export function checkArea(
  state: AppState,
  name: string | undefined,
  itemType: string,
  opts: { status?: string; keep?: string } = {},
): Problem {
  if (!name) {
    return `Pick a storage area for ${PUT_AWAY[itemType] || 'the stock'} — no default is set for it on the Storage page.`
  }
  if (opts.keep && name === opts.keep) return null
  return areaRefusal(state.storageLocations.find((s) => s.name === name), itemType, opts.status)
}

export function checkBatch(state: AppState, input: BatchInput, ignoreDoc?: string): Problem {
  const blending = input.kind === 'Melange'
  const sources = liveLines(input.sourceLines)
  const blends = liveLines(input.blendLines)
  if (blending && !blends.length) return 'Add at least one bulk component to blend.'
  if (!blending && !sources.length) return 'Add at least one source lot.'

  const outputs = liveOutputs(input.outputs)
  if (!outputs.length) return 'Record what came out of the batch.'
  if (new Set(outputs.map((o) => o.item)).size !== outputs.length) {
    return 'Each output can only be listed once.'
  }
  if (!outputs.some((o) => o.main)) return 'Mark which output the batch cost sits on.'
  // Everything a batch makes is bulk, and bulk belongs in a cold room.
  const editing = ignoreDoc ? state.batches.find((b) => b.id === ignoreDoc) : undefined
  const badArea = checkArea(state, input.location || defaultBulkStore(state), 'Semi Finished', {
    keep: editing ? editing.location || postedLocation(state, editing.id, 'Semi Finished') : undefined,
  })
  if (badArea) return badArea

  const base = withoutDoc(state, ignoreDoc)
  /**
   * Both forms let an operator add a second line, so the same lot can be named twice.
   * Compared one line at a time each would clear on its own and the batch would claim
   * more than the lot holds — the draw then quietly stops at the real balance and the
   * batch records an issue the ledger never made. Add the lines up first.
   */
  const short = (lines: IssueInput[], statuses: string[]) => {
    const wanted = new Map<string, number>()
    for (const l of lines) {
      const key = `${l.item}\u0000${l.lot}`
      wanted.set(key, (wanted.get(key) || 0) + l.qty)
    }
    for (const [key, qty] of wanted) {
      const [item, lot] = key.split('\u0000')
      if (qty > onHand(base, item, lot, statuses) + QTY_EPSILON) {
        return `${lot} does not have that much ${itemName(state, item)} left.`
      }
    }
    return null
  }
  const sourceShort = short(sources, ['Available'])
  if (sourceShort) return sourceShort
  const blendShort = short(blends, DRAWABLE)
  if (blendShort) return blendShort
  for (const b of blends) {
    if (outputs.some((o) => o.item === b.item)) {
      return `${itemName(state, b.item)} cannot be both a component and the blend it makes.`
    }
  }

  /**
   * A blend that leaves out one of its own components is not that melange. The shares
   * themselves are only guidance — the floor tops up and holds back, and the run is
   * the record of what really went in — but drawing none at all of a named component
   * means the recipe on the label does not describe what is in the tank.
   */
  const existingRun = ignoreDoc ? state.batches.find((b) => b.id === ignoreDoc) : undefined
  // An edit that leaves the components exactly as they were is not the moment to
  // start refusing a run posted before this rule existed — correcting its date must
  // not be blocked by history.
  const componentsUntouched =
    !!existingRun && !batchQuantitiesChanged(existingRun, input)
  if (blending && input.melangeId && !componentsUntouched) {
    const recipe = state.melanges.find((m) => m.id === input.melangeId)
    const missing = (recipe?.components || [])
      .filter((c) => c.share > 0)
      .filter((c) => !blends.some((b) => b.item === c.item && b.qty > 0))
    if (missing.length) {
      const names = missing.map((c) => itemName(state, c.item)).join(', ')
      return `${recipe?.name || 'This melange'} is blended from ${names}, and this run draws none. Add ${
        missing.length > 1 ? 'them' : 'it'
      }, or pick a different melange.`
    }
  }

  const issued = sources.reduce((a, b) => a + b.qty, 0)
  if (!blending && input.spoiled >= issued && issued > 0) {
    // Yield is measured per *usable* nut, so a batch where everything spoiled has no
    // denominator to divide by — and nothing could have come out of it anyway.
    return 'Spoiled quantity must be less than the quantity issued.'
  }
  return null
}

/**
 * Writes a batch's issue and output lines and returns the figures the batch record is
 * built from. Works the same for an extraction pressing produce and a melange blending
 * bulk: everything issued is drawn at the cost it carries, and the total lands on the
 * one output marked as the main one. A by-product — malai, pomace — carries nothing,
 * so the cost per litre of the main output does not move with how much of it a batch
 * happens to yield.
 */
export function postBatchLines(draft: AppState, id: string, input: BatchInput) {
  const blending = input.kind === 'Melange'
  const sourceLines: SourceLine[] = []
  const blendLines: BlendLine[] = []
  const uoms = new Set<string>()
  let inputCost = 0
  let inputQty = 0

  for (const s of liveLines(input.sourceLines)) {
    const drawn = drawStock(draft, {
      doc: id,
      type: 'Production Consume',
      item: s.item,
      lot: s.lot,
      qty: s.qty,
      statuses: ['Available'],
    })
    const uom = drawn.uom || itemUom(draft, s.item)
    const grn = draft.grns.find((g) => g.lot === s.lot)
    sourceLines.push({
      lot: s.lot,
      item: s.item,
      uom,
      qty: s.qty,
      unitCost: drawn.unitCost,
      farmerId: grn?.farmerId || '',
    })
    inputCost += drawn.cost
    inputQty += s.qty
    uoms.add(uom)
  }

  for (const b of liveLines(input.blendLines)) {
    const drawn = drawStock(draft, {
      doc: id,
      type: 'Melange Consume',
      item: b.item,
      lot: b.lot,
      qty: b.qty,
      statuses: DRAWABLE,
    })
    const uom = drawn.uom || itemUom(draft, b.item)
    blendLines.push({ item: b.item, lot: b.lot, uom, qty: b.qty, unitCost: drawn.unitCost })
    inputCost += drawn.cost
    inputQty += b.qty
    uoms.add(uom)
  }

  // Each bulk a batch makes is its own item of stock with its own stock ID. An edit
  // re-posts through here while the batch is still on the draft, so the IDs it already
  // issued are carried over rather than renumbered.
  const existing = draft.batches.find((b) => b.id === id)
  const outputLines = withStockIds<BulkOutputLine>(
    id,
    liveOutputs(input.outputs).map((o) => ({
      item: o.item,
      qty: o.qty,
      uom: itemUom(draft, o.item),
      costShare: o.main ? 100 : 0,
    })),
    (l) => l.item,
    existing ? batchOutputs(existing) : [],
  )
  for (const line of outputLines) {
    draft.ledger.push({
      id: uid('LED'),
      type: blending ? 'Melange Output' : 'Production Output',
      doc: id,
      item: line.item,
      itemType: 'Semi Finished',
      lot: id,
      location: input.location || defaultBulkStore(draft) || '',
      status: 'Quarantine',
      qtyIn: line.qty,
      qtyOut: 0,
      uom: line.uom,
      unitCost: line.qty ? (inputCost * line.costShare) / 100 / line.qty : 0,
      time: nowISO(),
    })
  }

  return {
    sourceLines,
    blendLines,
    outputLines,
    inputQty,
    // A batch pressing one produce reports in that produce's unit; a mixed issue has
    // no single unit to report in, so its total is left unlabelled.
    inputUom: uoms.size === 1 ? [...uoms][0] : 'Unit',
    inputCost,
    main: outputLines.find((l) => l.costShare > 0) || outputLines[0],
  }
}

export type PackingMath = Checked<{
  drawn: number
  pmNeeds: Record<string, number>
  bulkItem: string
  uom: string
}>

export function checkPacking(state: AppState, input: PackingInput, ignoreDoc?: string): PackingMath {
  const batch = state.batches.find((b) => b.id === input.batchId)
  if (!batch) return { ok: false, error: 'Select a batch.' }
  const lines = input.lines.filter((l) => l.sku && l.packs > 0)
  if (!lines.length) return { ok: false, error: 'Add at least one pack line.' }

  const bulkItem = input.bulkItem
  if (!bulkItem) return { ok: false, error: 'Select what the run is filling from.' }

  /**
   * Packs go into a storage area as they come off the line and stay there while the lab
   * works — QC changes their status, never their area.
   */
  const editingRun = ignoreDoc ? state.packingRuns.find((r) => r.id === ignoreDoc) : undefined
  const badArea = checkArea(state, input.location || defaultPackStore(state), 'Finished Goods', {
    keep: editingRun?.location,
  })
  if (badArea) return { ok: false, error: badArea }

  const uom = itemUom(state, bulkItem)
  let drawn = 0
  const pmNeeds: Record<string, number> = {}
  for (const l of lines) {
    const p = product(state, l.sku)
    if (!p) return { ok: false, error: `Unknown SKU ${l.sku}` }
    if (bulkItemOf(p) !== bulkItem) {
      return { ok: false, error: `${p.name} is not filled from ${itemName(state, bulkItem)}.` }
    }
    // The size lives on the product, so a product left at zero would silently draw
    // nothing at all and book packs out of thin air.
    if (!(p.packVolume > 0)) {
      return { ok: false, error: `${p.name} has no pack size — set it on the Products & Materials page first.` }
    }
    drawn += l.packs * p.packVolume
    for (const c of p.bom) pmNeeds[c.item] = (pmNeeds[c.item] || 0) + c.qty * l.packs
  }

  /**
   * Control samples come out of the same tank as the packs, so they have to be drawn
   * too — otherwise the batch keeps showing bulk that physically went into them. A
   * sample filled into one of the run's packs also uses that pack's bottle and cap,
   * which the plant has to have on the shelf like any other.
   */
  const keptBefore = (editingRun?.controlSamples || []).map(sampleKey)
  for (const s of input.controlSamples || []) {
    if (!s.sku && !Number(s.count) && !Number(s.sizeMl) && !s.collectedBy?.trim()) continue
    const count = Number(s.count)
    if (!Number.isInteger(count) || count <= 0) {
      return { ok: false, error: 'Control samples are counted in whole bottles — enter how many were kept.' }
    }
    if (s.sku) {
      const p = product(state, s.sku)
      if (!p) return { ok: false, error: `Unknown pack ${s.sku}` }
      if (bulkItemOf(p) !== bulkItem) {
        return { ok: false, error: `${p.name} is not filled from ${itemName(state, bulkItem)}.` }
      }
      if (!(p.packVolume > 0)) {
        return { ok: false, error: `${p.name} has no pack size — set it on the Products & Materials page first.` }
      }
      drawn += count * p.packVolume
      for (const c of p.bom) pmNeeds[c.item] = (pmNeeds[c.item] || 0) + c.qty * count
    } else {
      if (!(Number(s.sizeMl) > 0)) {
        return { ok: false, error: 'Say how much each control sample container holds.' }
      }
      drawn += (count * Number(s.sizeMl)) / 1000
    }
    // The register's "collected by" is not optional. Only a line saved before the run
    // asked for it may stay blank, so an old run can still be corrected.
    if (!s.collectedBy?.trim() && !keptBefore.includes(sampleKey(s))) {
      return { ok: false, error: 'Say who collected the control samples.' }
    }
  }

  const base = stockRows(withoutDoc(state, ignoreDoc))
  const bulkAvailable = base
    .filter(
      (r) =>
        r.item === bulkItem && r.lot === batch.id && r.qty > 0 && DRAWABLE.includes(r.status),
    )
    .reduce((a, b) => a + b.qty, 0)
  if (drawn > bulkAvailable + QTY_EPSILON) {
    // Rejected bulk is invisible to the sum above, so say what happened to it — being
    // told a full batch has "0 L left" reads like a bug rather than a QC decision.
    const rejected = base
      .filter(
        (r) =>
          r.item === bulkItem && r.lot === batch.id && r.qty > 0 && !DRAWABLE.includes(r.status),
      )
      .reduce((a, b) => a + b.qty, 0)
    return {
      ok: false,
      error: `${batch.id} only has ${fmtBulk(bulkAvailable, uom)} of ${itemName(state, bulkItem)} left to pack${
        rejected ? ` — QC rejected ${fmtBulk(rejected, uom)} of it` : ''
      }.`,
    }
  }
  for (const [item, qty] of Object.entries(pmNeeds)) {
    const avail = base
      .filter((r) => r.item === item && r.status === 'Available')
      .reduce((a, b) => a + b.qty, 0)
    // Within the same tolerance as every other quantity check. A bill of materials
    // can call for a fraction — half a metre of film per pack — and an exact
    // comparison refuses a run that has exactly enough.
    if (!fitsWithin(qty, avail)) {
      return {
        ok: false,
        error: `Not enough packing material: ${itemName(state, item)} needs ${Number(
          qty.toFixed(3),
        )}, available ${Number(avail.toFixed(3))}.`,
      }
    }
  }
  return { ok: true, drawn, pmNeeds, bulkItem, uom }
}

/** Draws bulk and packing material, books the packs, and returns the run record. */
export function postPackingLines(
  draft: AppState,
  id: string,
  input: PackingInput,
  math: { drawn: number; pmNeeds: Record<string, number>; bulkItem: string; uom: string },
): PackingRun {
  const batch = draft.batches.find((b) => b.id === input.batchId)!
  const date = new Date(input.date)
  const lines = input.lines.filter((l) => l.sku && l.packs > 0)
  // Bulk sold by weight is packed and sold by weight; everything else by the pack.
  const medium = mediumForUom(math.uom)
  /**
   * Packed goods take the QC verdict of the bulk they were filled from — not the
   * batch's. One pressing gives water and malai and they are tested apart, so bottles
   * of released water must not be held back because the malai beside them is still on
   * the bench. A batch posted before QC was per-product answers for itself.
   */
  const bulkQc = qcFor(draft, batch.id, math.bulkItem)
  const released = bulkQc ? bulkQc.disposition === 'Released' : batch.status === 'Released'
  const freezer = defaultPackStore(draft) || ''

  let bulkCost = 0
  let remainingBulk = math.drawn
  for (const r of stockRows(draft).filter(
    (x) =>
      x.item === math.bulkItem && x.lot === batch.id && x.qty > 0 && DRAWABLE.includes(x.status),
  )) {
    const use = Math.min(remainingBulk, r.qty)
    draft.ledger.push({
      id: uid('LED'),
      type: 'Packing Consume',
      doc: id,
      item: math.bulkItem,
      itemType: 'Semi Finished',
      lot: batch.id,
      location: r.location,
      status: r.status,
      qtyIn: 0,
      qtyOut: use,
      uom: r.uom,
      unitCost: r.unitCost,
      time: nowISO(),
    })
    bulkCost += use * r.unitCost
    remainingBulk -= use
    if (remainingBulk <= QTY_EPSILON) break
  }

  let pmCost = 0
  /** What each packing material actually cost this run, per unit drawn. */
  const pmDrawn: Record<string, { qty: number; cost: number }> = {}
  const pmRows = stockRows(draft)
  for (const [item, qty] of Object.entries(math.pmNeeds)) {
    let remain = qty
    for (const r of pmRows.filter((x) => x.item === item && x.status === 'Available' && x.qty > 0)) {
      const use = Math.min(remain, r.qty)
      draft.ledger.push({
        id: uid('LED'),
        type: 'Packing Consume',
        doc: id,
        item,
        itemType: 'Packing Material',
        lot: r.lot,
        location: r.location,
        status: 'Available',
        qtyIn: 0,
        qtyOut: use,
        uom: r.uom,
        unitCost: r.unitCost,
        time: nowISO(),
      })
      pmCost += use * r.unitCost
      const drawnSoFar = (pmDrawn[item] ||= { qty: 0, cost: 0 })
      drawnSoFar.qty += use
      drawnSoFar.cost += use * r.unitCost
      remain -= use
      if (remain <= 0) break
    }
  }

  /**
   * Sample bottles are drawn out of the same tank but never become stock, so their
   * bulk has to land on the packs the run did fill — pricing off the total drawn
   * instead left that value on no row at all and quietly shrank inventory. Dividing
   * by the packed volume is what "absorbed by the packs" means, and it keeps
   * bulkCost + pmCost equal to the value of the packs booked.
   */
  const packedVolume = lines.reduce((a, l) => a + l.packs * product(draft, l.sku)!.packVolume, 0)
  const bulkPerUnit = packedVolume ? bulkCost / packedVolume : 0
  /**
   * Price each component off what this run drew. Reading it back from stock instead
   * priced the pack off whatever lot happened to be left over — and off nothing at all,
   * so zero, whenever the run emptied the last lot of a material.
   */
  const pmUnitCost = (item: string) => {
    const drawn = pmDrawn[item]
    return drawn && drawn.qty ? drawn.cost / drawn.qty : 0
  }
  /**
   * A control sample filled into a pack uses that pack's bottle and cap as well as its
   * juice, and that cost lands on the packs the run did fill the same way the juice
   * does — left out, it would sit on no row at all and quietly shrink inventory.
   */
  const samplePm = (input.controlSamples || []).reduce((a, s) => {
    const p = s.sku && Number(s.count) > 0 ? product(draft, s.sku) : undefined
    return a + (p ? Number(s.count) * p.bom.reduce((x, c) => x + pmUnitCost(c.item) * c.qty, 0) : 0)
  }, 0)
  const samplePmPerUnit = packedVolume ? samplePm / packedVolume : 0
  const packLines: PackingLine[] = lines.map((l) => {
    const p = product(draft, l.sku)!
    const packPm = p.bom.reduce((a, c) => a + pmUnitCost(c.item) * c.qty, 0)
    // Copied off the product, not referenced: resizing a pack later must not rewrite
    // what a run that already happened drew.
    const perPack = p.packVolume
    const lineDrawn = l.packs * perPack
    // Malai is sold by weight, juice and water by the pack.
    const qty = medium === 'Malai' ? lineDrawn : l.packs
    const cost = lineDrawn * (bulkPerUnit + samplePmPerUnit) + l.packs * packPm
    return {
      sku: l.sku,
      packs: l.packs,
      perPack,
      drawn: lineDrawn,
      qty,
      unitCost: qty ? cost / qty : 0,
      expiry: toDateKey(new Date(date.getTime() + p.shelfLifeDays * 86400000)),
    }
  })
  // Every pack line is its own item of stock. An edit keeps the IDs the run issued.
  const numbered = withStockIds(
    id,
    packLines,
    (l) => l.sku,
    draft.packingRuns.find((r) => r.id === id)?.lines,
  )

  for (const l of numbered) {
    draft.ledger.push({
      id: uid('LED'),
      type: 'Packing Output',
      doc: id,
      item: l.sku,
      itemType: 'Finished Goods',
      lot: batch.id,
      location: input.location || freezer,
      status: released ? 'Released' : 'Quarantine',
      qtyIn: l.qty,
      qtyOut: 0,
      uom: draft.items.find((i) => i.id === l.sku)?.uom || 'Pack',
      unitCost: l.unitCost,
      time: nowISO(),
      expiry: l.expiry,
    })
  }

  /**
   * The register lines. They expire a set number of days after the day they were
   * produced, fixed when they are posted like a pack's best-before; an edit keeps
   * what was recorded against them since — who took them, when they were destroyed —
   * and only moves the expiry if the run's own day moved.
   */
  const madeOn = toDateKey(date)
  const previousRun = draft.packingRuns.find((r) => r.id === id)
  const sameDay = !!previousRun && localDay(previousRun.date) === madeOn
  const unclaimed = [...(previousRun?.controlSamples || [])]
  const controlSamples: ControlSample[] = (input.controlSamples || [])
    .filter((s) => Number(s.count) > 0)
    .map((s) => {
      const at = unclaimed.findIndex((b) => sampleKey(b) === sampleKey(s))
      const kept = at >= 0 ? unclaimed.splice(at, 1)[0] : undefined
      return {
        ...(s.sku ? { sku: s.sku } : { sizeMl: Number(s.sizeMl) }),
        count: Number(s.count),
        perBottle: s.sku ? product(draft, s.sku)?.packVolume || 0 : (Number(s.sizeMl) || 0) / 1000,
        collectedBy: s.collectedBy?.trim() || kept?.collectedBy || '',
        expiresOn:
          sameDay && kept?.expiresOn ? kept.expiresOn : addDays(madeOn, retentionDays(draft.config)),
        ...(kept?.destroyedOn ? { destroyedOn: kept.destroyedOn } : {}),
        ...(kept?.remark ? { remark: kept.remark } : {}),
      }
    })

  return {
    id,
    date: date.toISOString(),
    batchId: batch.id,
    location: input.location || freezer,
    bulkItem: math.bulkItem,
    ...(controlSamples.length ? { controlSamples } : {}),
    medium,
    lines: numbered,
    drawn: math.drawn,
    pmCost,
    bulkCost,
    status: released ? 'Released' : 'Quarantine',
  }
}

export type DispatchCheck = Checked<{ row: StockRow }>

/** One order line matched to the stock chosen to fill it. */
export interface OrderAllocation {
  sku: string
  /** Stock rows the operator picked. The expiry is part of which row this is —
   *  see `rowKey`. */
  picks: { lot: string; location: string; qty: number; expiry?: string }[]
}

export type OrderDispatchCheck = Checked<{
  rows: { sku: string; lot: string; location: string; qty: number; expiry?: string }[]
}>

/**
 * Validates a whole order against live stock before any of it is written.
 *
 * An order ships complete, so this is deliberately all-or-nothing: every line is
 * measured against what is actually on the shelf, and the first shortfall refuses the
 * lot. The caller then writes every line inside one state update, so there is no way
 * to end up with half an order dispatched and a customer told the rest is coming.
 */
export function checkOrderDispatch(
  state: AppState,
  order: { lines: { sku: string; qty: number }[] },
  allocations: OrderAllocation[],
): OrderDispatchCheck {
  const live = stockRows(state)
  const out: { sku: string; lot: string; location: string; qty: number; expiry?: string }[] = []
  // Two lines of the same order can draw the same lot, so what is left has to be
  // tracked across the whole order rather than checked one line at a time.
  const remaining = new Map<string, number>()

  for (const line of order.lines) {
    if (!(line.qty > 0)) return { ok: false, error: `Enter how many ${itemName(state, line.sku)}.` }
    const alloc = allocations.find((a) => a.sku === line.sku)
    const picked = (alloc?.picks || []).filter((p) => p.qty > 0)
    const total = picked.reduce((a, p) => a + p.qty, 0)
    if (!sameQty(total, line.qty)) {
      return {
        ok: false,
        error: `${itemName(state, line.sku)}: ${total} of ${line.qty} allotted. An order goes out complete.`,
      }
    }
    for (const p of picked) {
      // Keyed by the whole row identity, expiry included: two runs off one batch into
      // one freezer are two rows carrying two dates, and pooling them under one key
      // drew both against a single balance and shipped one under the other's date.
      const id = { item: line.sku, lot: p.lot, location: p.location, expiry: p.expiry }
      const k = rowKey(id)
      if (!remaining.has(k)) {
        const row = live.find((r) => isRow(r, id) && r.status === 'Released')
        if (row && inHoldArea(state, row.location)) {
          return {
            ok: false,
            error: `${itemName(state, line.sku)} from ${p.lot} is set aside in a hold area — move it back out before dispatching it.`,
          }
        }
        remaining.set(k, row?.qty ?? 0)
      }
      const left = remaining.get(k) ?? 0
      if (!fitsWithin(p.qty, left)) {
        return {
          ok: false,
          error: `${itemName(state, line.sku)} from ${p.lot}: only ${Number(left.toFixed(2))} left.`,
        }
      }
      remaining.set(k, left - p.qty)
      // The date comes off the row that was actually checked. Looking it up again
      // unfiltered could answer with a quarantined or rejected row sitting in the
      // same place under a different date.
      out.push({ sku: line.sku, lot: p.lot, location: p.location, qty: p.qty, expiry: p.expiry })
    }
  }
  if (!out.length) return { ok: false, error: 'Add at least one line to the order.' }
  return { ok: true, rows: out }
}

export function checkDispatch(
  state: AppState,
  input: DispatchInput,
  ignoreDoc?: string,
): DispatchCheck {
  if (!state.customers.some((c) => c.id === input.customerId)) {
    return { ok: false, error: 'Select a customer.' }
  }
  // The expiry is part of which row this is. Matched on item·lot·location alone, two
  // runs off one batch into one freezer collapsed into a single entry: the ceiling
  // below came from whichever happened to be first, and the line went out carrying
  // that row's date whichever stock actually left.
  const row = stockRows(withoutDoc(state, ignoreDoc)).find(
    (x) =>
      isRow(x, {
        item: input.sku,
        lot: input.batchId,
        location: input.location,
        expiry: input.expiry,
      }) &&
      x.status === 'Released' &&
      x.qty > 0,
  )
  // Packs go out of whatever storage area they are sitting in: the QC verdict decides
  // whether they may leave. A hold area is the one exception — only rejected stock is
  // set aside there, and nothing in one is dispatched.
  if (!row) return { ok: false, error: 'Select released stock.' }
  if (inHoldArea(state, row.location)) {
    return { ok: false, error: 'That stock is set aside in a hold area — move it back out before dispatching it.' }
  }
  if (input.qty <= 0 || input.qty > row.qty) {
    return { ok: false, error: `Dispatch quantity must be between 1 and ${row.qty}.` }
  }
  return { ok: true, row }
}

