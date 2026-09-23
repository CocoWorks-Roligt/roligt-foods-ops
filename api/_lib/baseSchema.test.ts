import { describe, expect, it } from 'vitest'
import { T, TABLE_FOR } from './baseSchema.ts'

describe('baseSchema (generated)', () => {
  it('covers every collection the app syncs, with App ID + Data JSON where required', () => {
    for (const base of Object.values(TABLE_FOR)) {
      const t = T[base]
      expect(t, base).toBeDefined()
      expect(t.appId, `${base}.appId`).toBeTruthy()
      if (!['Counters', 'Config'].includes(base)) expect(t.dataJson, `${base}.dataJson`).toBeTruthy()
    }
    expect(TABLE_FOR.grns).toBe('GRNs')
    expect(TABLE_FOR.ledger).toBe('Ledger')
  })
})
