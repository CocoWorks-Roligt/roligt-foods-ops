/**
 * The flag reader: every flag the overhaul rides, OFF unless a row says
 * otherwise — a base with no flags collection at all (pre-backfill) is
 * byte-for-byte today's behaviour, and so is any row that fails to say true.
 */
import { describe, expect, it } from 'vitest'
import { ALL_FLAGS_OFF, flagEnabled, readFlags, type FlagLike } from './flags'

describe('readFlags', () => {
  it('no rows at all is the all-OFF map', () => {
    expect(readFlags([])).toEqual(ALL_FLAGS_OFF)
    expect(readFlags(null)).toEqual(ALL_FLAGS_OFF)
    expect(readFlags(undefined)).toEqual(ALL_FLAGS_OFF)
  })

  it('an enabled flag reads true, everything else stays off', () => {
    const flags = readFlags([{ key: 'qc_gate_v2', enabled: true }, { key: 'batch_v2', enabled: false }])
    expect(flags.qc_gate_v2).toBe(true)
    expect(flags.batch_v2).toBe(false)
    expect(flags.pipeline).toBe(false)
    expect(flags.shipments).toBe(false)
  })

  it('a row without a boolean true reads OFF — never on by accident', () => {
    const flags = readFlags([{ key: 'batch_v2' }, { key: 'pipeline', enabled: 'yes' as unknown as boolean }])
    expect(flags.batch_v2).toBe(false)
    expect(flags.pipeline).toBe(false)
  })

  it('unknown keys are ignored; dashboards_<module> lands in its own map', () => {
    const flags = readFlags([
      { key: 'made_up_flag', enabled: true },
      { key: 'dashboards_qc', enabled: true },
      { key: 'dashboards_procurement', enabled: false },
    ] as FlagLike[])
    expect(flags).toEqual({ ...ALL_FLAGS_OFF, dashboards: { qc: true, procurement: false } })
    expect(flagEnabled(flags, 'dashboards_qc')).toBe(true)
    expect(flagEnabled(flags, 'dashboards_procurement')).toBe(false)
  })

  it('the default map is never shared mutable state', () => {
    const flags = readFlags([{ key: 'dashboards_qc', enabled: true }])
    expect(ALL_FLAGS_OFF.dashboards).toEqual({})
    expect(flags.dashboards).toEqual({ qc: true })
  })

  it('flagEnabled answers for named and dashboard keys, unknown means OFF', () => {
    const flags = readFlags([{ key: 'shipments', enabled: true }])
    expect(flagEnabled(flags, 'shipments')).toBe(true)
    expect(flagEnabled(flags, 'shell_nav')).toBe(false)
    expect(flagEnabled(flags, 'dashboards_unknown')).toBe(false)
  })
})
