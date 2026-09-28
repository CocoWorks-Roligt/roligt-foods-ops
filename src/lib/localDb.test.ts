import { describe, expect, it, beforeEach, vi } from 'vitest'
import { APP_KEY, readLocal, writeLocal, clearLocal } from './localDb.ts'
import type { AppState } from '../types.ts'

/** localStorage does not exist under the node test environment — the smallest
 *  stand-in that exercises the read/write round trip honestly. */
const store = new Map<string, string>()
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

const state = { counters: {} } as unknown as AppState

describe('localDb revision envelope', () => {
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    return () => vi.unstubAllGlobals()
  })

  it('round-trips the revision a clean copy was saved at', () => {
    writeLocal({ state, dirty: false, revision: 7 })
    expect(readLocal()).toMatchObject({ dirty: false, revision: 7 })
  })

  it('reads a copy written before revisions were recorded as revision-less', () => {
    localStorage.setItem(APP_KEY, JSON.stringify({ state, dirty: false, savedAt: 'x' }))
    expect(readLocal()?.revision).toBeUndefined()
    // and a legacy bare state (pre-envelope) still reads as dirty
    localStorage.setItem(APP_KEY, JSON.stringify(state))
    const bare = readLocal()
    expect(bare?.dirty).toBe(true)
    expect(bare?.revision).toBeUndefined()
  })

  it('clears', () => {
    writeLocal({ state, dirty: false, revision: 7 })
    clearLocal()
    expect(readLocal()).toBeNull()
  })
})

describe('localDb base envelope', () => {
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', fakeStorage)
    return () => vi.unstubAllGlobals()
  })

  it('round-trips the recorded base a dirty copy diffs against', () => {
    const base = { counters: { grn: 4 }, grns: [{ id: 'GRN-1' }] } as unknown as AppState
    writeLocal({ state, dirty: true, revision: '5:ab', base })
    expect(readLocal()).toMatchObject({ dirty: true, revision: '5:ab', base })
  })

  it('reads a copy written before bases existed as base-less', () => {
    localStorage.setItem(APP_KEY, JSON.stringify({ state, dirty: true, revision: '5:ab', savedAt: 'x' }))
    expect(readLocal()?.base).toBeUndefined()
  })

  it('drops the base before the work when the quota refuses the full envelope', () => {
    const throwing = {
      getItem: fakeStorage.getItem,
      removeItem: fakeStorage.removeItem,
      setItem: (k: string, v: string) => {
        if (v.includes('"base"')) throw new DOMException('quota exceeded', 'QuotaExceededError')
        store.set(k, v)
      },
    }
    vi.stubGlobal('localStorage', throwing)
    writeLocal({ state, dirty: true, revision: '5:ab', base: { counters: {} } as unknown as AppState })
    const back = readLocal()
    expect(back?.dirty).toBe(true) // the work itself survived
    expect(back?.base).toBeUndefined() // the base is what got let go — the null-base push takes over
  })
})
