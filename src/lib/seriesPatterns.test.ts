import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERIES_PATTERNS,
  legacyPatternOf,
  periodKeyForPattern,
  seriesPatternOf,
} from './seriesPatterns'
import { NUMBER_SERIES, periodKeyFor, ruleFor } from './numbering'
import type { Config, NumberingRule } from '../types'

/**
 * The leaf is the shared truth for period claims: the server's counter gate
 * judges a `period:*` value by exactly this arithmetic, so these tests pin it
 * to numbering.ts — the patterns the client mints with, the merge `ruleFor`
 * performs, and the periods `periodKeyFor` computes may never drift apart.
 */
describe('seriesPatterns — the leaf the server judges period claims by', () => {
  it('mirrors every built-in series pattern numbering.ts defines, key for key', () => {
    expect(Object.keys(DEFAULT_SERIES_PATTERNS).sort()).toEqual(NUMBER_SERIES.map((s) => s.key).sort())
    for (const s of NUMBER_SERIES) expect(DEFAULT_SERIES_PATTERNS[s.key]).toBe(s.pattern)
  })

  it('resolves the same pattern ruleFor resolves — saved, legacy and default alike', () => {
    const cfg = (rule: NumberingRule) => ({ numbering: [rule] }) as Config
    for (const s of NUMBER_SERIES) {
      // no saved rule: the built-in default
      expect(seriesPatternOf(undefined, s.key)).toBe(ruleFor(undefined, s.key).pattern)
      // a saved pattern wins
      const saved: NumberingRule = { key: s.key, prefix: 'X', pattern: '{P}/{N}', pad: 3 }
      expect(seriesPatternOf(saved, s.key)).toBe(ruleFor(cfg(saved), s.key).pattern)
      // a rule saved before patterns existed reads as its legacy shape
      const legacy: NumberingRule = { key: s.key, prefix: 'X', pattern: '', pad: 3, middle: 'year', separator: '/' }
      expect(seriesPatternOf(legacy, s.key)).toBe(ruleFor(cfg(legacy), s.key).pattern)
    }
    // an unknown series runs the plain default, exactly as ruleFor's fallback does
    expect(seriesPatternOf(undefined, 'neverHeardOfIt')).toBe(ruleFor(undefined, 'neverHeardOfIt').pattern)
  })

  it('computes periodKeyFor exactly as numbering.ts does, for every series', () => {
    const when = new Date(2026, 9, 7, 15, 4, 5)
    for (const s of NUMBER_SERIES) {
      const rule = ruleFor(undefined, s.key)
      expect(periodKeyForPattern(rule.pattern, when)).toBe(periodKeyFor(rule, when))
    }
  })

  it('reads a legacy rule as the pattern it meant', () => {
    const base = { key: 'grn', prefix: 'RFTC', pattern: '', pad: 4 }
    expect(legacyPatternOf({ ...base, middle: 'year' })).toBe('{P}-{YYYY}-{N}')
    expect(legacyPatternOf({ ...base, middle: 'date', separator: '/' })).toBe('{P}/{YYYYMMDD}/{N}')
    expect(legacyPatternOf({ ...base })).toBe('{P}-{N}')
  })

  it('is inert on garbage from a crafted app_config — never throws, never mints a period', () => {
    // a non-string pattern is not "saved", it is absent; the legacy shape (no
    // date tokens) reads back an empty period rather than exploding
    const garbage = { key: 'grn', prefix: 7, pattern: { evil: true }, pad: 'x' } as unknown as NumberingRule
    expect(seriesPatternOf(garbage, 'grn')).toBe('{P}-{N}')
    expect(periodKeyForPattern('{P}-{N}', new Date())).toBe('')
    expect(periodKeyForPattern('no tokens here at all', new Date())).toBe('')
    // unknown tokens print literally and carry no period
    expect(periodKeyForPattern('{P}{WHEN}{N}', new Date())).toBe('')
  })
})
