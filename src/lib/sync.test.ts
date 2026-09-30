import { describe, expect, it } from 'vitest'
import { diffRows, diffState, installOver } from './sync.ts'
import type { AppState } from '../types.ts'

/**
 * The diff engine the whole concurrency protocol stands on: what is written is
 * the difference between the last state the database was known to hold and the
 * state now, each changed row carrying the base it was built from. The two
 * properties this file exists to pin: a null prev never deletes anything, and a
 * prev that is not the recorded base does — which is why AppContext persists
 * the base and never diffs against a fresher server.
 */

const asState = (o: Record<string, unknown>) => o as unknown as AppState

describe('diffRows', () => {
  const idOf = (r: { id: string }) => r.id
  const copy = (r: unknown) => ({ ...(r as Record<string, unknown>) })

  it('emits the base version of a changed row — the precondition for its write', () => {
    const d = diffRows([{ id: 'V-1', name: 'Old' }], [{ id: 'V-1', name: 'New' }], idOf, copy)
    expect(d.upsert).toEqual([{ id: 'V-1', name: 'New' }])
    expect(d.expect['V-1']).toEqual({ id: 'V-1', name: 'Old' })
  })

  it('emits nothing for an unchanged row', () => {
    const d = diffRows([{ id: 'V-1', name: 'Same' }], [{ id: 'V-1', name: 'Same' }], idOf, copy)
    expect(d.upsert).toEqual([])
    expect(d.remove).toEqual([])
    expect(d.expect).toEqual({})
  })

  it('emits an upsert with no expectation for a row it never saw', () => {
    const d = diffRows(undefined, [{ id: 'V-2', name: 'New' }], idOf, copy)
    expect(d.upsert).toEqual([{ id: 'V-2', name: 'New' }])
    expect(d.expect).toEqual({})
  })

  it('emits a remove only for a row the base held and the new state dropped', () => {
    const d = diffRows([{ id: 'A' }, { id: 'B' }], [{ id: 'A' }], idOf, copy)
    expect(d.remove).toEqual(['B'])
  })

  it('never removes anything against a null prev — the safe direction to be wrong in', () => {
    const d = diffRows(undefined, [{ id: 'A' }, { id: 'B' }], idOf, copy)
    expect(d.upsert).toHaveLength(2)
    expect(d.remove).toEqual([])
  })

  it('skips the content comparison for immutable rows — an insert is the only shape they take', () => {
    const d = diffRows([{ id: 'L1', qty: 1 }], [{ id: 'L1', qty: 2 }], idOf, copy, true)
    expect(d.upsert).toEqual([])
    expect(d.expect).toEqual({})
  })
})

describe('diffState', () => {
  it('carries the expect map for a changed document collection, in database shape', () => {
    const prev = asState({ grns: [{ id: 'GRN-1', status: 'Posted' }], counters: { grn: 1 } })
    const next = asState({ grns: [{ id: 'GRN-1', status: 'Edited' }], counters: { grn: 1 } })
    const d = diffState(prev, next)
    const grns = d.tables.find((t) => t.table === 'grns')!
    expect(grns.upsert).toEqual([{ id: 'GRN-1', data: { id: 'GRN-1', status: 'Edited' } }])
    expect(grns.expect).toEqual({ 'GRN-1': { id: 'GRN-1', data: { id: 'GRN-1', status: 'Posted' } } })
    expect(d.empty).toBe(false)
  })

  it('ledger inserts carry no expectation — a line is only ever new', () => {
    const prev = asState({ counters: {} })
    const next = asState({
      ledger: [{ id: 'L1', type: 'GRN', doc: 'GRN-1', qtyIn: 90, qtyOut: 0, uom: 'Piece' }],
      counters: {},
    })
    const d = diffState(prev, next)
    const ledger = d.tables.find((t) => t.table === 'ledger')!
    expect(ledger.upsert).toHaveLength(1)
    expect(ledger.expect).toBeUndefined()
  })

  it("the write-loss shape: a colleague's row survives a diff against the recorded base", () => {
    const mine = { id: 'GRN-1', status: 'Posted' }
    const theirs = { id: 'GRN-2', status: 'Posted' }
    const base = asState({ grns: [mine], counters: {} }) // what this device last knew was up there
    const freshServer = asState({ grns: [mine, theirs], counters: {} }) // what a fresh read hands back
    const local = asState({ grns: [{ id: 'GRN-1', status: 'Edited' }], counters: {} })
    // the old behaviour — diffing against the fresh server — scheduled their row
    // for deletion the moment this device saved anything
    const vsFresh = diffState(freshServer, local)
    expect(vsFresh.tables.find((t) => t.table === 'grns')?.remove).toContain('GRN-2')
    // diffing against the recorded base leaves it untouched: this device never
    // saw it, so it is not this device's deletion to make
    const vsBase = diffState(base, local)
    expect(vsBase.tables.find((t) => t.table === 'grns')?.remove ?? []).not.toContain('GRN-2')
  })

  it('emits only the counters that moved, with their periods alongside', () => {
    const prev = asState({ counters: { grn: 1, lot: 3 }, counterPeriods: { grn: 'YYYY:2026' } })
    const next = asState({ counters: { grn: 2, lot: 3 }, counterPeriods: { grn: 'YYYY:2027' } })
    const d = diffState(prev, next)
    expect(d.counters).toEqual({ grn: 2, 'period:grn': 'YYYY:2027' })
  })
})

describe('installOver', () => {
  /**
   * The install side of the protocol the diff is the push side of. Every
   * snapshot install used to swap the whole state in, which erased anything
   * queued while the read was in flight; this merge keeps what the operator
   * moved off the base and takes the server for the rest — including its
   * deletions, which a plain upsert would never deliver.
   */
  const V = (id: string, name: string) => ({ id, name })
  const asPlant = (vendors: unknown[], extra: Record<string, unknown> = {}) =>
    asState({ counters: {}, vendors, ...extra })

  it('keeps the operator, adopts the server: edits, additions, deletions, arrivals', () => {
    const base = asPlant([V('V1', 'old'), V('V2', 'stays?'), V('V5', 'deleted here')])
    const live = asPlant([V('V1', 'edited'), V('V2', 'stays?'), V('V3', 'added here')])
    // the server's fresh view: V1 as it always was, V2 deleted there too, the
    // V5 this device deleted still sitting on it, and V4 new since the base
    const source = asPlant([V('V1', 'old'), V('V5', 'deleted here'), V('V4', 'colleague')])
    const merged = installOver(live, base, source)
    const names = (merged.vendors as { id: string; name: string }[]).map((v) => `${v.id}:${v.name}`)
    expect(names).toEqual(['V1:edited', 'V3:added here', 'V4:colleague'])
    // V2: live held it untouched and the server deleted it — the deletion arrives
    expect(names.some((n) => n.startsWith('V2:'))).toBe(false)
    // V5: deleted here while the server still holds it — the base knows the id,
    // so the server's copy is refused rather than resurrected; the pending push
    // carries the removal up
    expect(names.some((n) => n.startsWith('V5:'))).toBe(false)
  })

  it('takes the server for scalars live has not moved, and keeps the ones it has', () => {
    const base = asState({ counters: { grn: 1 }, config: { plant: 'A' } })
    const live = asState({ counters: { grn: 2 }, config: { plant: 'A' } }) // grn minted here
    const source = asState({ counters: { grn: 9 }, config: { plant: 'B' } })
    const merged = installOver(live, base, source)
    expect(merged.counters).toEqual({ grn: 2 }) // the local advance survives
    expect(merged.config).toEqual({ plant: 'B' }) // the untouched setting refreshes
  })

  it('a null base keeps everything live and removes nothing — the safe direction', () => {
    const live = asPlant([V('V1', 'unsaved work')])
    const source = asPlant([V('V2', 'colleague')])
    const merged = installOver(live, null, source)
    expect((merged.vendors as unknown[]).map((r) => (r as { id: string }).id).sort()).toEqual(['V1', 'V2'])
  })

  it('an identical source over its own base is a no-op row for row', () => {
    const plant = asPlant([V('V1', 'same'), V('V2', 'same')])
    const merged = installOver(plant, plant, plant)
    expect(JSON.stringify(merged)).toBe(JSON.stringify(plant))
  })
})
