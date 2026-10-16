import { describe, expect, it, vi } from 'vitest'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'

/**
 * The engine facade, post-Zoho: every call lands on the D1 arm, a null store
 * (an unconfigured deployment) refuses with the LockedError ladder the routes
 * already map to 503 + Retry-After, and the commit mutex serializes — a
 * rejected commit never jams the queue. The D1 arm's own behavior is pinned
 * where it lives (d1Engine.test.ts).
 */
vi.mock('./d1Commit.js', () => ({
  commitChangesD1: vi.fn(async () => ({ token: 'D1-COMMIT', wrote: true })),
}))
vi.mock('./d1Snapshot.js', () => ({
  readSnapshotD1: vi.fn(async () => 'D1-SNAPSHOT'),
  readRevisionD1: vi.fn(async () => 'D1-REV'),
  noteD1Revision: vi.fn(),
  resetD1Caches: vi.fn(),
}))
vi.mock('./adminAudit.js', () => ({
  writeAdminAuditD1: vi.fn(async () => undefined),
}))
vi.mock('./d1Compliance.js', () => ({
  d1ComplianceStore: vi.fn(() => 'D1-STORE' as unknown as never),
}))

const engine = await import('./engine.js')
const d1Commit = await import('./d1Commit.js')
const d1Snapshot = await import('./d1Snapshot.js')
const adminAudit = await import('./adminAudit.js')
const d1Compliance = await import('./d1Compliance.js')

const store = { databaseId: 'db' } as never
const caller: Caller = { email: 'who@roligt.local', permissions: [] }
const changes: StateChanges = { tables: [], counters: {}, empty: false }

describe('the engine facade', () => {
  it('hands every call to the D1 arm', async () => {
    await engine.readSnapshotCached(store)
    expect(d1Snapshot.readSnapshotD1).toHaveBeenCalledWith(store)
    await engine.readRevisionMemoized(store)
    expect(d1Snapshot.readRevisionD1).toHaveBeenCalledWith(store)
    await engine.commitChanges(store, caller, changes)
    expect(d1Commit.commitChangesD1).toHaveBeenCalledWith(store, caller, changes)
    await engine.writeAdminAudit(store, caller, 'role changed', 'ops@roligt.local', 'granted page.vendors')
    expect(adminAudit.writeAdminAuditD1).toHaveBeenCalledWith(store, caller, 'role changed', 'ops@roligt.local', 'granted page.vendors')
    expect(engine.complianceStore(store)).toBe('D1-STORE')
    expect(d1Compliance.d1ComplianceStore).toHaveBeenCalledWith(store)
  })

  it('refuses a null store with the LockedError ladder — never a TypeError', async () => {
    for (const call of [
      () => engine.readSnapshotCached(null),
      () => engine.readRevisionMemoized(null),
      () => engine.commitChanges(null, caller, changes),
      () => engine.writeAdminAudit(null, caller, 'a', 'b', 'c'),
    ]) {
      await expect(call()).rejects.toMatchObject({ retryAfterSec: 86_400 })
    }
    // the one sync seam: complianceStore hands back a store object, so the
    // refusal is the throw itself (the route's try/catch owns it)
    expect(() => engine.complianceStore(null)).toThrow(expect.objectContaining({ retryAfterSec: 86_400 }))
  })

  it('serializes commits — a rejected one never jams the queue', async () => {
    const order: string[] = []
    let refuse = true
    vi.mocked(d1Commit.commitChangesD1).mockImplementation(async () => {
      if (refuse) {
        order.push('reject')
        throw new Error('assert table trip')
      }
      order.push('accept')
      return { token: '7:nonce', wrote: true }
    })
    const first = engine.commitChanges(store, caller, changes)
    await expect(first).rejects.toThrow('assert table trip')
    refuse = false // the queue stays live — the next waiter runs clean
    const second = engine.commitChanges(store, caller, changes)
    await expect(second).resolves.toMatchObject({ token: '7:nonce' })
    expect(order).toEqual(['reject', 'accept'])
  })

  it('re-exports the shared gates as the same class objects the routes catch', async () => {
    const gates = await import('./commitGates.js')
    expect(engine.Forbidden).toBe(gates.Forbidden)
    expect(engine.Conflict).toBe(gates.Conflict)
    expect(engine.Malformed).toBe(gates.Malformed)
    expect(engine.validateChanges).toBe(gates.validateChanges)
  })
})
