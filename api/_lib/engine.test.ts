/**
 * The facade's dispatch — the whole point of the engine seam. Every store-
 * shaped call the routes make lands on ONE of the two arms, chosen by the
 * D1_* env and nothing else; these tests pin that choice for each export and
 * the two behaviors the facade adds of its own accord: the cross-engine
 * commit queue (one write at a time per process, and a rejected commit never
 * jams it) and invalidateSnapshotCache's deliberate no-op under D1, where the
 * revision token IS the invalidation.
 *
 * Every collaborator is mocked because the arms' own correctness is pinned
 * where it lives (commit.test.ts, d1Engine.test.ts) — this file asks only
 * "which arm answered, and did the argument arrive untouched".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import * as engine from './engine.js'
import { Conflict } from './commitGates.js'

vi.mock('./snapshot.js', () => ({
  readSnapshotCached: vi.fn(async () => 'ZOHO-SNAPSHOT'),
  readRevisionMemoized: vi.fn(async () => 'ZOHO-REVISION'),
  invalidateSnapshotCache: vi.fn(),
}))
vi.mock('./commit.js', () => ({
  commitChanges: vi.fn(async () => 'ZOHO-COMMIT'),
}))
vi.mock('./adminAudit.js', () => ({
  writeAdminAudit: vi.fn(async () => 'ZOHO-AUDIT'),
  writeAdminAuditD1: vi.fn(async () => 'D1-AUDIT'),
}))
vi.mock('./d1Snapshot.js', () => ({
  readSnapshotD1: vi.fn(async () => 'D1-SNAPSHOT'),
  readRevisionD1: vi.fn(async () => 'D1-REVISION'),
}))
vi.mock('./d1Commit.js', () => ({
  commitChangesD1: vi.fn(async () => 'D1-COMMIT'),
}))
vi.mock('./complianceStore.js', () => ({
  zohoComplianceStore: vi.fn(() => 'ZOHO-COMPLIANCE'),
}))
vi.mock('./d1Compliance.js', () => ({
  d1ComplianceStore: vi.fn(() => 'D1-COMPLIANCE'),
}))

import { readSnapshotCached as zohoSnap, readRevisionMemoized as zohoRev, invalidateSnapshotCache as zohoInvalidate } from './snapshot.js'
import { commitChanges as zohoCommit } from './commit.js'
import { writeAdminAudit as zohoAudit, writeAdminAuditD1 } from './adminAudit.js'
import { readSnapshotD1, readRevisionD1 } from './d1Snapshot.js'
import { commitChangesD1 } from './d1Commit.js'
import { zohoComplianceStore } from './complianceStore.js'
import { d1ComplianceStore } from './d1Compliance.js'

const caller: Caller = { email: 'boss@roligt.local', permissions: [] }
const changes: StateChanges = { empty: false, tables: [], counters: {} }
const store = {} as Parameters<typeof engine.readSnapshotCached>[0]

/** The cutover switch, flipped exactly as shared.ts would read it. */
const setD1 = (on: boolean): void => {
  if (on) {
    process.env.D1_DATABASE_ID = 'db-x'
    process.env.D1_API_TOKEN = 'tok-x'
    process.env.D1_ACCOUNT_ID = 'acct-x'
  } else {
    delete process.env.D1_DATABASE_ID
    delete process.env.D1_API_TOKEN
    delete process.env.D1_ACCOUNT_ID
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setD1(false)
})
afterEach(() => {
  setD1(false)
})

describe('the engine facade', () => {
  it('routes every store-shaped call to the D1 arm when the D1_* env is set — the same store object, untouched', async () => {
    setD1(true)
    await expect(engine.readSnapshotCached(store)).resolves.toBe('D1-SNAPSHOT')
    await expect(engine.readRevisionMemoized(store)).resolves.toBe('D1-REVISION')
    await expect(engine.commitChanges(store, caller, changes)).resolves.toBe('D1-COMMIT')
    await expect(engine.writeAdminAudit(store, caller, 'role changed', 'ops@roligt.local', 'granted')).resolves.toBe('D1-AUDIT')
    expect(engine.complianceStore(store)).toBe('D1-COMPLIANCE')
    // the arm received the very object handed in — no adaptation, no copy
    expect(vi.mocked(readSnapshotD1).mock.calls[0][0]).toBe(store)
    expect(vi.mocked(readRevisionD1).mock.calls[0][0]).toBe(store)
    expect(vi.mocked(commitChangesD1).mock.calls[0]).toEqual([store, caller, changes])
    expect(vi.mocked(writeAdminAuditD1).mock.calls[0]).toEqual([store, caller, 'role changed', 'ops@roligt.local', 'granted'])
    expect(vi.mocked(d1ComplianceStore).mock.calls[0][0]).toBe(store)
    // and the Zoho arm never stirred
    expect(zohoSnap).not.toHaveBeenCalled()
    expect(zohoRev).not.toHaveBeenCalled()
    expect(zohoCommit).not.toHaveBeenCalled()
    expect(zohoAudit).not.toHaveBeenCalled()
    expect(zohoComplianceStore).not.toHaveBeenCalled()
  })

  it('routes every call to the Zoho arm when the env is absent — today deployment, unchanged', async () => {
    await expect(engine.readSnapshotCached(store)).resolves.toBe('ZOHO-SNAPSHOT')
    await expect(engine.readRevisionMemoized(store)).resolves.toBe('ZOHO-REVISION')
    await expect(engine.commitChanges(store, caller, changes)).resolves.toBe('ZOHO-COMMIT')
    await expect(engine.writeAdminAudit(store, caller, 'role changed', 'ops@roligt.local', 'granted')).resolves.toBe('ZOHO-AUDIT')
    expect(engine.complianceStore(store)).toBe('ZOHO-COMPLIANCE')
    expect(vi.mocked(zohoSnap).mock.calls[0][0]).toBe(store)
    expect(vi.mocked(zohoRev).mock.calls[0][0]).toBe(store)
    expect(vi.mocked(zohoCommit).mock.calls[0]).toEqual([store, caller, changes])
    expect(vi.mocked(zohoAudit).mock.calls[0]).toEqual([store, caller, 'role changed', 'ops@roligt.local', 'granted'])
    expect(readSnapshotD1).not.toHaveBeenCalled()
    expect(readRevisionD1).not.toHaveBeenCalled()
    expect(commitChangesD1).not.toHaveBeenCalled()
    expect(writeAdminAuditD1).not.toHaveBeenCalled()
    expect(d1ComplianceStore).not.toHaveBeenCalled()
  })

  it('serializes commits per process: the second write does not start until the first lands', async () => {
    setD1(true)
    let started = 0
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    vi.mocked(commitChangesD1).mockImplementation(async () => {
      started++
      if (started === 1) await gate
      return { token: `${started}:x`, wrote: true }
    })
    const a = engine.commitChanges(store, caller, changes)
    const b = engine.commitChanges(store, caller, changes)
    await vi.waitFor(() => {
      expect(started).toBe(1) // the queue holds the second behind the first's landing
    })
    releaseFirst()
    const [ra, rb] = await Promise.all([a, b])
    expect(started).toBe(2)
    expect(ra).toEqual({ token: '1:x', wrote: true })
    expect(rb).toEqual({ token: '2:x', wrote: true })
  })

  it('a rejected commit does not jam the queue — the next waiter still runs', async () => {
    setD1(true)
    vi.mocked(commitChangesD1)
      .mockImplementationOnce(() => Promise.reject(new Error('the store refused')))
      .mockImplementationOnce(async () => ({ token: '2:x', wrote: true }))
    const a = engine.commitChanges(store, caller, changes).then(
      () => null,
      (e: unknown) => e,
    )
    const b = await engine.commitChanges(store, caller, changes)
    expect(await a).toBeInstanceOf(Error)
    expect(b).toEqual({ token: '2:x', wrote: true })
  })

  it('invalidateSnapshotCache is a no-op under D1 (the token is the invalidation) and delegates on the Zoho arm', () => {
    setD1(true)
    engine.invalidateSnapshotCache('2026-10-08T00:00:00Z')
    expect(zohoInvalidate).not.toHaveBeenCalled()
    setD1(false)
    engine.invalidateSnapshotCache('2026-10-08T00:00:00Z')
    expect(zohoInvalidate).toHaveBeenCalledWith('2026-10-08T00:00:00Z')
  })

  it('re-exports the shared verdict classes — a route catch keeps its one class object across engines', () => {
    expect(engine.Conflict).toBe(Conflict)
    expect(new engine.Conflict([])).toBeInstanceOf(Conflict)
  })
})
