import { describe, expect, it, beforeEach, vi } from 'vitest'
import { APP_KEY, readLocal, writeLocal, clearLocal } from './localDb.ts'
import type { AppState } from '../types.ts'

/** localStorage does not exist under the node test environment — the smallest
 *  stand-in that exercises the read/write round trip honestly. key()/length are
 *  what spill enumeration walks, so they have to be real. */
const store = new Map<string, string>()
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
}

/** This tab's uid, held the way localDb holds it (sessionStorage). */
const TAB_KEY = 'roligt_foods_ops_tab'
const session = new Map<string, string>()
const fakeSession = {
  getItem: (k: string) => session.get(k) ?? null,
  setItem: (k: string, v: string) => void session.set(k, v),
}

/** What localDb touches of a Storage — explicit so a throwing variant stays assignable. */
interface FakeStorage {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
  key: (i: number) => string | null
  readonly length: number
}

/** Installs both storages fresh — spills included, which is the point. */
function setupStorage(over: FakeStorage = fakeStorage) {
  store.clear()
  session.clear()
  vi.stubGlobal('localStorage', over)
  vi.stubGlobal('sessionStorage', fakeSession)
  return () => vi.unstubAllGlobals()
}

const state = { counters: {} } as unknown as AppState

describe('localDb revision envelope', () => {
  beforeEach(() => setupStorage())

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
  beforeEach(() => setupStorage())

  it('round-trips the recorded base a dirty copy diffs against', () => {
    const base = { counters: { grn: 4 }, grns: [{ id: 'GRN-1' }] } as unknown as AppState
    writeLocal({ state, dirty: true, revision: '5:ab', base })
    expect(readLocal()).toMatchObject({ dirty: true, revision: '5:ab', base })
  })

  it('reads a copy written before bases existed as base-less', () => {
    localStorage.setItem(APP_KEY, JSON.stringify({ state, dirty: true, revision: '5:ab', savedAt: 'x' }))
    // null, not merely absent: the fold NAMES the degradation — the null-base
    // push (everything written, nothing removed), the same answer a spill
    // without a base gets
    expect(readLocal()?.base).toBeNull()
  })

  it('drops the base before the work when the quota refuses the full envelope', () => {
    const throwing = {
      getItem: fakeStorage.getItem,
      removeItem: fakeStorage.removeItem,
      key: fakeStorage.key,
      get length() {
        return store.size
      },
      setItem: (k: string, v: string) => {
        if (v.includes('"base"')) throw new DOMException('quota exceeded', 'QuotaExceededError')
        store.set(k, v)
      },
    }
    setupStorage(throwing)
    expect(writeLocal({ state, dirty: true, revision: '5:ab', base: { counters: {} } as unknown as AppState })).toBe(true)
    const back = readLocal()
    expect(back?.dirty).toBe(true) // the work itself survived
    expect(back?.base).toBeNull() // the base is what got let go — the null-base push is named, not implied
  })
})

describe('localDb mirror-failure honesty', () => {
  it('a storage that refuses everything answers false, not a swallowed throw', () => {
    const alwaysThrowing = {
      getItem: fakeStorage.getItem,
      removeItem: fakeStorage.removeItem,
      key: fakeStorage.key,
      get length() {
        return store.size
      },
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
    }
    setupStorage(alwaysThrowing)
    // dirty and clean alike: the caller can stop promising a copy that is not
    // being made
    expect(writeLocal({ state, dirty: true, revision: '5:ab' })).toBe(false)
    expect(writeLocal({ state, dirty: false, revision: '5:ab' })).toBe(false)
    expect(readLocal()).toBeNull()
  })
})

describe('localDb per-tab spill', () => {
  beforeEach(() => setupStorage())

  /** A one-vendor plant, so folds have a row to disagree about. */
  const plant = (name: string) =>
    ({ counters: {}, vendors: [{ id: 'V-1', name }] }) as unknown as AppState

  it("dirty work lands on this tab's spill, never the shared key", () => {
    session.set(TAB_KEY, 'tabA')
    expect(writeLocal({ state: plant('Sriram'), dirty: true, revision: '5:ab', base: plant('Sriram') })).toBe(true)
    expect(store.has(APP_KEY)).toBe(false) // the shared key was not touched
    expect(store.has(APP_KEY + ':t:tabA')).toBe(true) // the spill holds it
    expect(readLocal()).toMatchObject({ dirty: true, revision: '5:ab' })
  })

  it("a tab that saves promotes — the shared key holds it and that tab's spill goes", () => {
    session.set(TAB_KEY, 'tabA')
    writeLocal({ state: plant('Sriram'), dirty: true, revision: '5:ab' })
    writeLocal({ state: plant('Sriram'), dirty: false, revision: '6:cd' })
    expect(store.has(APP_KEY + ':t:tabA')).toBe(false) // spent
    expect(readLocal()).toMatchObject({ dirty: false, revision: '6:cd' })
  })

  it("a clean tab's APP_KEY write does not clobber a dirty tab's spill", () => {
    // the two-tab clobber the spill exists for: tab A posts a vendor offline;
    // tab B, clean, mirrors the older plant it sees over the shared key
    session.set(TAB_KEY, 'tabA')
    writeLocal({ state: plant('Sriram Farms'), dirty: true, revision: '5:ab', base: plant('Sriram') })
    session.set(TAB_KEY, 'tabB')
    writeLocal({ state: plant('Old Name'), dirty: false, revision: '6:cd' })
    expect(store.has(APP_KEY + ':t:tabA')).toBe(true) // A's work still stands
    const back = readLocal()
    // the fold is of the spills — the shared copy is a view of the server and
    // folding it back in would resurrect every row a spill deleted
    expect(back?.dirty).toBe(true)
    expect(back?.state.vendors.map((v: { id: string; name: string }) => v.name)).toEqual(['Sriram Farms'])
  })

  it('two dirty spills fold oldest-first — the newer write of a row wins', () => {
    vi.useFakeTimers()
    try {
      session.set(TAB_KEY, 'tabA')
      vi.setSystemTime(new Date('2026-09-30T08:00:00Z'))
      writeLocal({ state: plant('Sriram'), dirty: true, revision: '5:ab' })
      session.set(TAB_KEY, 'tabB')
      vi.setSystemTime(new Date('2026-09-30T09:00:00Z'))
      writeLocal({ state: plant('Sriram Foods'), dirty: true, revision: '5:ab' })
      const back = readLocal()
      expect(back?.dirty).toBe(true)
      expect(back?.state.vendors).toHaveLength(1) // upserted by id, not appended
      expect(back?.state.vendors[0]!.name).toBe('Sriram Foods') // the newer write won
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spill without a base degrades the whole merge to the null-base push', () => {
    session.set(TAB_KEY, 'tabA')
    writeLocal({ state: plant('Sriram'), dirty: true, revision: '5:ab', base: plant('Sriram') })
    // tab B lost its base to a quota squeeze: it knows nothing about the server,
    // so nothing anywhere in the merge may be diffed against one
    session.set(TAB_KEY, 'tabB')
    writeLocal({ state: plant('Sriram Foods'), dirty: true, revision: '5:ab' })
    expect(readLocal()?.base).toBeNull()
  })

  it('clearLocal sweeps the spill keys too', () => {
    session.set(TAB_KEY, 'tabA')
    writeLocal({ state: plant('Sriram'), dirty: true, revision: '5:ab' })
    session.set(TAB_KEY, 'tabB')
    writeLocal({ state: plant('Sriram'), dirty: false, revision: '6:cd' })
    expect(store.size).toBe(2) // APP_KEY + tabA's spill (tabB's was spent)
    clearLocal()
    expect(readLocal()).toBeNull()
    expect([...store.keys()].filter((k) => k.startsWith(APP_KEY))).toEqual([])
  })
})

describe('localDb audit cap', () => {
  beforeEach(() => setupStorage())

  /** Ascending distinct times — the audit mirror's own ordering. */
  const audits = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `A${String(i).padStart(4, '0')}`,
      time: new Date(Date.UTC(2026, 8, 30, 0, 0, i * 10)).toISOString(),
      role: 'a@b.c',
      action: 'posted',
      doc: 'GRN-1',
      details: '',
    }))

  it('keeps the most recent 3000 audits — the oldest go', () => {
    const many = { counters: {}, audits: audits(3005) } as unknown as AppState
    expect(writeLocal({ state: many, dirty: true, revision: '5:ab' })).toBe(true)
    const back = readLocal()
    expect(back?.state.audits).toHaveLength(3000) // exactly — the times are distinct
    expect(back?.state.audits.some((a: { id: string }) => a.id === 'A0000')).toBe(false) // the oldest went
    expect(back?.state.audits.at(-1)!.id).toBe('A3004') // the newest stayed, order preserved
  })

  it('caps the base as well — audits are insert-only, so a capped base changes no push', () => {
    const many = { counters: {}, audits: audits(3005) } as unknown as AppState
    writeLocal({ state: many, dirty: true, revision: '5:ab', base: many })
    const back = readLocal()
    expect(back?.base?.audits).toHaveLength(3000)
  })

  it('leaves a short audit list alone', () => {
    const few = { counters: {}, audits: audits(12) } as unknown as AppState
    writeLocal({ state: few, dirty: true, revision: '5:ab' })
    expect(readLocal()?.state.audits).toHaveLength(12)
  })
})
