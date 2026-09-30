import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BASE_ID, SCHEMAS, T, TABLE_FOR, schemaFor } from './baseSchema.js'

// T and schemaFor resolve from ZOHO_BASE_ID; keep the ambient one out of these claims
const prevBase = process.env.ZOHO_BASE_ID
beforeEach(() => {
  delete process.env.ZOHO_BASE_ID
})
afterEach(() => {
  if (prevBase === undefined) delete process.env.ZOHO_BASE_ID
  else process.env.ZOHO_BASE_ID = prevBase
})

describe('generated baseSchema shape', () => {
  it('every synced base carries the full table set with appId and Data JSON', () => {
    expect(Object.keys(SCHEMAS).length).toBeGreaterThan(0)
    for (const [base, tables] of Object.entries(SCHEMAS)) {
      expect(Object.keys(tables).length, base).toBeGreaterThanOrEqual(Object.keys(TABLE_FOR).length)
      for (const key of Object.values(TABLE_FOR)) {
        const t = tables[key]
        expect(t, `${base}: ${key}`).toBeDefined()
        expect(t.appId, `${base}: ${key} App ID`).toBeTruthy()
        if (!['Counters', 'Config'].includes(key)) {
          expect(t.dataJson, `${base}: ${key} Data JSON`).toBeTruthy()
        }
      }
    }
  })

  it('DEFAULT_BASE_ID is itself a synced base', () => {
    expect(SCHEMAS[DEFAULT_BASE_ID]).toBeDefined()
  })

  it('TABLE_FOR names the base tables for the supabase collections', () => {
    expect(TABLE_FOR.grns).toBe('GRNs')
    expect(TABLE_FOR.ledger).toBe('Ledger')
  })
})

describe('schemaFor', () => {
  it('an unset base falls back to DEFAULT_BASE_ID — the world tests and the harness run in', () => {
    expect(schemaFor(undefined)).toBe(SCHEMAS[DEFAULT_BASE_ID])
  })

  it('a known base resolves to that base’s tables', () => {
    const [first] = Object.keys(SCHEMAS)
    expect(schemaFor(first)).toBe(SCHEMAS[first])
  })

  it('an unsynced base throws, naming what to run', () => {
    expect(() => schemaFor('b0not0a0synced0base000000000')).toThrow(
      /no generated schema for base b0not0a0synced0base000000000.*topup\.mjs b0not0a0synced0base000000000/,
    )
  })

  it('T is the default schema when env is unset', () => {
    expect(T).toBe(SCHEMAS[DEFAULT_BASE_ID])
  })
})
