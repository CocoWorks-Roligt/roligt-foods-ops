/**
 * P5 fold tests: procurement (PO funnel, on-time, window filter) and
 * grading-extraction (grade mix, yield per 100, spoilage pareto, close stamps).
 * Pure folds over shaped state — no store.
 */
import { describe, expect, it } from 'vitest'
import { procurementKpis } from './procurement.ts'
import { gradingExtractionKpis } from './gradingExtraction.ts'
import { intermediatesBlendingKpis } from './intermediatesBlending.ts'
import { packingKpis } from './packing.ts'
import { qcKpis } from './qc.ts'
import { controlSamplesKpis } from './controlSamples.ts'
import { inventoryStorageKpis } from './inventoryStorage.ts'
import { packagingMaterialsKpis } from './packagingMaterials.ts'
import type { AppState, Batch, Grn, Product } from '../../types.ts'
import type { PurchaseOrder } from '../contracts.ts'

const W = { from: '2026-07-01', to: '2026-10-15' }

const grn = (over: Partial<Grn>): Grn =>
  ({
    id: 'GRN-1', lot: 'LOT-1', date: '2026-09-02', uom: 'Piece',
    total: 100, free: 0, a: 60, b: 20, c: 10, reject: 10, accepted: 90,
    rate: 30, transport: 200, landed: 3200, usableCost: 3200,
    ...over,
  }) as Grn

describe('procurementKpis', () => {
  const po = (over: Partial<PurchaseOrder>): PurchaseOrder =>
    ({ id: 'PO-1', number: 'PO/1', vendorId: 'V-1', lines: [], status: 'sent', receivedGrnIds: [], ...over })

  it('funnels PO statuses in machine order and counts open POs', () => {
    const state = {
      grns: [],
      vendors: [],
      items: [],
      purchase_orders: [
        po({ id: 'PO-1', status: 'draft' }),
        po({ id: 'PO-2', status: 'sent', expectedOn: '2026-09-01' }),
        po({ id: 'PO-3', status: 'received', expectedOn: '2026-08-01' }),
        po({ id: 'PO-4', status: 'cancelled', expectedOn: '2026-08-02' }),
      ],
    } as unknown as Partial<AppState>
    const out = procurementKpis(state, W, '2026-10-15')
    const funnel = out.charts.find((c) => c.key === 'proc-po-funnel')
    expect(funnel?.rows.map((r) => `${r.label}:${r.value}`)).toEqual(['Draft:1', 'Sent:1', 'Acknowledged:0', 'Received:1', 'Closed:0'])
    expect(out.cards.find((c) => c.key === 'proc-open-pos')?.value).toBe(2)
  })

  it('on-time judges the FIRST linked receipt against the promised day', () => {
    const state = {
      grns: [grn({ id: 'GRN-EARLY', date: '2026-08-31' }), grn({ id: 'GRN-LATE', date: '2026-09-05' })],
      vendors: [{ id: 'V-1', name: 'Green Farms' }],
      items: [],
      purchase_orders: [
        po({ id: 'PO-OK', status: 'received', expectedOn: '2026-09-01', receivedGrnIds: ['GRN-EARLY'] }),
        po({ id: 'PO-LATE', status: 'received', expectedOn: '2026-09-01', receivedGrnIds: ['GRN-LATE'] }),
      ],
    } as unknown as Partial<AppState>
    const out = procurementKpis(state, W, '2026-10-15')
    expect(out.cards.find((c) => c.key === 'proc-ontime')?.value).toBe(50)
    const byVendor = out.charts.find((c) => c.key === 'proc-vendor-ontime')
    expect(byVendor?.rows).toEqual([{ label: 'Green Farms', value: 50 }])
  })

  it('windows receipts for spend and intake; fruit stays out of coconut intake', () => {
    const state = {
      grns: [
        grn({ id: 'GRN-IN', date: '2026-09-02', landed: 1000, farmerName: 'Green Farms' }),
        grn({ id: 'GRN-OUT', date: '2026-05-01', landed: 9999 }),
        grn({ id: 'GRN-FRUIT', date: '2026-09-03', itemId: 'RM-BEET', landed: 500, accepted: 40 }),
      ],
      vendors: [{ id: 'V-1', name: 'Green Farms' }],
      items: [],
      purchase_orders: [],
    } as unknown as Partial<AppState>
    const out = procurementKpis(state, W, '2026-10-15')
    // Spend counts every receipt (fruit included — it is procurement spend);
    // the May receipt is outside the window.
    expect(out.cards.find((c) => c.key === 'proc-spend')?.value).toBe(1500)
    const intake = out.charts.find((c) => c.key === 'proc-coconut-intake')
    expect(intake?.rows).toEqual([{ label: 'Green Farms', value: 90 }]) // 90 accepted nuts, fruit excluded
  })
})

describe('gradingExtractionKpis', () => {
  // Loose overrides on purpose: the seeds carry close stamps (stageTimes,
  // massBalance) and lean run lines the full wire types would demand verbatim.
  const batch = (over: Record<string, unknown>): Batch =>
    ({ id: 'BAT-2026-0001', date: '2026-09-02', kind: 'Extraction', sourceLines: [], outputLines: [], ...over }) as unknown as Batch

  it('grade mix, reject trend, and the window filter', () => {
    const state = {
      grns: [
        grn({ lot: 'LOT-1', date: '2026-09-02', a: 60, b: 20, c: 10, reject: 10 }),
        grn({ lot: 'LOT-2', date: '2026-04-01', a: 100, b: 0, c: 0, reject: 0 }),
        grn({ lot: 'LOT-3', date: '2026-09-04', itemId: 'RM-BEET', a: 0, b: 0, c: 0, reject: 5 }),
      ],
      batches: [],
      items: [],
      spoilage_records: [],
    } as unknown as Partial<AppState>
    const out = gradingExtractionKpis(state, W, '2026-10-15')
    const mix = out.charts.find((c) => c.key === 'ge-grade-mix-trend')
    const sep = mix?.rows.filter((r) => r.label === '2026-09')
    expect(sep?.find((r) => r.series === 'A')?.value).toBe(60)
    expect(sep?.find((r) => r.series === 'Reject')?.value).toBe(10)
    expect(mix?.rows.some((r) => r.label === '2026-04')).toBe(false)
    // Reject % counts coconut lots only: 10 / (60+20+10+10).
    expect(out.cards.find((c) => c.key === 'ge-reject-pct')?.value).toBe(10)
  })

  it('yield per 100 from the run lines, malai uom Kg included', () => {
    const state = {
      grns: [],
      batches: [
        batch({
          sourceLines: [{ lot: 'LOT-1', qty: 200, uom: 'Piece' }],
          outputLines: [
            { item: 'ITM-WATER', qty: 80, uom: 'L' },
            { item: 'ITM-MALAI', qty: 30, uom: 'Kg' },
          ],
        }),
      ],
      items: [],
      spoilage_records: [],
    } as unknown as Partial<AppState>
    const out = gradingExtractionKpis(state, W, '2026-10-15')
    const y = out.charts.find((c) => c.key === 'ge-yield-per-100')
    expect(y?.rows.find((r) => r.series === 'Water (L)')?.value).toBe(40) // 80L per 2×100 nuts
    expect(y?.rows.find((r) => r.series === 'Malai (kg)')?.value).toBe(15)
  })

  it('spoilage pareto sorts desc and close stamps feed variance + cycle time', () => {
    const state = {
      grns: [],
      batches: [
        batch({
          id: 'BAT-2026-0001',
          stageTimes: { started: '2026-09-02T02:00:00Z', closed: '2026-09-02T06:00:00Z' },
          massBalance: { inputBaseUnits: 100, outputBaseUnits: 97, variancePct: -3, withinTolerance: true },
        }),
      ],
      items: [],
      spoilage_records: [
        { id: 'SP-1', batchId: 'BAT-2026-0001', stage: 'extraction', qty: 5, uom: 'Piece', reasonCode: 'rotten', at: '2026-09-02T06:00:00Z', actor: 'a' },
        { id: 'SP-2', batchId: 'BAT-2026-0001', stage: 'extraction', qty: 9, uom: 'Piece', reasonCode: 'cracked', at: '2026-09-02T06:00:00Z', actor: 'a' },
        { id: 'SP-3', batchId: 'BAT-GONE', stage: 'extraction', qty: 99, uom: 'Piece', reasonCode: 'rotten', at: '2026-09-02T06:00:00Z', actor: 'a' },
      ],
    } as unknown as Partial<AppState>
    const out = gradingExtractionKpis(state, W, '2026-10-15')
    const pareto = out.charts.find((c) => c.key === 'ge-spoilage-pareto')
    expect(pareto?.rows).toEqual([
      { label: 'cracked', value: 9 },
      { label: 'rotten', value: 5 },
    ])
    const variance = out.charts.find((c) => c.key === 'ge-mass-balance-variance')
    expect(variance?.rows).toEqual([{ label: 'BAT-2026-0001', value: -3 }])
    const cycle = out.charts.find((c) => c.key === 'ge-cycle-time')
    expect(cycle?.rows?.[0]?.value).toBe(4)
  })
})

describe('intermediatesBlendingKpis', () => {
  const run = (over: Record<string, unknown>): Batch =>
    ({ id: 'BAT-2026-0002', date: '2026-09-02', kind: 'Melange', blendLines: [], outputLines: [], ...over }) as unknown as Batch
  const led = (over: Record<string, unknown>) =>
    ({ id: 'LED-1', doc: 'D-1', type: 'Batch', qtyIn: 0, qtyOut: 0, unitCost: 1, ...over })

  it('counts net-new output (outputs − drawn), splits open vs closed, windows runs', () => {
    const state = {
      batches: [
      run({ blendLines: [{ item: 'SF-A', lot: 'BAT-1', qty: 100, uom: 'Litre' }], outputLines: [{ item: 'SF-ABC', qty: 120, uom: 'Litre', costShare: 100 }], status: 'Released' }),
      run({ blendLines: [{ item: 'SF-A', lot: 'BAT-1', qty: 50, uom: 'Litre' }], outputLines: [{ item: 'SF-ABC', qty: 50, uom: 'Litre', costShare: 100 }], status: 'Awaiting QC' }),
      run({ date: '2026-04-01', status: 'Closed', outputLines: [{ item: 'SF-ABC', qty: 999, uom: 'Litre', costShare: 100 }] }),
      ],
      items: [{ id: 'SF-ABC', name: 'ABC Blend', uom: 'Litre' }],
      melanges: [],
      productionPlans: [],
      ledger: [],
    } as unknown as Partial<AppState>
    const out = intermediatesBlendingKpis(state, W, '2026-10-15')
    const trend = out.charts.find((c) => c.key === 'ib-blend-output-trend')
    expect(trend?.rows).toEqual([{ series: 'Net new (L)', label: '2026-09', value: 20 }]) // (120−100) + (50−50)
    expect(out.cards.find((c) => c.key === 'ib-blend-runs')?.value).toBe(2)
    expect(out.cards.find((c) => c.key === 'ib-blend-net-new')?.value).toBe(20)
    expect(out.cards.find((c) => c.key === 'ib-open-blends')?.value).toBe(1) // Awaiting QC open; Released closed
    expect(out.charts.find((c) => c.key === 'ib-runs-by-status')?.rows).toEqual([
      { label: 'Open', value: 1 },
      { label: 'Closed', value: 2 }, // the April run is closed too — the queue is a position
    ])
  })

  it('recipe variance is the drawn share minus the recipe share, absent components included', () => {
    const state = {
      batches: [
      run({ melangeId: 'MEL-1', blendLines: [{ item: 'SF-A', lot: 'BAT-1', qty: 100, uom: 'Litre' }] }),
      ],
      items: [{ id: 'SF-A', name: 'Water' }, { id: 'SF-B', name: 'Malai' }],
      melanges: [{ id: 'MEL-1', name: 'ABC', outputItem: 'SF-ABC', uom: 'Litre', components: [{ item: 'SF-A', share: 60 }, { item: 'SF-B', share: 40 }], description: '', status: 'active' }],
      productionPlans: [],
      ledger: [],
    } as unknown as Partial<AppState>
    const out = intermediatesBlendingKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'ib-recipe-variance')?.rows).toEqual([
      { label: 'Malai', value: -40 }, // recipe lists it, the run drew none
      { label: 'Water', value: 40 }, // drew 100%, recipe says 60
    ])
  })

  it('intermediate stock is a position off the ledger, near-expiry counts ≤30d and past', () => {
    const state = {
      batches: [],
      items: [{ id: 'SF-ABC', name: 'ABC Blend', uom: 'Litre' }],
      melanges: [],
      productionPlans: [],
      ledger: [
      led({ item: 'SF-ABC', itemType: 'Semi Finished', lot: 'BAT-1', location: 'Cold Room', status: 'Released', uom: 'Litre', qtyIn: 120, expiry: '2026-10-20' }),
      led({ item: 'SF-ABC', itemType: 'Semi Finished', lot: 'BAT-2', location: 'Cold Room', status: 'Released', uom: 'Litre', qtyIn: 80, expiry: '2026-12-15' }),
      led({ item: 'SF-ABC', itemType: 'Semi Finished', lot: 'BAT-3', location: 'Cold Room', status: 'Released', uom: 'Litre', qtyIn: 10, expiry: '2026-10-01' }),
      led({ item: 'FG-X', itemType: 'Finished Goods', lot: 'PKG-1', location: 'Cold Room', status: 'Released', uom: 'Packs', qtyIn: 500, expiry: '2026-10-20' }),
      ],
    } as unknown as Partial<AppState>
    const out = intermediatesBlendingKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'ib-intermediate-stock')?.rows).toEqual([
      { label: 'ABC Blend (L)', value: 210 },
    ])
    expect(out.cards.find((c) => c.key === 'ib-near-expiry')?.value).toBe(2) // 10-20 and already-expired; FG never counts
  })

  it('planned vs made totals by month and uom; other stages and cancellations never answer', () => {
    const state = {
      batches: [run({ blendLines: [], outputLines: [{ item: 'SF-ABC', qty: 120, uom: 'Litre', costShare: 100 }] })],
      items: [],
      melanges: [],
      productionPlans: [
      { id: 'P-1', date: '2026-09-02', stage: 'Melange', product: 'ABC', qty: 500, uom: 'Litre', status: 'Planned', createdOn: '2026-09-01' },
      { id: 'P-2', date: '2026-09-03', stage: 'Melange', product: 'ABC', qty: 99, uom: 'Litre', status: 'Cancelled', createdOn: '2026-09-01' },
      { id: 'P-3', date: '2026-09-04', stage: 'Packing', product: 'ABC', qty: 70, uom: 'Packs', status: 'Planned', createdOn: '2026-09-01' },
      ],
      ledger: [],
    } as unknown as Partial<AppState>
    const out = intermediatesBlendingKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'ib-plan-vs-actual')?.rows).toEqual([
      { series: 'Planned (L)', label: '2026-09', value: 500 },
      { series: 'Made (L)', label: '2026-09', value: 120 },
    ])
  })
})

describe('packingKpis', () => {
  const product = (over: Record<string,unknown>): Product =>
    ({ id: 'FG-1', name: 'TCW 250ml', type: 'Glass Bottle', size: 250, unit: 'ml', packVolume: 0.25, shelfLifeDays: 30, bom: [], ...over }) as unknown as Product
  const runIn = (over: Record<string, unknown>) =>
    ({ id: 'PKG-2026-0001', date: '2026-09-05', batchId: 'BAT-1', medium: 'Water', lines: [], drawn: 0, pmCost: 0, bulkCost: 0, status: 'Posted', ...over })

  it('throughput and packed-vs-planned count Packs-uom packing plans only', () => {
    const state = {
      packingRuns: [
      runIn({ lines: [{ sku: 'FG-1', packs: 30, drawn: 7.5, qty: 30, unitCost: 10, expiry: '2026-11-05' }] }),
      runIn({ id: 'PKG-2026-0002', date: '2026-08-02', lines: [{ sku: 'FG-1', packs: 10, drawn: 2.5, qty: 10, unitCost: 10, expiry: '2026-10-02' }] }),
      runIn({ id: 'PKG-2026-0003', date: '2026-04-01', lines: [{ sku: 'FG-1', packs: 99, drawn: 9, qty: 99, unitCost: 10, expiry: '2026-10-02' }] }),
      ],
      productionPlans: [
      { id: 'P-1', date: '2026-09-01', stage: 'Packing', product: 'TCW 250ml', qty: 100, uom: 'Packs', status: 'Planned', createdOn: '2026-08-30' },
      { id: 'P-2', date: '2026-09-02', stage: 'Packing', product: 'TCW', qty: 400, uom: 'Litre', status: 'Planned', createdOn: '2026-08-30' },
      { id: 'P-3', date: '2026-09-03', stage: 'Packing', product: 'TCW 250ml', qty: 50, uom: 'Packs', status: 'Cancelled', createdOn: '2026-08-30' },
      { id: 'P-4', date: '2026-09-04', stage: 'Melange', product: 'ABC', qty: 70, uom: 'Packs', status: 'Planned', createdOn: '2026-08-30' },
      ],
      products: [product({})],
      spoilage_records: [],
    } as unknown as Partial<AppState>
    const out = packingKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'pk-throughput')?.rows).toEqual([
      { label: '2026-08', value: 10 },
      { label: '2026-09', value: 30 },
    ])
    expect(out.charts.find((c) => c.key === 'pk-packed-vs-planned')?.rows).toEqual([
      { series: 'Planned', label: '2026-08', value: 0 },
      { series: 'Packed', label: '2026-08', value: 10 },
      { series: 'Planned', label: '2026-09', value: 100 },
      { series: 'Packed', label: '2026-09', value: 30 },
    ])
    expect(out.cards.find((c) => c.key === 'pk-packs')?.value).toBe(40)
  })

  it('format mix reads a stamped packFormat first, else the backfill derivation; size mix uses packLabel', () => {
    const state = {
      packingRuns: [
      runIn({ lines: [
        { sku: 'FG-BIB', packs: 40, drawn: 200, qty: 40, unitCost: 10, expiry: '2026-11-05' },
        { sku: 'FG-BOX', packs: 60, drawn: 300, qty: 60, unitCost: 10, expiry: '2026-11-05' },
        { sku: 'FG-GLASS', packs: 100, drawn: 25, qty: 100, unitCost: 10, expiry: '2026-11-05' },
      ] }),
      ],
      productionPlans: [],
      products: [
      product({ id: 'FG-BIB', name: 'TCW 5L', type: 'BiB', size: 5, unit: 'L', packVolume: 5, packName: '5 L BiB' }),
      // Stamped field wins even where the name would derive the other way.
      product({ id: 'FG-BOX', name: 'TCW 5L C-Box', type: 'C-Box', size: 5, unit: 'L', packVolume: 5, packFormat: 'bib' as const }),
      product({ id: 'FG-GLASS', name: 'TCW 250ml', type: 'Glass Bottle' }),
      ],
      spoilage_records: [],
    } as unknown as Partial<AppState>
    const out = packingKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'pk-format-mix')?.rows).toEqual([
      { label: 'bib', value: 100 }, // 40 stamped-none-derived + 60 stamped packFormat
      { label: 'glass', value: 100 },
    ])
    expect(out.cards.find((c) => c.key === 'pk-bib-share')?.value).toBe(50)
    expect(out.charts.find((c) => c.key === 'pk-size-mix')?.rows).toEqual([
      { label: '250 ml Glass Bottle', value: 100 },
      { label: '5 L C-Box', value: 60 },
      { label: '5 L BiB', value: 40 },
    ])
  })

  it('fill-stage spoilage pareto sorts desc, other stages and windows stay out', () => {
    const state = {
      packingRuns: [],
      productionPlans: [],
      products: [],
      spoilage_records: [
      { id: 'SP-1', batchId: 'B-1', stage: 'fill', qty: 3, uom: 'L', reasonCode: 'spillage', at: '2026-09-02T06:00:00Z', actor: 'a' },
      { id: 'SP-2', batchId: 'B-1', stage: 'fill', qty: 7, uom: 'L', reasonCode: 'burst_pouch', at: '2026-09-03T06:00:00Z', actor: 'a' },
      { id: 'SP-3', batchId: 'B-1', stage: 'blend', qty: 99, uom: 'L', reasonCode: 'spillage', at: '2026-09-03T06:00:00Z', actor: 'a' },
      { id: 'SP-4', batchId: 'B-1', stage: 'fill', qty: 50, uom: 'L', reasonCode: 'spillage', at: '2026-04-01T06:00:00Z', actor: 'a' },
      ],
    } as unknown as Partial<AppState>
    const out = packingKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'pk-fill-spoilage')?.rows).toEqual([
      { label: 'burst_pouch', value: 7 },
      { label: 'spillage', value: 3 },
    ])
    expect(out.cards.find((c) => c.key === 'pk-fill-spoilage')?.value).toBe(2)
  })
})

/** P5 D3a: qc full build (turnaround, failed tests, quarantine position) and
 * the control-samples fold (expiry timeline, due count, destructions). */
describe('qcKpis D3a', () => {
  const qc = (over: Record<string, unknown>) => ({
    id: 'QC-1', batchId: 'BAT-1', micro: 'Pass', pesticides: 'Pass',
    heavyMetals: 'Pass', physico: 'Pass', disposition: 'Released',
    reviewedBy: 'q', reviewedAt: '', ...over,
  })
  const batches = [{ id: 'BAT-1', date: '2026-09-01', status: 'Released' }]

  it('turnaround averages decided records only, batch day → review day', () => {
    const state = {
      qcs: [
        qc({ id: 'QC-1', disposition: 'Released', reviewedAt: '2026-09-03T10:00:00' }),
        qc({ id: 'QC-2', disposition: 'Rejected', reviewedAt: '2026-09-05T10:00:00' }),
        qc({ id: 'QC-3', disposition: 'Retest', reviewedAt: '2026-09-02T10:00:00' }),
        qc({ id: 'QC-4', disposition: 'Pending' }),
      ],
      batches,
      items: [],
    } as unknown as Partial<AppState>
    const out = qcKpis(state, W, '2026-10-15')
    // (2 + 4) / 2 — the Retest and the Pending record never answer.
    expect(out.cards.find((c) => c.key === 'qc-turnaround')?.value).toBe(3)
    expect(out.charts.find((c) => c.key === 'qc-turnaround')?.rows).toEqual([{ label: '2026-09', value: 3 }])
  })

  it('failed tests count by category, legacy fields and added tests alike', () => {
    const state = {
      qcs: [
        qc({ id: 'QC-1', micro: 'Fail', disposition: 'Rejected', reviewedAt: '2026-09-02T10:00:00' }),
        qc({ id: 'QC-2', tests: { sensory: { status: 'Fail' } }, disposition: 'Rejected', reviewedAt: '2026-09-02T10:00:00' }),
      ],
      batches,
      items: [],
    } as unknown as Partial<AppState>
    const out = qcKpis(state, W, '2026-10-15')
    const rows = out.charts.find((c) => c.key === 'qc-failed-tests')?.rows ?? []
    expect(rows).toContainEqual({ label: 'Microbiology', value: 1 })
    expect(rows).toContainEqual({ label: 'Sensory Evaluation', value: 1 })
  })

  it('quarantine is a position: staged lots in, verdicts out, uom on the label', () => {
    const ledger = (id: string, lot: string, status: string, qtyIn: number, qtyOut = 0, uom = 'Piece') =>
      ({ id, type: 'Receipt', doc: 'GRN-1', item: 'COCO', itemType: 'Raw', lot, location: 'Hold Area',
         status, qtyIn, qtyOut, uom, unitCost: 10, time: '2026-09-01T08:00:00' })
    const state = {
      qcs: [], batches, items: [{ id: 'COCO', name: 'Coconuts' }],
      ledger: [
        ledger('L1', 'LOT-1', 'Quarantine', 100),
        ledger('L2', 'LOT-2', 'Quarantine', 50),
        ledger('L3', 'LOT-3', 'Released', 500),
      ],
    } as unknown as Partial<AppState>
    const out = qcKpis(state, W, '2026-10-15')
    expect(out.cards.find((c) => c.key === 'qc-quarantine-lots')?.value).toBe(2)
    expect(out.charts.find((c) => c.key === 'qc-quarantine')?.rows).toEqual([
      { label: 'Coconuts (Piece)', value: 150 },
    ])
  })
})

describe('controlSamplesKpis', () => {
  const run = (over: Record<string, unknown>) => ({
    id: 'RUN-1', date: '2026-09-01T06:00:00', batchId: 'BAT-1', medium: 'Water',
    lines: [], drawn: 10, pmCost: 0, bulkCost: 0, status: 'Completed', ...over,
  })
  const state = {
    packingRuns: [
      run({ id: 'RUN-1', controlSamples: [{ sku: 'P-1', count: 2, expiresOn: '2026-09-05' }] }),
      run({
        id: 'RUN-2', date: '2026-09-20T06:00:00', bulkItem: 'BULK-1',
        controlSamples: [
          { count: 1, expiresOn: '2026-10-18' },
          { sku: 'P-1', count: 3, expiresOn: '2026-11-20', destroyedOn: '2026-10-01' },
        ],
      }),
    ],
    products: [{ id: 'P-1', name: '200 ml Tender' }],
    items: [{ id: 'BULK-1', name: 'Coco Bulk' }],
  } as unknown as Partial<AppState>

  it('counts kept/due/expired/destroyed off the register and the tile predicate', () => {
    const out = controlSamplesKpis(state, W, '2026-10-15')
    expect(out.cards.find((c) => c.key === 'cs-kept')?.value).toBe(2)
    expect(out.cards.find((c) => c.key === 'cs-due')?.value).toBe(2) // 09-05 past, 10-18 inside 7 d
    expect(out.cards.find((c) => c.key === 'cs-expired')?.value).toBe(1)
    expect(out.cards.find((c) => c.key === 'cs-destroyed')?.value).toBe(1)
  })

  it('expiry timeline charts kept samples by expiry month, destructions by their day', () => {
    const out = controlSamplesKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'cs-expiry-timeline')?.rows).toEqual([
      { label: '2026-09', value: 1 },
      { label: '2026-10', value: 1 },
    ])
    expect(out.charts.find((c) => c.key === 'cs-destructions')?.rows).toEqual([{ label: '2026-10', value: 1 }])
  })

  it('product mix windows by the run day and names bulk containers too', () => {
    const out = controlSamplesKpis(state, W, '2026-10-15')
    const rows = out.charts.find((c) => c.key === 'cs-by-product')?.rows ?? []
    expect(rows).toContainEqual({ label: '200 ml Tender', value: 2 })
    expect(rows).toContainEqual({ label: 'Coco Bulk', value: 1 })
  })
})

/** P5 D4a: inventory/storage (position value, cold-room heatmap, ageing,
 * near-expiry FG, loose BIB by size, slow-moving) and packaging materials
 * (stock vs reorder, consumption by month and uom — itemFlows' own engine). */
describe('inventoryStorageKpis', () => {
  const led = (over: Record<string, unknown>) =>
    ({ id: 'LED-1', doc: 'D-1', type: 'Receipt', qtyIn: 0, qtyOut: 0, unitCost: 1, time: '2026-09-01T08:00:00', ...over })

  it('value by category and the cold-room heatmap are the position; near-expiry is Released FG only', () => {
    const state = {
      ledger: [
        led({ id: 'L1', item: 'RM-COCO', itemType: 'Raw', lot: 'LOT-1', location: 'Dry Store', status: 'Available', uom: 'Piece', qtyIn: 100, unitCost: 10 }),
        led({ id: 'L2', item: 'FG-A', itemType: 'Finished Goods', lot: 'PKG-1', location: 'CR-1', status: 'Released', uom: 'Packs', qtyIn: 50, unitCost: 4, expiry: '2026-10-18' }),
        led({ id: 'L3', item: 'FG-B', itemType: 'Finished Goods', lot: 'PKG-2', location: 'CR-1', status: 'Released', uom: 'Packs', qtyIn: 30, unitCost: 4, expiry: '2026-12-01' }),
        led({ id: 'L4', item: 'FG-C', itemType: 'Finished Goods', lot: 'PKG-3', location: 'CR-1', status: 'Quarantine', uom: 'Packs', qtyIn: 99, unitCost: 4, expiry: '2026-10-16' }),
      ],
      items: [
        { id: 'RM-COCO', name: 'Coconuts', type: 'Raw Material', uom: 'Piece' },
        { id: 'FG-A', name: 'TCW 250ml', type: 'Finished Goods', uom: 'Packs' },
        { id: 'FG-B', name: 'TCW 5L', type: 'Finished Goods', uom: 'Packs' },
        { id: 'FG-C', name: 'TCW 2.5L', type: 'Finished Goods', uom: 'Packs' },
      ],
      storageLocations: [{ id: 'S1', name: 'CR-1', label: 'Cold room 1', holds: '', type: 'Cold Room', status: 'Active' }],
      products: [],
      grns: [],
      config: { expiryAlertDays: 7 },
    } as unknown as Partial<AppState>
    const out = inventoryStorageKpis(state, W, '2026-10-15')
    // Held stock is still on hand: 1000 + 200 + 120 + 396.
    expect(out.cards.find((c) => c.key === 'inv-stock-value')?.value).toBe(1716)
    expect(out.cards.find((c) => c.key === 'inv-lines')?.value).toBe(4)
    // Near-expiry counts Released FG only: FG-A (3 d) is in, quarantined FG-C is out.
    expect(out.cards.find((c) => c.key === 'inv-near-expiry')?.value).toBe(1)
    expect(out.charts.find((c) => c.key === 'inv-value-by-category')?.rows).toEqual([
      { label: 'Raw', value: 1000 },
      { label: 'Finished Goods', value: 716 },
    ])
    expect(out.charts.find((c) => c.key === 'inv-coldroom-occupancy')?.rows).toEqual([
      { series: 'Finished Goods', label: 'Cold room 1', value: 716 },
    ])
    expect(out.charts.find((c) => c.key === 'inv-fg-expiry')?.rows).toEqual([
      { label: '≤ 7 d', value: 1 },
      { label: '> 30 d', value: 1 },
    ])
  })

  it('ageing rides lotAgeing buckets; slow-moving is no line on the row for 30+ days', () => {
    const state = {
      ledger: [
        led({ id: 'L1', item: 'RM-COCO', itemType: 'Raw', lot: 'LOT-FRESH', location: 'Dry Store', status: 'Available', uom: 'Piece', qtyIn: 80, unitCost: 10, time: '2026-10-14T08:00:00' }),
        led({ id: 'L2', item: 'RM-COCO', itemType: 'Raw', lot: 'LOT-OLD', location: 'Dry Store', status: 'Available', uom: 'Piece', qtyIn: 100, unitCost: 10, time: '2026-09-05T08:00:00' }),
      ],
      items: [{ id: 'RM-COCO', name: 'Coconuts', type: 'Raw Material', uom: 'Piece' }],
      storageLocations: [],
      products: [],
      grns: [
        { id: 'GRN-1', lot: 'LOT-FRESH', date: '2026-10-14', uom: 'Piece' },
        { id: 'GRN-2', lot: 'LOT-OLD', date: '2026-09-05', uom: 'Piece' },
      ],
      config: { expiryAlertDays: 7 },
    } as unknown as Partial<AppState>
    const out = inventoryStorageKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'inv-ageing')?.rows).toEqual([
      { series: 'Piece', label: '0–3 days', value: 80 },
      { series: 'Piece', label: '15+ days', value: 100 },
    ])
    expect(out.cards.find((c) => c.key === 'inv-aged-lots')?.value).toBe(1)
    expect(out.cards.find((c) => c.key === 'inv-slow-moving')?.value).toBe(1)
  })

  it('loose BIB stock by size counts BIB finished goods only, glass and bulk out', () => {
    const state = {
      ledger: [
        led({ id: 'L1', item: 'FG-BIB5', itemType: 'Finished Goods', lot: 'PKG-1', location: 'CR-1', status: 'Released', uom: 'Packs', qtyIn: 40, unitCost: 10, expiry: '2026-11-05' }),
        led({ id: 'L2', item: 'FG-BIB25', itemType: 'Finished Goods', lot: 'PKG-2', location: 'CR-1', status: 'Released', uom: 'Packs', qtyIn: 10, unitCost: 10, expiry: '2026-11-05' }),
        led({ id: 'L3', item: 'FG-GLASS', itemType: 'Finished Goods', lot: 'PKG-3', location: 'CR-1', status: 'Released', uom: 'Packs', qtyIn: 60, unitCost: 10, expiry: '2026-11-05' }),
        led({ id: 'L4', item: 'BULK', itemType: 'Semi Finished', lot: 'BAT-1', location: 'CR-1', status: 'Released', uom: 'Litre', qtyIn: 500, unitCost: 10, expiry: '2026-11-05' }),
      ],
      items: [
        { id: 'FG-BIB5', name: 'TCW 5L', type: 'Finished Goods', uom: 'Packs' },
        { id: 'FG-BIB25', name: 'TCW 2.5L', type: 'Finished Goods', uom: 'Packs' },
        { id: 'FG-GLASS', name: 'TCW 250ml', type: 'Finished Goods', uom: 'Packs' },
        { id: 'BULK', name: 'Coco Bulk', type: 'Semi Finished', uom: 'Litre' },
      ],
      storageLocations: [],
      products: [
        { id: 'FG-BIB5', name: 'TCW 5L', type: 'BiB', size: 5, unit: 'L', packVolume: 5, packName: '5 L BiB' },
        { id: 'FG-BIB25', name: 'TCW 2.5L', type: 'BiB', size: 2.5, unit: 'L', packVolume: 2.5, packName: '2.5 L BiB' },
        { id: 'FG-GLASS', name: 'TCW 250ml', type: 'Glass Bottle', size: 250, unit: 'ml', packVolume: 0.25 },
      ],
      grns: [],
      config: { expiryAlertDays: 7 },
    } as unknown as Partial<AppState>
    const out = inventoryStorageKpis(state, W, '2026-10-15')
    expect(out.charts.find((c) => c.key === 'inv-bib-by-size')?.rows).toEqual([
      { label: '5 L BiB', value: 40 },
      { label: '2.5 L BiB', value: 10 },
    ])
  })
})

describe('packagingMaterialsKpis', () => {
  const led = (over: Record<string, unknown>) =>
    ({ id: 'LED-1', doc: 'D-1', type: 'PM Receipt', qtyIn: 0, qtyOut: 0, unitCost: 1, time: '2026-09-01T08:00:00', ...over })

  it('position and window ride itemFlows: below-reorder at today, received only in window', () => {
    const state = {
      items: [
        { id: 'PM-BOT', name: 'Bottle 250ml', type: 'Packing Material', uom: 'No', reorder: 100 },
        { id: 'PM-CAP', name: 'Crown cap', type: 'Packing Material', uom: 'No', reorder: 500 },
        { id: 'PM-LBL', name: 'Label', type: 'Packing Material', uom: 'No', reorder: 0 },
      ],
      ledger: [
        led({ id: 'L0', item: 'PM-LBL', qtyIn: 100, unitCost: 1, lot: 'PM-3', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-09-01T08:00:00' }),
        led({ id: 'L1', item: 'PM-BOT', qtyIn: 1000, unitCost: 2, lot: 'PM-1', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-09-01T08:00:00' }),
        led({ id: 'L2', item: 'PM-BOT', type: 'Packing Consume', qtyOut: 400, unitCost: 2, lot: 'PM-1', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-09-10T08:00:00' }),
        led({ id: 'L3', item: 'PM-CAP', qtyIn: 600, unitCost: 0.5, lot: 'PM-2', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-09-02T08:00:00' }),
        led({ id: 'L4', item: 'PM-CAP', type: 'Packing Consume', qtyOut: 200, unitCost: 0.5, lot: 'PM-2', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-09-11T08:00:00' }),
        led({ id: 'L5', item: 'PM-LBL', type: 'Stock Issue', qtyOut: 50, unitCost: 1, lot: 'PM-3', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-09-12T08:00:00' }),
        // Outside the window: opening balance only, never a windowed receipt.
        led({ id: 'L6', item: 'PM-BOT', qtyIn: 99, unitCost: 2, lot: 'PM-4', location: 'Dry Store', status: 'Available', uom: 'No', time: '2026-05-01T08:00:00' }),
        // A raw-material line the PM fold never sees.
        led({ id: 'L7', item: 'RM-X', type: 'Receipt', qtyIn: 500, unitCost: 3, lot: 'LOT-1', location: 'Dry Store', status: 'Available', uom: 'Piece', time: '2026-09-01T08:00:00' }),
      ],
    } as unknown as Partial<AppState>
    const out = packagingMaterialsKpis(state, W, '2026-10-15')
    expect(out.cards.find((c) => c.key === 'pm-below-reorder')?.value).toBe(1) // cap 400 < 500; bottle 699 > 100
    expect(out.cards.find((c) => c.key === 'pm-stocked')?.value).toBe(3)
    expect(out.cards.find((c) => c.key === 'pm-value')?.value).toBe(1648) // 699×2 + 400×0.5 + 50×1
    expect(out.cards.find((c) => c.key === 'pm-received')?.value).toBe(3) // the May receipt never counts
    expect(out.charts.find((c) => c.key === 'pm-consumption')?.rows).toEqual([
      { series: 'No', label: '2026-09', value: 650 },
    ])
    expect(out.charts.find((c) => c.key === 'pm-most-consumed')?.rows).toEqual([
      { label: 'Bottle 250ml (No)', value: 400 },
      { label: 'Crown cap (No)', value: 200 },
      { label: 'Label (No)', value: 50 },
    ])
    const stock = out.charts.find((c) => c.key === 'pm-stock-vs-reorder')?.rows ?? []
    expect(stock).toContainEqual({ series: 'On hand', label: 'Crown cap (No)', value: 400 })
    expect(stock).toContainEqual({ series: 'Reorder', label: 'Crown cap (No)', value: 500 })
    expect(stock.some((r) => r.label.startsWith('Label'))).toBe(false) // no level set — nothing to compare
  })
})
