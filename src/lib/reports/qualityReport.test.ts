import { describe, expect, it } from 'vitest'
import { AUG, EMPTY_MONTH, SEP, fixtureState } from './fixtures.ts'
import { qualityReport } from './qualityReport.ts'

const state = fixtureState()

describe('quality report', () => {
  it('counts one record per product of a batch, not one per batch', () => {
    const aug = qualityReport(state, AUG)
    expect(aug.byMonth).toHaveLength(1)
    const month = aug.byMonth[0]
    expect(month.key).toBe('2026-08')
    expect(month.records).toBe(4) // water + malai + pending water + beet
    expect(month.released).toBe(2)
    expect(month.rejected).toBe(1)
    expect(month.pending).toBe(1)
    expect(month.releaseRate).toBe(50)
    expect(month.rejectRate).toBe(25)
  })

  it('files a pending record under its batch’s month when nothing is reviewed', () => {
    // QC-3 has no reviewedAt; its batch ran 2026-08-20, so it counts in August.
    const aug = qualityReport(state, AUG)
    expect(aug.byMonth[0].pending).toBe(1)
    expect(qualityReport(state, SEP).byMonth).toEqual([])
  })

  it('splits the same month by product', () => {
    const byProduct = qualityReport(state, AUG).byProduct
    const names = byProduct.map((p) => p.key)
    expect(names).toContain('Coconut Water (bulk)')
    expect(names).toContain('Malai (bulk)')
    expect(names).toContain('Beetroot Juice (bulk)')

    const water = byProduct.find((p) => p.key === 'Coconut Water (bulk)')!
    expect(water.records).toBe(2) // released + pending
    expect(water.released).toBe(1)
    expect(water.pending).toBe(1)
    expect(water.releaseRate).toBe(50)

    const malai = byProduct.find((p) => p.key === 'Malai (bulk)')!
    expect(malai.rejected).toBe(1)
    expect(malai.rejectRate).toBe(100)
  })

  it('rolls the batches’ own statuses up beside the record counts', () => {
    const aug = qualityReport(state, AUG)
    const byStatus = new Map(aug.batchStatuses.map((s) => [s.status, s.count]))
    expect(byStatus.get('Partly Released')).toBe(1)
    expect(byStatus.get('Released')).toBe(1)
    expect(byStatus.get('Awaiting QC')).toBe(1)
  })

  it('shows a partly-released batch with the products that disagree', () => {
    const aug = qualityReport(state, AUG)
    expect(aug.partlyReleased).toHaveLength(1)
    const partly = aug.partlyReleased[0]
    expect(partly.batchId).toBe('BAT-2026-0001')
    expect(partly.outputs).toEqual([
      { item: 'SF-TCW-WATER', name: 'Coconut Water (bulk)', disposition: 'Released' },
      { item: 'SF-TCW-MALAI', name: 'Malai (bulk)', disposition: 'Rejected' },
    ])
  })

  it('shows nothing decided in a month nothing ran', () => {
    const empty = qualityReport(state, EMPTY_MONTH)
    expect(empty.byMonth).toEqual([])
    expect(empty.byProduct).toEqual([])
    expect(empty.batchStatuses).toEqual([])
    expect(empty.partlyReleased).toEqual([])
  })
})
