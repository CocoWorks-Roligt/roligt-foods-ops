/**
 * P5 fold tests: procurement (PO funnel, on-time, window filter) and
 * grading-extraction (grade mix, yield per 100, spoilage pareto, close stamps).
 * Pure folds over shaped state — no store.
 */
import { describe, expect, it } from 'vitest'
import { procurementKpis } from './procurement.ts'
import { gradingExtractionKpis } from './gradingExtraction.ts'
import type { AppState, Batch, Grn } from '../../types.ts'
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
