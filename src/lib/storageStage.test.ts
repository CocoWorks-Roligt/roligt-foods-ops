/**
 * storageStage folds under test (WORKFLOW W13) — the put-away queue is exactly
 * what the app's own predicates flag (areaRefusal, a deactivated room,
 * roomSuits), in their own severity order, and NOTHING else: the pipeline
 * Stock tile's held lots owe a verdict or a write-off, not a move, so they
 * must never be queued here.
 */
import { describe, expect, it } from 'vitest'
import { putAwayRows } from './storageStage'
import { migrateState } from './migrate'
import { inHoldArea } from './stock'
import { pipelineStages } from './pipeline'
import type { AppState, StorageLocation } from '../types'

const area = (name: string, type: StorageLocation['type'], over: Partial<StorageLocation> = {}): StorageLocation => ({
  id: `LOC-${name}`,
  name,
  label: name,
  holds: '',
  type,
  status: 'Active',
  ...over,
})

const line = (o: {
  id: string
  doc: string
  qtyIn?: number
  item?: string
  itemType?: string
  location?: string
  status?: string
  expiry?: string
}) => ({
  item: 'SKU-FG',
  itemType: 'Finished Goods',
  lot: 'LOT-1',
  location: 'Cold Room A',
  status: 'Available',
  uom: 'Piece',
  type: 'Receipt',
  time: '2026-10-14T09:00:00.000Z',
  qtyIn: 0,
  qtyOut: 0,
  unitCost: 10,
  ...o,
})

describe('putAwayRows', () => {
  it('queues what the app’s own rules flag, worst first', () => {
    const s: AppState = migrateState({})
    s.storageLocations.push(
      area('Cold Room A', 'Cold Room'),
      area('Dry Store', 'Dry Store'),
      area('Old Room', 'Cold Room', { status: 'Inactive' }),
      area('Hold Shelf', 'Hold Area'),
    )
    s.ledger.push(
      // refused first: a Released lot still standing in a hold area — saveQc
      // would make somebody move it back out before changing the verdict
      line({ id: 'L1', doc: 'BAT-1', qtyIn: 10, location: 'Hold Shelf', status: 'Released' }),
      // inactive second: the room was retired around its stock
      line({ id: 'L2', doc: 'GRN-2', qtyIn: 20, location: 'Old Room', itemType: 'Raw Material' }),
      // unusual third: finished packs in a dry store
      line({ id: 'L3', doc: 'RUN-3', qtyIn: 30, location: 'Dry Store', expiry: '2026-11-01' }),
      line({ id: 'L4', doc: 'RUN-4', qtyIn: 40, location: 'Dry Store', expiry: '2026-10-20' }),
    )
    const queue = putAwayRows(s)
    expect(queue.map((q) => q.reason)).toEqual(['refused', 'inactive', 'unusual', 'unusual'])
    // within the unusual band, what expires soonest is the first pallet offered
    expect(queue.slice(2).map((q) => q.row.expiry)).toEqual(['2026-10-20', '2026-11-01'])
    // the refusal's why is areaRefusal's own word for a hold area
    expect(queue[0].why).toContain('only takes stock QC has rejected')
  })

  it('never queues stock where it belongs — including the pipeline tile’s held lots', () => {
    const s: AppState = migrateState({})
    s.storageLocations.push(area('Cold Room A', 'Cold Room'), area('Hold Shelf', 'Hold Area'))
    s.ledger.push(
      // suited homes: packs in a cold room, quarantine bulk in a cold room,
      // rejected stock parked in a hold area
      line({ id: 'L1', doc: 'RUN-1', qtyIn: 100 }),
      line({ id: 'L2', doc: 'BAT-2', qtyIn: 50, itemType: 'Semi Finished', status: 'Quarantine' }),
      line({ id: 'L3', doc: 'BAT-3', qtyIn: 5, location: 'Hold Shelf', status: 'Rejected' }),
    )
    expect(putAwayRows(s)).toEqual([])
    // ...and yet the pipeline Stock tile counts those same rows as held — the
    // tile's business (a verdict, a write-off), never this queue's
    const held = pipelineStages(s, '2026-10-14').find((x) => x.id === 'stock')
    expect(held?.count).toBe(2)
    expect(s.ledger.filter((l) => inHoldArea(s, l.location)).length).toBeGreaterThan(0)
  })

  it('flags stock whose area record is gone', () => {
    const s: AppState = migrateState({})
    s.ledger.push(line({ id: 'L1', doc: 'RUN-1', qtyIn: 10, location: 'Ghost Room' }))
    const queue = putAwayRows(s)
    expect(queue.map((q) => q.reason)).toEqual(['refused'])
    expect(queue[0].why).toContain('not on the Storage page any more')
  })

  it('reads a tidy store as empty', () => {
    expect(putAwayRows(migrateState({}))).toEqual([])
  })
})
