// @vitest-environment happy-dom
/**
 * The theme switch: the stored choice resolves and paints, a refused storage
 * never breaks the session, and the toggle's cycle covers all three stops.
 * The OS follower is exercised through the media query happy-dom stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  initTheme,
  nextTheme,
  readTheme,
  resolvedTheme,
  writeTheme,
} from './theme.ts'

const mediaMatches = vi.fn().mockReturnValue(false)
vi.stubGlobal('matchMedia', vi.fn().mockImplementation((q: string) => ({
  matches: mediaMatches(),
  media: q,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})))

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    mediaMatches.mockReturnValue(false)
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('defaults to system and resolves through the media query', () => {
    expect(readTheme()).toBe('system')
    expect(resolvedTheme('system')).toBe('light')
    mediaMatches.mockReturnValue(true)
    expect(resolvedTheme('system')).toBe('dark')
  })

  it('paints the resolved theme on the document', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    mediaMatches.mockReturnValue(true)
    applyTheme('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('writes, reads and re-applies a pinned choice', () => {
    writeTheme('dark')
    expect(readTheme()).toBe('dark')
    initTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('survives a storage that refuses (private mode)', () => {
    const throwing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('refused')
    })
    expect(() => writeTheme('light')).not.toThrow()
    expect(document.documentElement.dataset.theme).toBe('light')
    throwing.mockRestore()
  })

  it('cycles system → light → dark → system', () => {
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })
})
