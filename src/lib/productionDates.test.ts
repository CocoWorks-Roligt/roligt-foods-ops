import { describe, expect, it } from 'vitest'
import { madeOn, productionDateRows, productionDates, stockIdDates } from './productionDates.ts'
import { migrateState } from './migrate.ts'
import { fmtDate } from './utils.ts'
import type { Batch, PackingRun } from '../types.ts'

/**
 * QC reads a result against when the product was made: the extraction date, a blend's
 * own date and the extractions behind it, and the days its bulk went into packs.
 */

const batch = (id: string, date: string, over: Partial<Batch> = {}) => ({ id, date, sourceLines: [], ...over }) as unknown as Batch
const run = (id: string, batchId: string, date: string, bulkItem: string) =>
  ({ id, batchId, date, bulkItem, medium: 'Water', lines: [] }) as unknown as PackingRun

const state = {
  batches: [
    batch('BAT-1', '2026-10-01'),
    batch('BAT-2', '2026-10-03'),
    batch('BAT-3', '2026-10-04', { kind: 'Melange', blendLines: [{ item: 'J', lot: 'BAT-2', qty: 1, unitCost: 0 }] }),
    batch('BAT-4', '2026-10-05', {
      kind: 'Melange',
      blendLines: [
        { item: 'W', lot: 'BAT-1', qty: 1, unitCost: 0 },
        { item: 'B', lot: 'BAT-3', qty: 1, unitCost: 0 },
      ],
    }),
  ],
  packingRuns: [
    run('PKG-2', 'BAT-1', '2026-10-06', 'WATER'),
    run('PKG-1', 'BAT-1', '2026-10-02', 'WATER'),
    run('PKG-3', 'BAT-1', '2026-10-02', 'MALAI'),
  ],
}

describe('productionDates', () => {
  it('dates an extraction and its packing runs, oldest first, for the bulk tested', () => {
    expect(productionDates(state, 'BAT-1', 'WATER')).toEqual({
      made: 'Extracted',
      date: '2026-10-01',
      extracted: [],
      packed: [
        { runId: 'PKG-1', date: '2026-10-02' },
        { runId: 'PKG-2', date: '2026-10-06' },
      ],
    })
    expect(productionDates(state, 'BAT-1', 'MALAI')?.packed.map((p) => p.runId)).toEqual(['PKG-3'])
    expect(productionDates(state, 'BAT-1')?.packed).toHaveLength(3)
  })

  it('follows a blend back to the extractions behind it, through a blend of blends', () => {
    const d = productionDates(state, 'BAT-4')
    expect(d?.made).toBe('Blended')
    expect(d?.extracted).toEqual([
      { batchId: 'BAT-1', date: '2026-10-01' },
      { batchId: 'BAT-2', date: '2026-10-03' },
    ])
    expect(d?.packed).toEqual([])
  })

  it('knows nothing of a batch that is not there', () => {
    expect(productionDates(state, 'BAT-9')).toBeNull()
    expect(productionDateRows(null)).toEqual([])
  })

  it('reads as rows for a report sheet', () => {
    const rows = productionDateRows(productionDates(state, 'BAT-4'))
    expect(rows.map(([label]) => label)).toEqual(['Blending date', 'Components extracted', 'Packing date'])
    expect(rows[2][1]).toBe('Not packed yet')
    expect(productionDateRows(productionDates(state, 'BAT-1', 'WATER')).map(([label]) => label)).toEqual([
      'Extraction date',
      'Packing date',
    ])
  })
})

describe('the one-line dates shown beside a batch or a stock ID', () => {
  const full = migrateState({
    batches: [batch('BAT-1', '2026-10-01'), batch('BAT-4', '2026-10-05', { kind: 'Melange', blendLines: [] })],
    packingRuns: [
      { ...run('PKG-1', 'BAT-1', '2026-10-02', 'WATER'), lines: [{ sku: 'SKU-1', packs: 10, drawn: 2, qty: 10, unitCost: 0, expiry: '2026-11-01' }] },
    ] as PackingRun[],
  })

  it('names a batch by what made it, and nothing for a lot that is not a batch', () => {
    expect(madeOn(full, 'BAT-1')).toBe(`Extracted ${fmtDate('2026-10-01')}`)
    expect(madeOn(full, 'BAT-4')).toBe(`Blended ${fmtDate('2026-10-05')}`)
    expect(madeOn(full, 'LOT-2026-0001')).toBe('')
    expect(madeOn(full, undefined)).toBe('')
  })

  it('dates a pack by its packing run and the batch it was drawn from', () => {
    expect(stockIdDates(full, 'PKG-1/1')).toBe(`Packed ${fmtDate('2026-10-02')} · extracted ${fmtDate('2026-10-01')}`)
    expect(stockIdDates(full, 'nothing')).toBe('')
  })
})
