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
