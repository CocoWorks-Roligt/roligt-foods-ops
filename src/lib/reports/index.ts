/**
 * The catalog of live reports — what each one is called, what it reads, and the
 * one-line method note it prints under its title. The derivations live beside
 * this in one module per family; the page is thin and reads only this catalog.
 */

export type ReportKey =
  | 'procurement-lots'
  | 'fruits'
  | 'lot-yield'
  | 'production'
  | 'batch-wise'
  | 'dispatch'
  | 'rm'
  | 'pm'
  | 'storage'
  | 'quality'

export type ReportFamily = 'Procurement' | 'Production' | 'Quality' | 'Stock & dispatch'

export interface ReportDef {
  key: ReportKey
  title: string
  family: ReportFamily
  /** One line under the title: what the report reads and how it counts. */
  method: string
  /** A sentence for the catalog card. */
  blurb: string
  /** The records the report is derived over, printed on the card. */
  sources: string
  /** Whether the range picker offers a second window to compare against. */
  compare: boolean
  /** Whether the window applies at all — stock-on-hand reports are "as of now". */
  ranged: boolean
}

const def = (d: ReportDef): ReportDef => d

export const REPORTS: ReportDef[] = [
  def({
    key: 'procurement-lots',
    title: 'Procurement lot report',
    family: 'Procurement',
    method:
      'One row per goods receipt in the range. Landed = priced quantity × rate + transport; ₹ per accepted unit = landed ÷ grades A+B+C.',
    blurb: 'Every lot taken in — grades, rejects, rate, landed cost and what each accepted unit cost.',
    sources: 'Goods receipts',
    compare: true,
    ranged: true,
  }),
  def({
    key: 'fruits',
    title: 'Fruits procurement',
    family: 'Procurement',
    method:
      'The lot report filtered to produce other than tender coconut — receipts that name their item. Receipts posted before the plant bought other fruit are all tender coconut, so they stay out by item, not by date.',
    blurb: 'The same figures for the fruit the plant presses — beetroot, apple, carrot — apart from coconut.',
    sources: 'Goods receipts',
    compare: true,
    ranged: true,
  }),
  def({
    key: 'lot-yield',
    title: 'Lot yield report',
    family: 'Procurement',
    method:
      'A lot’s output is attributed pro-rata by its share of each batch’s issued quantity, across all of history. ₹ per litre = usable cost ÷ attributed net-new litres; spoiled = gate rejects + attributed production spoilage.',
    blurb: 'What each lot finally gave: litres pressed, spoilage on the way, yield per unit and cost per litre.',
    sources: 'Goods receipts ⟕ production batches',
    compare: false,
    ranged: true,
  }),
  def({
    key: 'production',
    title: 'Production report',
    family: 'Production',
    method:
      'Net-new bulk = extraction outputs + mélange outputs − bulk a mélange drew, so blended litres already counted at extraction are not counted twice. Packs are counted off packing runs.',
    blurb: 'What was made, month by month — extractions, melanges, net-new bulk, packs, yield and cost trends.',
    sources: 'Production batches + packing runs',
    compare: true,
    ranged: true,
  }),
  def({
    key: 'batch-wise',
    title: 'Batch-wise production',
    family: 'Production',
    method:
      'One row per batch in the range, inputs and every output it booked, with its QC records linked. The whole cost sits on the main output; by-products carry none.',
    blurb: 'Each batch on its own — inputs, outputs, yields, spoiled, cost per litre and QC status.',
    sources: 'Production batches',
    compare: false,
    ranged: true,
  }),
  def({
    key: 'dispatch',
    title: 'Dispatch report',
    family: 'Stock & dispatch',
    method:
      'Dispatch lines grouped by month or by batch. Quantities are summed per SKU — packs and kilograms are never added together.',
    blurb: 'What went out, to whom, against which challan — delivered, pending and proof-of-delivery completeness.',
    sources: 'Dispatches (+ orders)',
    compare: false,
    ranged: true,
  }),
  def({
    key: 'rm',
    title: 'Raw material report',
    family: 'Stock & dispatch',
    method:
      'Opening → received → issued → closing, folded from the ledger by item and unit, for the range. Closing is the ledger balance on the last day, so it can never disagree with the Inventory page.',
    blurb: 'Produce movements for the period, with lot ageing of what is still on hand.',
    sources: 'Ledger',
    compare: false,
    ranged: true,
  }),
  def({
    key: 'pm',
    title: 'Packing material report',
    family: 'Stock & dispatch',
    method:
      'The same ledger engine as raw material, over packing-material items, with each item flagged against the reorder level set on its master.',
    blurb: 'BiBs, bottles, caps and cartons — receipts, consumption, closing stock and reorder flags.',
    sources: 'Ledger + item masters',
    compare: false,
    ranged: true,
  }),
  def({
    key: 'storage',
    title: 'Finished goods on hand',
    family: 'Stock & dispatch',
    method:
      'Current finished-goods balances by storage area and item, aged to each line’s own expiry date and valued at unit cost. A live position, not a windowed one.',
    blurb: 'Where the finished stock sits, what it is worth, and how close it is to its expiry.',
    sources: 'Ledger',
    compare: false,
    ranged: false,
  }),
  def({
    key: 'quality',
    title: 'Quality report',
    family: 'Quality',
    method:
      'One row per QC record, filed by the month of its batch and the product it covers. A batch whose outputs disagree reads as its roll-up — partly released is its own state, not a fudge.',
    blurb: 'Release, hold and reject counts and rates by month and by product.',
    sources: 'QC records + batch status',
    compare: false,
    ranged: true,
  }),
]

export const reportDef = (key: string): ReportDef | undefined =>
  REPORTS.find((r) => r.key === key)

/** The catalog's order of the four families. */
export const REPORT_FAMILIES: ReportFamily[] = [
  'Procurement',
  'Production',
  'Quality',
  'Stock & dispatch',
]
