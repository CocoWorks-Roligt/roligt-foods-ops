import { describe, expect, it } from 'vitest'
import {
  fmtDeltaPct,
  inWindow,
  isWholeMonth,
  monthEnd,
  monthOf,
  monthWindow,
  monthsBetween,
  windowLabel,
} from './params.ts'

describe('report windows', () => {
  it('builds a month window from its key', () => {
    expect(monthWindow('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(monthEnd('2026-02')).toBe('2026-02-28')
    expect(monthEnd('2028-02')).toBe('2028-02-29')
  })

  it('reads a month off a date key by prefix', () => {
    expect(monthOf('2026-09-14')).toBe('2026-09')
    expect(monthOf(undefined)).toBe('')
  })

  it('includes both endpoints of a window', () => {
    const w = monthWindow('2026-08')
    expect(inWindow('2026-08-01', w)).toBe(true)
    expect(inWindow('2026-08-31', w)).toBe(true)
    expect(inWindow('2026-07-31', w)).toBe(false)
    expect(inWindow('2026-09-01', w)).toBe(false)
    expect(inWindow(undefined, w)).toBe(false)
  })

  it('lists every month a window spans, unaligned ends included', () => {
    expect(monthsBetween({ from: '2026-08-15', to: '2026-10-02' })).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
    ])
    expect(monthsBetween(monthWindow('2026-09'))).toEqual(['2026-09'])
  })

  it('labels a whole month by name and a span by its ends', () => {
    expect(windowLabel(monthWindow('2026-09'))).toBe('September 2026')
    expect(isWholeMonth({ from: '2026-08-15', to: '2026-08-31' })).toBe(false)
    expect(windowLabel({ from: '2026-08-15', to: '2026-08-31' })).toBe('15 – 31 Aug 2026')
    expect(windowLabel({ from: '2026-08-15', to: '2026-09-02' })).toBe('15 Aug – 2 Sep 2026')
  })
})

describe('percentage change', () => {
  it('formats rise and fall to one decimal', () => {
    expect(fmtDeltaPct(100, 120.6)).toBe('+20.6%')
    expect(fmtDeltaPct(200, 194)).toBe('-3.0%')
  })

  it('refuses a percentage of nothing', () => {
    expect(fmtDeltaPct(0, 50)).toBe('—')
  })
})
