/**
 * sampleStage folds under test (WORKFLOW W12) — the shelf's predicate is pinned
 * to pipelineStages' own count (the Control samples tile) and its order to
 * nearest expiry first, so what the tile flags as past expiry is the first
 * record the shelf asks to destroy.
 */
import { describe, expect, it } from 'vitest'
import { dueSamples } from './sampleStage'
import { pipelineStages } from './pipeline'
import { migrateState } from './migrate'
import type { AppState, ControlSample, PackingRun } from '../types'

const TODAY = '2026-10-14'

const sample = (over: Partial<ControlSample>): ControlSample => ({ count: 2, ...over })

const run = (id: string, date: string, ...controlSamples: ControlSample[]): PackingRun =>
  ({ id, date, batchId: 'BAT-1', lines: [], controlSamples } as unknown as PackingRun)

describe('dueSamples', () => {
  it('queues kept samples inside the tile’s 7-day horizon, nearest expiry first', () => {
    const s: AppState = migrateState({})
    s.packingRuns.push(
      run('RUN-1', '2026-10-10', sample({ expiresOn: '2026-10-19', collectedBy: 'Lab' })), // inside the horizon
      run('RUN-2', '2026-10-01', sample({ expiresOn: '2026-10-12' })), // ALREADY EXPIRED — still owed, first
      run('RUN-3', '2026-10-13', sample({ expiresOn: '2026-10-16' })), // soonest inside — second
      run('RUN-4', '2026-10-14', sample({ expiresOn: '2026-10-30' })), // a month out — not the shelf's yet
      run('RUN-5', '2026-10-12', sample({})), // no expiry recorded — the tile counts it nowhere
      run('RUN-6', '2026-10-09', sample({ expiresOn: '2026-10-10', destroyedOn: '2026-10-11' })), // done
    )
    const queue = dueSamples(s, TODAY)
    expect(queue.map((r) => r.run.id)).toEqual(['RUN-2', 'RUN-3', 'RUN-1'])
    // pinned to the tile: whatever the shelf queues is what the board counts
    const tile = pipelineStages(s, TODAY).find((x) => x.id === 'samples')
    expect(tile?.count).toBe(queue.length)
    expect(tile?.flag?.kind).toBe('expiry') // the expired row is why the tile flags
  })

  it('reads a quiet shelf as empty', () => {
    expect(dueSamples(migrateState({}), TODAY)).toEqual([])
  })
})
