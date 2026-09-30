/**
 * Reading a batch. Production started out pressing one raw material — tender
 * coconuts — into one main output and one by-product, and recorded that in fields
 * named after it. It now presses any produce and blends the results, so everything
 * a page needs to read off a batch goes through here, and batches posted under the
 * older shape keep reading without a rewrite.
 */

// `.ts` extensions — see the note in stock.ts: this module is compiled by the api
// project's nodenext tsconfig too.
import { fmtRowTotal, itemName } from './stock.ts'
import type { AppState, Batch, BatchKind, BulkOutputLine, Item, PackingRun } from '../types.ts'

export const COCONUT_ITEM = 'RM-TCW-COCO'
export const WATER_ITEM = 'SF-TCW-WATER'
export const MALAI_ITEM = 'SF-TCW-MALAI'

export const batchKind = (b: Batch): BatchKind => b.kind || 'Extraction'

/** Every bulk a batch put into the store. */
export function batchOutputs(b: Batch): BulkOutputLine[] {
  if (b.outputLines?.length) return b.outputLines
  // Coconut batches posted before outputs were a list.
  const out: BulkOutputLine[] = []
  const water = b.waterLitres ?? b.outputLitres ?? 0
  if (water > 0) out.push({ item: WATER_ITEM, qty: water, uom: 'Litre', costShare: 100 })
  const malai = b.malaiKg ?? 0
  if (malai > 0) out.push({ item: MALAI_ITEM, qty: malai, uom: 'Kg', costShare: 0 })
  return out
}

/** The output the batch's whole cost sits on, and the one its yield is reported against. */
export function mainOutput(b: Batch): BulkOutputLine | undefined {
  const lines = batchOutputs(b)
  return lines.find((l) => l.costShare > 0) || lines[0]
}

export const batchInputQty = (b: Batch) => b.inputQty ?? b.coconuts ?? 0
export const batchInputUom = (b: Batch) => b.inputUom || 'Piece'
export const batchYield = (b: Batch) => b.yieldPerUnit ?? b.yieldPerCoconut ?? 0

/** The batch's whole issue, one row per line — source and blend lines each carry the
 *  unit their quantity is counted in, so this is where a per-unit figure comes from. */
export const batchInputRows = (b: Batch): { qty: number; uom: string }[] =>
  [...(b.sourceLines || []), ...(b.blendLines || [])].map((l) => ({ qty: l.qty || 0, uom: l.uom || '' }))

/** True when the issue spans more than one unit (water by the litre, malai by the
 *  kilo): no single denominator exists, so no per-unit yield is reported for it. */
export const batchInputMixed = (b: Batch) =>
  new Set(batchInputRows(b).map((r) => r.uom).filter(Boolean)).size > 1

/** The whole issue ready to print, every unit named — "600 Piece · 40 Kg" for a mixed
 *  issue, never a bare sum with an invented unit. The recorded figure stands when the
 *  lines that would say are missing (a batch too old to carry them). */
export const fmtBatchInput = (b: Batch): string => {
  const rows = batchInputRows(b)
  return rows.length ? fmtRowTotal(rows) : `${batchInputQty(b)} ${batchInputUom(b)}`
}

/**
 * Blending loss against the main output's own unit: the issue counted in that unit
 * minus what came out in it. A line in another unit is an input, not a loss —
 * subtracting kilos of malai from litres of water never produced a number that
 * meant anything. Null when nothing in the main output's unit went in.
 */
export const batchLossToMain = (b: Batch): number | null => {
  const main = mainOutput(b)
  if (!main) return null
  const issued = batchInputRows(b)
    .filter((r) => r.uom === main.uom)
    .reduce((a, r) => a + r.qty, 0)
  return issued > 0 ? issued - main.qty : null
}

/**
 * Litres per *usable* unit — what came out divided by what was actually pressed.
 * Spoiled produce never reached the press, so counting it in the denominator made a
 * good batch look like a poor one purely for having arrived with rot in the load.
 */
export const usableYield = (issued: number, spoiled: number, output: number) => {
  const usable = (issued || 0) - (spoiled || 0)
  return usable > 0 ? (output || 0) / usable : 0
}

/** What the spoiled units would have given, at the rate the rest actually ran at. */
export const batchWastage = (b: Batch) =>
  b.wastage ?? batchYield(b) * (b.spoiled || 0)

/** "128.5 L", "12 kg" — a bulk quantity with the unit it is counted in. */
export const fmtBulk = (qty: number, uom: string) =>
  `${Number((Number(qty) || 0).toFixed(3))} ${uom === 'Kg' ? 'kg' : 'L'}`

/** Every semi-finished item — the bulk products production and melanges can make. */
export const bulkItems = (state: AppState): Item[] =>
  state.items.filter((i) => i.type === 'Semi Finished')

export const itemUom = (state: AppState, id: string) =>
  state.items.find((i) => i.id === id)?.uom || 'Unit'

/**
 * The bulk a packing run drew. Runs posted before the plant made more than one juice
 * carry no bulk item, so the water/malai medium they were filed under answers for them.
 */
export const runBulkItem = (r: PackingRun) =>
  r.bulkItem || (r.medium === 'Malai' ? MALAI_ITEM : WATER_ITEM)

/**
 * What to call a batch on a list, a sticker or a trace.
 *
 * There used to be a free-text "product family" typed on every batch, which meant the
 * same juice was filed under three spellings and a batch could claim to be something
 * it had not produced. The batch is named by what it actually made: the recipe a
 * melange followed, or the main output an extraction booked.
 */
export function batchLabel(state: AppState, b: Batch): string {
  if (batchKind(b) === 'Melange') {
    const recipe = state.melanges.find((m) => m.id === b.melangeId)
    if (recipe) return recipe.name
  }
  const main = mainOutput(b)
  return main ? itemName(state, main.item) : b.id
}

/** A one-line summary of what a batch made, for lists and dropdowns. */
export const outputSummary = (state: AppState, b: Batch) =>
  batchOutputs(b)
    .map((l) => `${fmtBulk(l.qty, l.uom)} ${itemName(state, l.item)}`)
    .join(' + ')
