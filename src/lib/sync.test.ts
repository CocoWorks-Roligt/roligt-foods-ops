import { describe, expect, it } from 'vitest'
import { adoptServerRows, diffRows, diffState, installOver, offlineBootBase, restoreWithheld } from './sync.ts'
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

describe('adoptServerRows', () => {
  /**
   * The other half of the 409 protocol: what a device keeps after losing a
   * save race. Rows surrender to the server's slice, but the COUNTER is where
   * the old server-wins merge bit — a device holding numbers minted offline
   * past the server's counter would adopt the lower value, mint the same
   * number again, and its edit of that number would ride an expect matching
   * its own first receipt: an overwrite no 409 ever catches.
   */
  const G = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: 'Posted', ...extra })

  it('keeps a counter minted past the server\'s, and the re-save re-emits it — no number is re-issued', () => {
    // phone B went offline minting GRN-6 and GRN-7 (counter 7); phone A minted
    // its own GRN-6 online (server counter 6). B's chunk is refused whole on
    // the GRN-6 'exists' — but B's unconflicted GRN-7 survives locally
    const recorded = asState({ grns: [G('GRN-5')], counters: { grn: 5 } }) // B's base
    const live = asState({ grns: [G('GRN-5'), G('GRN-6'), G('GRN-7')], counters: { grn: 7 } })
    const server = asState({ grns: [G('GRN-5'), G('GRN-6', { farmer: 'A' })], counters: { grn: 6 } })
    const conflicts = [{ table: 'grns', id: 'GRN-6', kind: 'exists' }]
    const base = adoptServerRows(recorded, server, conflicts, { counters: 'server' })
    const state = adoptServerRows(live, server, conflicts)
    // the state keeps B's higher number; the base takes the server's 6 — the
    // gap between them is the counter diff the re-save pushes
    expect(state.counters).toEqual({ grn: 7 })
    expect(base.counters).toEqual({ grn: 6 })
    // the surrendered GRN-6 is A's now; B's GRN-7 survives alongside it — once
    expect((state.grns as { id: string }[]).map((g) => g.id)).toEqual(['GRN-5', 'GRN-7', 'GRN-6'])
    const again = diffState(base, state)
    expect(again.counters).toEqual({ grn: 7 }) // the server catches up
    const grns = again.tables.find((t) => t.table === 'grns')!
    expect(grns.upsert.map((r) => (r as { id: string }).id)).toEqual(['GRN-7'])
    expect(grns.expect ?? {}).toEqual({}) // a plain insert: the base never held it
    // and the next mint from here is 8 — not a second GRN-7
    expect(state.counters.grn + 1).toBe(8)
  })

  it('takes the server\'s counter when it is the ahead one — the winner\'s series continues', () => {
    const state = adoptServerRows(
      asState({ counters: { grn: 6 } }),
      asState({ counters: { grn: 8 } }),
      [],
    )
    expect(state.counters).toEqual({ grn: 8 })
  })

  it('keeps period rows the server\'s word — the server judges periods, not the device', () => {
    const state = adoptServerRows(
      asState({ counters: { grn: 7 }, counterPeriods: { grn: 'MM:10' } }),
      asState({ counters: { grn: 6 }, counterPeriods: { grn: 'YYYY:2026' } }),
      [],
    )
    expect(state.counterPeriods).toEqual({ grn: 'YYYY:2026' })
  })
})

describe('offlineBootBase', () => {
  /**
   * The boot-while-offline base. Null was the only answer once, and null made
   * every edit of an existing row a guaranteed 409 'exists' at reconnect — the
   * null-base push carries no expect, the row is stored and differs, refused
   * even though nobody else touched it. A device that has synced before always
   * holds a view worth diffing against.
   */
  const G = (id: string, status = 'Posted') => ({ id, status })

  it('a clean mirror with its revision is the base — offline edits carry expect and land', () => {
    const mirror = asState({ grns: [G('GRN-42')], counters: {} })
    const base = offlineBootBase({ dirty: false, hasRevision: true, base: null, mirror })
    expect(base).toBe(mirror)
    // the chain this enables: an edit made offline diffs against the mirror, so
    // the push carries the pre-edit row as its expect — admitted when nobody
    // else moved the row, a 409 only when somebody genuinely did
    const push = diffState(base, asState({ grns: [G('GRN-42', 'Edited')], counters: {} }))
    expect(push.tables.find((t) => t.table === 'grns')?.expect).toEqual({
      'GRN-42': { id: 'GRN-42', data: { id: 'GRN-42', status: 'Posted' } },
    })
  })

  it('a dirty mirror diffs against its recorded base — yesterday\'s offline work keeps its footing', () => {
    const base = asState({ grns: [G('GRN-1')], counters: {} })
    expect(offlineBootBase({ dirty: true, hasRevision: true, base, mirror: null })).toBe(base)
  })

  it('falls back to null only with no view at all — first run, no revision, quota-spilled base', () => {
    expect(offlineBootBase(null)).toBeNull()
    expect(offlineBootBase({ dirty: false, hasRevision: false, base: null, mirror: asState({}) })).toBeNull()
    expect(offlineBootBase({ dirty: true, hasRevision: true, base: null, mirror: asState({}) })).toBeNull()
  })
})

describe('restoreWithheld', () => {
  /**
   * The scoped-caller half of the snapshot protocol (the audit's S2-6): the BFF
   * drops the tables this caller may not read and names them in `withheld`. An
   * ABSENT key would read as "never written" to migrateState's seeding and as a
   * wipe to installOver's merge — either way a lie about tables the server was
   * never asked about — so the previous view's copies of exactly those keys are
   * bridged back in BEFORE any of that runs.
   */
  it("bridges a withheld key from the previous view and leaves the server's fresh keys alone", () => {
    const from = asState({ grns: [{ id: 'GRN-1' }], vendors: [{ id: 'V-1', name: 'old' }] })
    const partial = { state: asState({ vendors: [{ id: 'V-2', name: 'new' }] }), revision: '8', withheld: ['grns'] }
    const out = restoreWithheld(partial, from)
    const outState = out.state as unknown as Record<string, unknown>
    expect(outState.grns).toEqual([{ id: 'GRN-1' }]) // bridged from the previous view
    expect(outState.vendors).toEqual([{ id: 'V-2', name: 'new' }]) // the server's fresh row stands
    expect(out.revision).toBe('8')
    expect((partial.state as unknown as Record<string, unknown>).grns).toBeUndefined() // not mutated
  })

  it('passes through when there is nothing to bridge — null state, no withheld list, no previous view', () => {
    expect(restoreWithheld({ state: null, revision: '8', withheld: ['grns'] }, asState({})).state).toBeNull()
    const noList = restoreWithheld({ state: asState({}), revision: '8' }, asState({ grns: [{ id: 'GRN-1' }] }))
    expect((noList.state as unknown as Record<string, unknown>).grns).toBeUndefined()
    const noFrom = restoreWithheld({ state: asState({}), revision: '8', withheld: ['grns'] }, null)
    expect((noFrom.state as unknown as Record<string, unknown>).grns).toBeUndefined()
  })

  it('never invents a key the previous view does not hold either', () => {
    const out = restoreWithheld(
      { state: asState({ vendors: [] }), revision: '8', withheld: ['grns', 'qcs'] },
      asState({ qcs: [{ id: 'QC-1' }] }),
    )
    const outState = out.state as unknown as Record<string, unknown>
    expect(outState.qcs).toEqual([{ id: 'QC-1' }])
    expect('grns' in outState).toBe(false) // still absent — nothing to bridge from
  })
})
