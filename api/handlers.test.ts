import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Handler-level tests: the Retry-After plumbing, the status-code mapping and the
 * shared ZohoClient. The commit path runs for real end to end below (real ZohoClient
 * from the shared module, real commitChanges, only the network stubbed); the snapshot
 * and revision handlers fake the reader lib, because a real sweep fans one fetch out
 * per mapped table and the real client's read budget is 26/min — a cooperative base
 * would stall the suite for sixty seconds, which is the client doing its job.
 */
const mode = vi.hoisted(() => ({
  locked: false,
  retryAfterSec: 120,
  permissions: [] as string[],
  setCookies: null as string[] | null,
}))

vi.mock('./_lib/auth.ts', () => ({
  authenticate: vi.fn(async () => ({
    caller: { email: 'who@roligt.local', permissions: mode.permissions },
    ...(mode.setCookies ? { setCookies: mode.setCookies } : {}),
  })),
  AuthError: class AuthError extends Error {},
}))

vi.mock('./_lib/shared.ts', async () => {
  const { ZohoClient, ZohoLockedError } = await vi.importActual<typeof import('./_lib/zoho.ts')>('./_lib/zoho.ts')
  const fetchImpl = async (url: string) => {
    if (url.startsWith('https://accounts.zoho.in')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    if (mode.locked) throw new ZohoLockedError(mode.retryAfterSec)
    return new Response(JSON.stringify({ records: { fetched: [] } }), { status: 200 })
  }
  return { zoho: new ZohoClient({ fetchImpl, env: {} as Record<string, string | undefined> }) }
})

vi.mock('./_lib/snapshot.ts', async () => {
  const { ZohoLockedError } = await vi.importActual<typeof import('./_lib/zoho.ts')>('./_lib/zoho.ts')
  const guard = async <A,>(v: A): Promise<A> => {
    if (mode.locked) throw new ZohoLockedError(mode.retryAfterSec)
    return v
  }
  return {
    readSnapshot: vi.fn(async () => guard({ state: null, revision: 0, everWritten: false })),
    readSnapshotCached: vi.fn(async () => guard({ state: null, revision: 0, everWritten: false })),
    readRevision: vi.fn(async () => guard(0)),
    invalidateSnapshotCache: vi.fn(),
  }
})

const commit = (await import('./commit.ts')).default
const snapshot = (await import('./snapshot.ts')).default
const revision = (await import('./revision.ts')).default
const { zoho } = await import('./_lib/shared.ts')
const { ZohoClient } = await import('./_lib/zoho.ts')

beforeEach(() => {
  mode.locked = false
  mode.retryAfterSec = 120
  mode.permissions = ['masters.manage', 'staff.manage', 'config.manage', 'audit.manage', 'admin.manage']
  mode.setCookies = null
})

function fakeRes() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
  }
  return res as unknown as VercelResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> }
}

function fakeReq(body: unknown): VercelRequest {
  return { headers: {}, url: '/', method: 'POST', body } as unknown as VercelRequest
}

describe('handlers', () => {
  it('answers a clean commit with { revision } through the shared client', async () => {
    const res = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ revision: 1 })
  })

  it('rejects a malformed commit payload with 400', async () => {
    const res = fakeRes()
    await commit(fakeReq({ nope: true }), res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('maps Forbidden to 403 with the table named', async () => {
    mode.permissions = []
    const res = fakeRes()
    await commit(fakeReq({ changes: { empty: false, tables: [{ table: 'vendors', upsert: [{ id: 'V-1', data: {} }], remove: [] }], counters: {} } }), res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ table: 'vendors' }))
  })

  it('forwards refreshed session cookies on every data handler and reports the caller permissions', async () => {
    mode.setCookies = ['wos-session=re-sealed; Path=/; HttpOnly']
    const rs = fakeRes()
    await snapshot(fakeReq(null), rs)
    expect(rs.setHeader).toHaveBeenCalledWith('Set-Cookie', mode.setCookies)
    expect(rs.json).toHaveBeenCalledWith({ state: null, revision: 0, permissions: mode.permissions })
    const rr = fakeRes()
    await revision(fakeReq(null), rr)
    expect(rr.setHeader).toHaveBeenCalledWith('Set-Cookie', mode.setCookies)
    const rc = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), rc)
    expect(rc.setHeader).toHaveBeenCalledWith('Set-Cookie', mode.setCookies)
  })

  it('surfaces a Zoho lock as 503 + Retry-After on every handler', async () => {
    mode.locked = true
    mode.retryAfterSec = 300
    for (const handler of [commit, snapshot, revision]) {
      const res = fakeRes()
      await handler(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '300')
      expect(res.status).toHaveBeenCalledWith(503)
    }
  })

  it('answers snapshot and revision reads and reports the shared client', async () => {
    const rs = fakeRes()
    await snapshot(fakeReq(null), rs)
    expect(rs.status).toHaveBeenCalledWith(200)
    expect(rs.json).toHaveBeenCalledWith({ state: null, revision: 0, permissions: mode.permissions })
    const rr = fakeRes()
    await revision(fakeReq(null), rr)
    expect(rr.status).toHaveBeenCalledWith(200)
    expect(rr.json).toHaveBeenCalledWith({ revision: 0 })
    // one client for the whole BFF — the budget is global per API key, not per request
    expect(zoho).toBeInstanceOf(ZohoClient)
  })
})
