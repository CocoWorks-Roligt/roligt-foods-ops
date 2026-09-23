import { describe, expect, it } from 'vitest'
import { assertBaseMatch } from './shared.ts'
import { BASE_ID } from './baseSchema.ts'

describe('assertBaseMatch — the .env ↔ generated-schema invariant', () => {
  it('throws, naming both ids, when ZOHO_BASE_ID disagrees with the generated schema', () => {
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'scratch0base0id000000000' }, 'prod0base0id0000000000')).toThrow(
      'generated schema is for base prod0base0id0000000000 but ZOHO_BASE_ID is scratch0base0id000000000',
    )
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'scratch0base0id000000000' }, 'prod0base0id0000000000')).toThrow(
      /regenerate or fix \.env/,
    )
  })

  it('passes when the ids match', () => {
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'b1' }, 'b1')).not.toThrow()
  })

  it('passes when ZOHO_BASE_ID is unset', () => {
    expect(() => assertBaseMatch({}, 'b1')).not.toThrow()
  })

  it('passes when the generated BASE_ID is empty — tests and pre-generation stay allowed', () => {
    expect(() => assertBaseMatch({ ZOHO_BASE_ID: 'b1' }, '')).not.toThrow()
  })

  it('this checkout agrees with itself at import time', () => {
    expect(() => assertBaseMatch(process.env, BASE_ID)).not.toThrow()
  })
})
