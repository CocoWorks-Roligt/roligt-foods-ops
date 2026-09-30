import { describe, expect, it } from 'vitest'
import { assertBaseMatch } from './shared.js'
import { SCHEMAS } from './baseSchema.js'

describe('assertBaseMatch', () => {
  it('throws when env names a base no schema was generated for, naming it and what to run', () => {
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'b0not0a0synced0base000000000' }, ['scratch0base0id000000000'])).toThrow(
      /ZOHO_BASE_ID b0not0a0synced0base000000000 has no generated schema \(have: scratch0base0id000000000\).*topup\.mjs b0not0a0synced0base000000000/,
    )
  })

  it('passes when env names a base the generated schemas carry', () => {
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'b1' }, ['b1', 'b2'])).not.toThrow()
  })

  it('passes when ZOHO_BASE_ID is unset — default base, same world the client falls back to', () => {
    expect(() => assertBaseMatch({}, ['b1'])).not.toThrow()
  })

  it('fails closed on an empty known list — no base is trusted just because env names one', () => {
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'b1' }, [])).toThrow(/no generated schema/)
  })

  it('this checkout agrees with itself: env, when set, names a base the generated schemas carry', () => {
    expect(() => assertBaseMatch(process.env)).not.toThrow()
    expect(Object.keys(SCHEMAS).length).toBeGreaterThan(0)
  })
})
