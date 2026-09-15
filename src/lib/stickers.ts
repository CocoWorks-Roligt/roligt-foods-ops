/**
 * Stickers: what can be printed at each stage, and what goes on the label.
 *
 * Every stage of the plant already mints its own identity — a receipt makes a lot,
 * an extraction makes a batch, a packing run makes packs against that batch, a
 * dispatch makes a challan. A sticker is just those facts printed on adhesive stock,
 * so nothing here invents an identity; it reads the ones the ledger already keeps.
 *
 * The catalogue below is the single source of truth for which fields exist. A
 * template says which of them print and what they are called, and the candidate
 * builders read the values off the records themselves.
 */

import {
  batchInputQty,
  batchInputUom,
  batchKind,
  batchLabel,
  fmtBulk,
  mainOutput,
  runBulkItem,
} from './batches'
import { formatSize } from './packs'
import { itemName, locationLabel, stockRows } from './stock'
import { fmtDate, inr, statusLabel, toDateKey } from './utils'
import type { AppState, StickerField, StickerStage, StickerTemplate } from '../types'

/** The stages, in the order the plant works through them. */
export const STICKER_STAGES: { stage: StickerStage; label: string; blurb: string }[] = [
  { stage: 'raw', label: 'Raw lots', blurb: 'Produce received on a GRN — tag the crates' },
  { stage: 'bulk', label: 'Bulk batches', blurb: 'What extraction and melanges made' },
  { stage: 'pack', label: 'Finished packs', blurb: 'Filled packs off a packing run' },
  { stage: 'material', label: 'Packing materials', blurb: 'Bottles, caps, boxes in store' },
  {
    stage: 'dispatch',
    label: 'Dispatch',
    blurb: 'The second label, put on before goods leave — its own MFG date and chilled life',
  },
]

export const stageLabel = (stage: StickerStage) =>
  STICKER_STAGES.find((s) => s.stage === stage)?.label || stage

/**
 * Every field a stage can print. Order here is the order they appear in the field
 * picker; a template's own order is what actually prints.
 */
export const STICKER_FIELDS: Record<StickerStage, { key: string; label: string }[]> = {
  raw: [
    { key: 'product', label: 'Produce' },
    { key: 'lot', label: 'Lot no' },
    { key: 'grn', label: 'GRN no' },
    { key: 'received', label: 'Received on' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'grower', label: 'Farmer' },
    { key: 'area', label: 'Farm / area' },
    { key: 'harvested', label: 'Harvested on' },
    { key: 'qty', label: 'Accepted qty' },
    { key: 'grades', label: 'Grades' },
    { key: 'store', label: 'Stored in' },
  ],
  bulk: [
    { key: 'product', label: 'Product' },
    { key: 'batch', label: 'Batch no' },
    { key: 'produced', label: 'Produced on' },
    { key: 'qty', label: 'Quantity' },
    { key: 'stage', label: 'Made by' },
    { key: 'input', label: 'Input' },
    { key: 'source', label: 'Source lots' },
    { key: 'qc', label: 'QC status' },
    { key: 'qcNo', label: 'QC no' },
  ],
  pack: [
    { key: 'product', label: 'Product' },
    { key: 'lot', label: 'Batch no' },
    { key: 'size', label: 'Net Wt' },
    { key: 'produced', label: 'MFG date' },
    { key: 'expiry', label: 'Best before' },
    { key: 'storage', label: 'Storage' },
    { key: 'run', label: 'Packing run' },
    { key: 'bulk', label: 'Filled from' },
    { key: 'packs', label: 'Packs in run' },
    { key: 'qc', label: 'QC status' },
  ],
  material: [
    { key: 'product', label: 'Material' },
    { key: 'lot', label: 'Lot no' },
    { key: 'qty', label: 'Quantity' },
    { key: 'store', label: 'Stored in' },
    { key: 'status', label: 'Status' },
  ],
  dispatch: [
    { key: 'product', label: 'Product' },
    { key: 'lot', label: 'Batch no' },
    { key: 'size', label: 'Net Wt' },
    { key: 'mfg', label: 'MFG date' },
    { key: 'bestBefore', label: 'Best before' },
    { key: 'mrp', label: 'MRP' },
    { key: 'consume', label: 'Once opened' },
    { key: 'storage', label: 'Storage' },
    { key: 'customer', label: 'Customer' },
    { key: 'shipTo', label: 'Ship to' },
    { key: 'challan', label: 'Challan no' },
    { key: 'qty', label: 'Quantity' },
    { key: 'vehicle', label: 'Vehicle' },
  ],
}

/** Printed by default — the rest are there to be switched on, not to clutter a label. */
const DEFAULT_ON: Record<StickerStage, string[]> = {
  raw: ['product', 'lot', 'received', 'supplier', 'qty', 'store'],
  bulk: ['product', 'batch', 'produced', 'qty', 'qc'],
  pack: ['product', 'lot', 'size', 'produced', 'expiry', 'storage'],
  material: ['product', 'lot', 'qty', 'store'],
  dispatch: ['product', 'lot', 'size', 'mfg', 'bestBefore', 'mrp', 'consume', 'storage'],
}

const DEFAULT_TITLE: Record<StickerStage, string> = {
  raw: 'RAW MATERIAL LOT',
  bulk: 'BULK BATCH',
  pack: 'PRODUCT LABEL',
  material: 'PACKING MATERIAL',
  dispatch: 'PRODUCT LABEL',
}

export function defaultTemplate(stage: StickerStage): StickerTemplate {
  return {
    stage,
    title: DEFAULT_TITLE[stage],
    fields: STICKER_FIELDS[stage].map((f) => ({
      key: f.key,
      label: f.label,
      show: DEFAULT_ON[stage].includes(f.key),
    })),
  }
}

export const defaultTemplates = (): StickerTemplate[] =>
  STICKER_STAGES.map((s) => defaultTemplate(s.stage))

/**
 * A stored template can predate a field being added, so it is reconciled against the
 * catalogue on read: unknown keys are dropped and new ones appended switched off.
 * Keeps a saved template working without a migration every time a field is added.
 */
export function templateFor(state: AppState, stage: StickerStage): StickerTemplate {
  const stored = state.stickerTemplates?.find((t) => t.stage === stage)
  const catalogue = STICKER_FIELDS[stage]
  if (!stored) return defaultTemplate(stage)
  const known = stored.fields.filter((f) => catalogue.some((c) => c.key === f.key))
  const missing: StickerField[] = catalogue
    .filter((c) => !known.some((f) => f.key === c.key))
    .map((c) => ({ key: c.key, label: c.label, show: false }))
  return { stage, title: stored.title || DEFAULT_TITLE[stage], fields: [...known, ...missing] }
}

/** One printable record: what it is, and every value its stage could print. */
export interface StickerCandidate {
  stage: StickerStage
  /** The lot / batch / run+sku / dispatch this sticker belongs to. */
  reference: string
  /** What the operator reads when picking it off the list. */
  heading: string
  sub: string
  /** Sorted newest-first by this. */
  when: string
  values: Record<string, string>
  /** Packs in the run, crates in the lot — what "one per pack" means for this record. */
  suggestedCopies: number
}

const dash = (v: string | number | undefined | null) => {
  const s = String(v ?? '').trim()
  return s || '—'
}

const dateOnly = (s?: string) => (s ? fmtDate(s.slice(0, 10)) : '—')

export function candidatesFor(state: AppState, stage: StickerStage): StickerCandidate[] {
  if (stage === 'raw') {
    return [...state.grns]
      .map((g) => ({
        stage,
        reference: g.lot,
        heading: `${g.lot} · ${g.productName || itemName(state, g.itemId || '')}`,
        // A one-off purchase has no vendor master, so the farmer's name is the supplier.
        // Printing "—" left a crate label with nothing saying where the produce came from.
        sub: `${g.id} · ${dash(g.farmerName || g.farmer)} · ${dateOnly(g.date)}`,
        when: g.date,
        suggestedCopies: 1,
        values: {
          product: dash(g.productName || itemName(state, g.itemId || '')),
          lot: g.lot,
          grn: g.id,
          received: dateOnly(g.date),
          supplier: dash(g.farmerName || g.farmer),
          grower: dash(g.farmer),
          area: dash(g.area),
          harvested: g.harvestedOn ? dateOnly(g.harvestedOn) : '—',
          qty: `${g.accepted} ${g.uom || 'Piece'}`,
          grades: `A ${g.a} · B ${g.b} · C ${g.c}`,
          store: locationLabel(state, g.location || 'RM Store'),
        },
      }))
      .sort((a, b) => b.when.localeCompare(a.when))
  }

  if (stage === 'bulk') {
    return [...state.batches]
      .map((b) => {
        const main = mainOutput(b)
        const name = batchLabel(state, b)
        const mainQc = state.qcs.find((q) => q.batchId === b.id && q.item === main?.item)
        return {
          stage,
          reference: b.id,
          heading: `${b.id} · ${name}`,
          sub: `${main ? fmtBulk(main.qty, main.uom) : '—'} · ${dateOnly(b.date)}`,
          when: b.date,
          suggestedCopies: 1,
          values: {
            product: dash(name),
            batch: b.id,
            produced: dateOnly(b.date),
            qty: main ? fmtBulk(main.qty, main.uom) : '—',
            stage: batchKind(b) === 'Melange' ? 'Melange (blend)' : 'Extraction',
            input: `${batchInputQty(b)} ${batchInputUom(b)}`,
            source: dash(
              [
                ...(b.sourceLines || []).map((l) => l.lot),
                ...(b.blendLines || []).map((l) => l.lot),
              ].join(', '),
            ),
            // The sticker goes on the tank of the batch's main output, so it carries
            // that product's verdict — not the batch roll-up, which can say "partly
            // released" about a drum that is squarely one or the other.
            qc: statusLabel(mainQc?.disposition || b.status),
            qcNo: dash(mainQc?.id || b.qcId),
          },
        }
      })
      .sort((a, b) => b.when.localeCompare(a.when))
  }

  if (stage === 'pack') {
    const out: StickerCandidate[] = []
    for (const run of state.packingRuns || []) {
      // A pack carries the verdict on the bulk it was filled from, not the batch's —
      // bottles of released water must not print "awaiting QC" because the malai from
      // the same pressing is still on the bench.
      const bulkQc = state.qcs.find(
        (q) => q.batchId === run.batchId && q.item === runBulkItem(run),
      )
      const batch = state.batches.find((b) => b.id === run.batchId)
      for (const line of run.lines) {
        const p = state.products.find((x) => x.id === line.sku)
        const name = p?.name || line.sku
        const size = p ? formatSize(p.size, p.unit) : ''
        out.push({
          stage,
          // A run can fill more than one pack, so the sticker belongs to the pair.
          reference: `${run.id}·${line.sku}`,
          heading: `${name}${size ? ` · ${size}` : ''}`,
          sub: `${run.id} · lot ${run.batchId} · ${line.packs} packs · exp ${dateOnly(line.expiry)}`,
          when: run.date,
          // One sticker per pack, which is what the run already counted.
          suggestedCopies: line.packs || 1,
          values: {
            product: dash(name),
            size: dash(size),
            lot: run.batchId,
            produced: dateOnly(run.date),
            expiry: dateOnly(line.expiry),
            run: run.id,
            bulk: dash(itemName(state, run.bulkItem || '')),
            packs: String(line.packs),
            storage: dash(state.config?.frozenStorageLine),
            qc: statusLabel(bulkQc?.disposition || batch?.status || run.status),
          },
        })
      }
    }
    return out.sort((a, b) => b.when.localeCompare(a.when))
  }

  if (stage === 'material') {
    return stockRows(state)
      .filter((r) => r.itemType === 'Packing Material' && r.qty > 0)
      .map((r) => ({
        stage,
        reference: `${r.item}·${r.lot}·${r.location}`,
        heading: `${itemName(state, r.item)} · ${r.lot}`,
        sub: `${Math.round(r.qty)} ${r.uom} · ${locationLabel(state, r.location)}`,
        when: r.lot,
        suggestedCopies: 1,
        values: {
          product: itemName(state, r.item),
          lot: r.lot,
          qty: `${Math.round(r.qty)} ${r.uom}`,
          store: locationLabel(state, r.location),
          status: statusLabel(r.status),
        },
      }))
      .sort((a, b) => a.heading.localeCompare(b.heading))
  }

  /**
   * The second label. Its dates are its own: the goods come out of the freezer as
   * they go, so manufacture is read as the day the label is made and the best-before
   * runs the pack's chilled life from there — not the three months it had frozen.
   * Printed fresh each time, which is why a reprint next week carries next week's
   * dates; the print history keeps whatever actually went out.
   */
  const today = new Date()
  return [...state.dispatches]
    .map((d) => {
      const p = state.products.find((x) => x.id === d.sku)
      const chilled = p?.chilledShelfLifeDays ?? 7
      const bestBefore = new Date(today.getTime() + chilled * 86400000)
      return {
        stage,
        reference: d.id,
        heading: `${itemName(state, d.sku)} · ${d.challan}`,
        sub: `${d.customerName} · ${d.qty} · ${dateOnly(d.dispatchTime)}`,
        when: d.dispatchTime,
        suggestedCopies: 1,
        values: {
          product: itemName(state, d.sku),
          lot: d.batchId,
          size: p ? formatSize(p.size, p.unit) : '—',
          mfg: fmtDate(toDateKey(today)),
          bestBefore: fmtDate(toDateKey(bestBefore)),
          mrp: p?.mrp ? inr(p.mrp) : '—',
          consume: dash(state.config?.consumeWithinLine),
          storage: dash(state.config?.chilledStorageLine),
          customer: dash(d.customerName),
          shipTo: dash(state.customers.find((c) => c.id === d.customerId)?.shipTo),
          challan: d.challan,
          qty: String(d.qty),
          expiry: d.expiry ? dateOnly(d.expiry) : '—',
          vehicle: dash(d.vehicle),
          dispatched: dateOnly(d.dispatchTime),
        },
      }
    })
    .sort((a, b) => b.when.localeCompare(a.when))
}

/** One record queued for printing, already resolved to the lines that will print. */
export interface StickerJob {
  stage: StickerStage
  reference: string
  title: string
  lines: { label: string; value: string }[]
  copies: number
}

/** The lines a template prints for one record, dropping anything switched off. */
export function stickerLines(template: StickerTemplate, values: Record<string, string>) {
  return template.fields
    .filter((f) => f.show)
    .map((f) => ({ label: f.label, value: values[f.key] ?? '—' }))
}

export const DEFAULT_STICKER_WIDTH_MM = 100
export const DEFAULT_STICKER_HEIGHT_MM = 50
