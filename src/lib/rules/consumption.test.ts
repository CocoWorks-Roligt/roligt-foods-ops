/**
 * The consumption gate on/off matrix: under qc_gate_v2 only Released stock may
 * be blended, packed or dispatched; with the flag off the Classic rule stands
 * (Quarantine bulk is blendable, dispatch was always Released-only) — plus the
 * FEFO order picks are offered in.
 */
import { describe, expect, it } from 'vitest'
import { LEGACY_DRAWABLE, canConsumeLot, fefoOrder } from './consumption'

describe('canConsumeLot — the on/off matrix', () => {
  const cases: { status: string; blend: boolean; pack: boolean; dispatch: boolean }[] = [
    //                legacy blend  pack  dispatch | v2 blend pack dispatch
    { status: 'Released', blend: true, pack: true, dispatch: true }, // legal in both regimes
    { status: 'Quarantine', blend: true, pack: true, dispatch: false }, // the Classic blendable case
    { status: 'Available', blend: true, pack: true, dispatch: false },
    { status: 'Rejected', blend: false, pack: false, dispatch: false },
    { status: 'NPD', blend: false, pack: false, dispatch: false },
  ]

  it('legacy (flag off): blends and packing runs draw the DRAWABLE statuses, dispatch Released only', () => {
    for (const c of cases) {
      expect(canConsumeLot({ status: c.status }, { purpose: 'blend', qcGateV2: false }).ok).toBe(c.blend)
      expect(canConsumeLot({ status: c.status }, { purpose: 'pack', qcGateV2: false }).ok).toBe(c.pack)
      expect(canConsumeLot({ status: c.status }, { purpose: 'dispatch', qcGateV2: false }).ok).toBe(c.dispatch)
    }
  })

  it('v2 (flag on): Released only, for every purpose', () => {
    for (const c of cases) {
      expect(canConsumeLot({ status: c.status }, { purpose: 'blend', qcGateV2: true }).ok).toBe(c.status === 'Released')
      expect(canConsumeLot({ status: c.status }, { purpose: 'pack', qcGateV2: true }).ok).toBe(c.status === 'Released')
      expect(canConsumeLot({ status: c.status }, { purpose: 'dispatch', qcGateV2: true }).ok).toBe(c.status === 'Released')
    }
  })

  it('a refusal names the released_only guard and explains itself in plain language', () => {
    const v = canConsumeLot({ status: 'Quarantine' }, { purpose: 'blend', qcGateV2: true })
    expect(v.ok).toBe(false)
    expect(v.mode).toBe('v2')
    expect(v.guard).toBe('released_only')
    expect(v.explanation).toBe('Only released stock can be used or dispatched.')
  })

  it('an allowed draw explains nothing and the verdict carries the regime', () => {
    const legacy = canConsumeLot({ status: 'Quarantine' }, { purpose: 'blend', qcGateV2: false })
    expect(legacy).toMatchObject({ ok: true, mode: 'legacy', explanation: '', status: 'Quarantine' })
    expect(legacy.guard).toBeUndefined()
  })

  it("LEGACY_DRAWABLE is exactly today's posting rule (posting.ts DRAWABLE)", () => {
    expect([...LEGACY_DRAWABLE]).toEqual(['Available', 'Quarantine', 'Released'])
  })
})

describe('fefoOrder', () => {
  const lots = [
    { lot: 'LOT-C', expiry: '2026-12-01', status: 'Released' },
    { lot: 'LOT-A', expiry: '2026-11-01', status: 'Released' },
    { lot: 'LOT-B', expiry: '2026-10-15', status: 'Released' },
    { lot: 'LOT-N', status: 'Released' }, // no date carried
  ]

  it('earliest expiry first, undated lots last', () => {
    expect(fefoOrder(lots, 'relaxed', '2026-10-13').map((l) => l.lot)).toEqual(['LOT-B', 'LOT-A', 'LOT-C', 'LOT-N'])
  })

  it('strict drops expired stock from the pick entirely; relaxed keeps it', () => {
    expect(fefoOrder(lots, 'strict', '2026-10-16').map((l) => l.lot)).toEqual(['LOT-A', 'LOT-C', 'LOT-N'])
    expect(fefoOrder(lots, 'relaxed', '2026-10-16').map((l) => l.lot)).toContain('LOT-B')
  })

  it('strict keeps stock expiring today (best-before is the last day it may ship)', () => {
    expect(fefoOrder(lots, 'strict', '2026-10-15').map((l) => l.lot)).toContain('LOT-B')
  })

  it('ties break by lot id so the order is stable, and the input is never mutated', () => {
    const tied = [
      { lot: 'LOT-Z', expiry: '2026-11-01' },
      { lot: 'LOT-Y', expiry: '2026-11-01' },
    ]
    expect(fefoOrder(tied, 'relaxed').map((l) => l.lot)).toEqual(['LOT-Y', 'LOT-Z'])
    expect(tied.map((l) => l.lot)).toEqual(['LOT-Z', 'LOT-Y'])
  })
})
