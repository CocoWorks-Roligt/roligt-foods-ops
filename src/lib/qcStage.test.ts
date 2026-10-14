/**
 * qcStage folds under test (WORKFLOW W11) — the queue's predicate is pinned to
 * pipelineStages' own count (the QC tile), so the bench works exactly the
 * records the board counts, and its order to oldest batch first, so the aging
 * the tile flags is the record the form offers at the top.
 */
import { describe, expect, it } from 'vitest'
import { pendingQc } from './qcStage'
import { pipelineStages } from './pipeline'
import { migrateState } from './migrate'
import type { AppState, Batch, QcRecord } from '../types'

const TODAY = '2026-10-14'

const batch = (over: Partial<Batch>): Batch =>
  ({ id: 'B-1', kind: 'Extraction', date: TODAY, status: 'Awaiting QC', ...over } as Batch)

const qc = (id: string, batchId: string, disposition = 'Pending'): QcRecord => ({
  id,
  batchId,
  item: 'SF-TCW',
  micro: 'Pending',
  pesticides: 'Pending',
  heavyMetals: 'Pending',
  physico: 'Pending',
  disposition,
  reviewedBy: '',
  reviewedAt: '',
})

describe('pendingQc', () => {
  it('queues records without a verdict, oldest batch first — the tile’s own predicate', () => {
    const s: AppState = migrateState({})
    s.batches.push(
      batch({ id: 'B-new', date: TODAY }),
      batch({ id: 'B-old', date: '2026-10-08' }),
      batch({ id: 'B-mid', date: '2026-10-11' }),
    )
    s.qcs.push(
      qc('QC-1', 'B-new'),
      qc('QC-2', 'B-old'),
      qc('QC-3', 'B-mid'),
      qc('QC-4', 'B-old'), // same batch, second product — queued beside its sibling
      qc('QC-5', 'B-mid', 'Released'), // decided — not the bench's to re-ask
    )
    const queue = pendingQc(s)
    expect(queue.map((e) => e.q.id)).toEqual(['QC-2', 'QC-4', 'QC-3', 'QC-1'])
    // pinned to the tile: whatever the form queues is what the board counts
    const tile = pipelineStages(s, TODAY).find((x) => x.id === 'qc')
    expect(tile?.count).toBe(queue.length)
  })

  it('keeps a record whose batch is missing — its blank date sorts first, as the tile ages it', () => {
    const s: AppState = migrateState({})
    s.batches.push(batch({ id: 'B-old', date: '2026-10-08' }))
    s.qcs.push(qc('QC-orphan', 'B-gone'), qc('QC-1', 'B-old'))
    expect(pendingQc(s).map((e) => e.q.id)).toEqual(['QC-orphan', 'QC-1'])
  })

  it('reads a quiet plant as an empty queue', () => {
    expect(pendingQc(migrateState({}))).toEqual([])
  })
})
