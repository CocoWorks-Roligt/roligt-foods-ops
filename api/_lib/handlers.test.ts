import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { T } from './baseSchema.js'
import { __resetCommitThrottle } from './commitThrottle.js'

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
  /** When set: criteria reads naming this key answer one stored row — the
   *  pre-flight's view of a document another device already saved. */
  existing: null as { key: string; appId: string; fields: Record<string, string> } | null,
}))

vi.mock('./auth.ts', () => ({
  authenticate: vi.fn(async () => ({
    caller: { email: 'who@roligt.local', permissions: mode.permissions },
    ...(mode.setCookies ? { setCookies: mode.setCookies } : {}),
  })),
  AuthError: class AuthError extends Error {},
}))

vi.mock('./shared.ts', async () => {
  const { ZohoClient, ZohoLockedError } = await vi.importActual<typeof import('./zoho.ts')>('./zoho.ts')
  const fetchImpl = async (url: string) => {
    if (url.startsWith('https://accounts.zoho.in')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    if (mode.locked) throw new ZohoLockedError(mode.retryAfterSec)
    // small POSTs carry their params on the query string (see zoho.ts call()) —
    // the criteria naming the row appears in the URL, not the body
    if (mode.existing && url.includes('/fetchRecordsWithCriteria') && url.includes(mode.existing.key)) {
      return new Response(
        JSON.stringify({
          records: { fetched: [{ recordID: 'z-1', data: { [mode.existing.appId]: mode.existing.key, ...mode.existing.fields } }] },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ records: { fetched: [] } }), { status: 200 })
  }
  return { zoho: new ZohoClient({ fetchImpl, env: {} as Record<string, string | undefined> }) }
})

vi.mock('./snapshot.ts', async () => {
  const { ZohoLockedError } = await vi.importActual<typeof import('./zoho.ts')>('./zoho.ts')
  const guard = async <A,>(v: A): Promise<A> => {
    if (mode.locked) throw new ZohoLockedError(mode.retryAfterSec)
    return v
  }
  return {
    readSnapshot: vi.fn(async () => guard({ state: null, revision: '0', everWritten: false })),
    readSnapshotCached: vi.fn(async () => guard({ state: null, revision: '0', everWritten: false })),
    readRevision: vi.fn(async () => guard('0')),
    readRevisionMemoized: vi.fn(async () => guard('0')),
    invalidateSnapshotCache: vi.fn(),
    // the real commit lib imports these off the same mocked module
    noteRevision: vi.fn(),
    cachedRevision: vi.fn(() => null),
    noteCommitApplied: vi.fn(),
    cachedLedgerWatermark: vi.fn(() => null),
  }
})

const commit = (await import('../commit.ts')).default
const snapshot = (await import('../snapshot.ts')).default
const revision = (await import('../revision.ts')).default
const { zoho } = await import('./shared.ts')
const { ZohoClient } = await import('./zoho.ts')

beforeEach(() => {
  mode.locked = false
  mode.retryAfterSec = 120
  mode.permissions = ['masters.manage', 'staff.manage', 'config.manage', 'audit.manage', 'admin.manage']
  mode.setCookies = null
  mode.existing = null
  __resetCommitThrottle() // every test's caller starts with a fresh bucket
})

function fakeRes() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
  }
  return res as unknown as VercelResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> }
}

function fakeReq(body: unknown, headers: Record<string, string> = {}): VercelRequest {
  return {
    headers: { 'content-type': 'application/json', ...headers },
    url: '/',
    method: 'POST',
    body,
  } as unknown as VercelRequest
}

describe('handlers', () => {
  it('answers a clean empty commit with the unchanged revision — a no-op bumps nothing', async () => {
    const res = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    // no rows, no counters, no config: nothing landed, so the revision this empty
    // base already sits at ('0' — nothing was ever written) goes straight back
    expect(res.json).toHaveBeenCalledWith({ revision: '0' })
  })

  it('throttles one caller — a burst fired rapid-fire gets 429 with Retry-After', async () => {
    const codes: number[] = []
    // seventeen rapid commits from one email: a fresh bucket holds the sustained
    // minute's worth (8), so the ninth through the seventeenth are refused — the
    // shared Zoho budget is not one device's to drain.
    for (let i = 0; i < 17; i++) {
      const res = fakeRes()
      await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
      codes.push(res.status.mock.calls[0][0])
    }
    expect(codes.slice(0, 8)).toEqual(Array(8).fill(200))
    expect(codes.slice(8)).toEqual(Array(9).fill(429))
    // the refusal carries the same Retry-After shape the Zoho lock's 503 does
    const refused = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), refused)
    expect(refused.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String))
    expect(refused.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Too many commits') }),
    )
  })

  it('refills at the sustained rate and earns the burst by idleness', async () => {
    vi.useFakeTimers()
    try {
      const fire = async () => {
        const res = fakeRes()
        await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
        return {
          status: res.status.mock.calls[0][0] as number,
          retryAfter: res.setHeader.mock.calls.find((c) => c[0] === 'Retry-After')?.[1] as
            | string
            | undefined,
        }
      }
      // spend the fresh eight; the ninth is told to wait one token's refill (7.5 s → 8)
      for (let i = 0; i < 8; i++) expect((await fire()).status).toBe(200)
      const refused = await fire()
      expect(refused.status).toBe(429)
      expect(refused.retryAfter).toBe('8')
      // a minute later exactly the sustained eight have come back — the ninth still waits
      vi.advanceTimersByTime(60_000)
      for (let i = 0; i < 8; i++) expect((await fire()).status).toBe(200)
      expect((await fire()).status).toBe(429)
      // two idle minutes at once and the bucket has earned its full burst of sixteen
      vi.advanceTimersByTime(120_000)
      for (let i = 0; i < 16; i++) expect((await fire()).status).toBe(200)
      expect((await fire()).status).toBe(429)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps a lost save race to 409 with the conflicting rows named', async () => {
    const t = T['GRNs']
    // the colleague's receipt is already up there under this device's minted code
    mode.existing = {
      key: 'GRN-2026-0001',
      appId: t.appId,
      fields: { [t.dataJson!]: JSON.stringify({ id: 'GRN-2026-0001', lot: 'LOT-B', total: 50 }) },
    }
    const res = fakeRes()
    await commit(
      fakeReq({
        changes: {
          empty: false,
          tables: [{ table: 'grns', upsert: [{ id: 'GRN-2026-0001', data: { id: 'GRN-2026-0001', lot: 'LOT-1', total: 100 } }], remove: [] }],
          counters: {},
        },
      }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ conflicts: [{ table: 'grns', id: 'GRN-2026-0001', kind: 'exists' }] }),
    )
  })

  it('rejects a malformed commit payload with 400', async () => {
    const res = fakeRes()
    await commit(fakeReq({ nope: true }), res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('refuses a body that is not application/json — a form-stitched CSRF never reaches the parser', async () => {
    // text/plain is the one enctype a form can use whose body survives the
    // platform's pre-parsing as a string; the route must not JSON.parse it
    const res = fakeRes()
    await commit(fakeReq('{"changes":{"tables":[],"p":', { 'content-type': 'text/plain' }), res)
    expect(res.status).toHaveBeenCalledWith(415)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('application/json') }))
    const none = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }, { 'content-type': '' }), none)
    expect(none.status).toHaveBeenCalledWith(415)
  })

  it('rejects an unparsable string body with 400, not a 500 from JSON.parse', async () => {
    const res = fakeRes()
    await commit(fakeReq('{"changes":', { 'content-type': 'application/json' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('rejects a payload naming a table the app does not write with 400 — before any Zoho read', async () => {
    const res = fakeRes()
    await commit(
      fakeReq({
        changes: { empty: false, tables: [{ table: 'vendor_types', upsert: [{ id: 'VT-1', data: {} }], remove: [] }], counters: {} },
      }),
      res,
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('vendor_types') }))
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
    expect(rs.json).toHaveBeenCalledWith({ state: null, revision: '0', permissions: mode.permissions })
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
    expect(rs.json).toHaveBeenCalledWith({ state: null, revision: '0', permissions: mode.permissions })
    const rr = fakeRes()
    await revision(fakeReq(null), rr)
    expect(rr.status).toHaveBeenCalledWith(200)
    expect(rr.json).toHaveBeenCalledWith({ revision: '0' })
    // one client for the whole BFF — the budget is global per API key, not per request
    expect(zoho).toBeInstanceOf(ZohoClient)
  })
})
