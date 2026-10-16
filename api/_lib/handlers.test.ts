import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { __resetCommitThrottle } from './commitThrottle.js'
import { __resetSnapshotThrottle } from './snapshotThrottle.js'

/**
 * Handler-level tests: the Retry-After plumbing, the status-code mapping and
 * the shared store handle. The routes run for real end to end below (real
 * validators, real throttles, real projection), with only the engine seam
 * faked — the D1 arm's own behavior is pinned where it lives (d1Engine.test.ts).
 * The fake below answers the empty plant ('0', never written) the way a fresh
 * database does; the levers reproduce the outcomes the arm can throw.
 */
const mode = vi.hoisted(() => ({
  locked: false,
  retryAfterSec: 120,
  permissions: [] as string[],
  setCookies: null as string[] | null,
  /** When set: an upsert naming this id is already saved up there — the
   *  pre-flight's view of a document another device committed first. */
  existing: null as string | null,
  /** When set: a commit touching this table is refused by the write gate. */
  forbid: null as string | null,
  /** When set: every engine call throws it — the handler's catch-all. */
  failWith: null as Error | null,
}))

vi.mock('./auth.ts', () => ({
  authenticate: vi.fn(async () => ({
    caller: { email: 'who@roligt.local', permissions: mode.permissions },
    ...(mode.setCookies ? { setCookies: mode.setCookies } : {}),
  })),
  AuthError: class AuthError extends Error {},
}))

vi.mock('./engine.ts', async () => {
  const actual = await vi.importActual<typeof import('./engine.ts')>('./engine.ts')
  const { LockedError } = await vi.importActual<typeof import('./store.ts')>('./store.ts')
  const { Conflict, Forbidden } = await vi.importActual<typeof import('./commitGates.ts')>('./commitGates.ts')
  const EMPTY = { state: null, revision: '0', everWritten: false }
  const guard = async <A,>(v: A): Promise<A> => {
    if (mode.failWith) throw mode.failWith
    if (mode.locked) throw new LockedError(mode.retryAfterSec)
    return v
  }
  return {
    ...actual,
    readSnapshotCached: vi.fn(() => guard(EMPTY)),
    readRevisionMemoized: vi.fn(() => guard('0')),
    commitChanges: vi.fn(async (_store: unknown, _caller: unknown, changes: { tables: { table: string; upsert: { id: string }[] }[]; counters: Record<string, unknown> }) => {
      await guard(undefined)
      // the write gate's refusal (the arm consults the caller's pages — the
      // route's 403 mapping is what this file pins)
      if (mode.forbid && changes.tables.some((t) => t.table === mode.forbid)) throw new Forbidden(mode.forbid)
      // the pre-flight's lost race: the row exists under the device's minted id
      for (const t of changes.tables) {
        if (mode.existing && t.upsert.some((row) => row.id === mode.existing)) {
          throw new Conflict([{ table: t.table, id: mode.existing, kind: 'exists' }])
        }
      }
      // nothing to write: the revision this base already sits at goes straight back
      if (!changes.tables.length && !Object.keys(changes.counters ?? {}).length) {
        return { token: '0', wrote: false }
      }
      return { token: '7:1', wrote: true }
    }),
  }
})

const commit = (await import('../commit.ts')).default
const snapshot = (await import('../snapshot.ts')).default
const revision = (await import('../revision.ts')).default

beforeEach(() => {
  mode.locked = false
  mode.retryAfterSec = 120
  mode.permissions = ['masters.manage', 'staff.manage', 'config.manage', 'audit.manage', 'admin.manage']
  mode.setCookies = null
  mode.existing = null
  mode.forbid = null
  mode.failWith = null
  __resetCommitThrottle() // every test's caller starts with a fresh bucket
  __resetSnapshotThrottle() // and a fresh snapshot bucket beside it
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

  it('answers a server failure with a generic body — internal error text stays in the server log', async () => {
    // the catch-all used to hand e.message to the caller, and a D1ApiError
    // carries slices of the raw upstream response: base ids, table ids, API
    // internals. The wire gets the retry promise; the log gets the detail.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    mode.failWith = new Error('upstream detail naming database 8f3a-4bb2-9c1d and tables')
    const res = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
    expect(res.status).toHaveBeenCalledWith(500)
    const body = res.json.mock.calls[0][0] as { error: string }
    expect(body.error).not.toContain('8f3a-4bb2')
    expect(body.error).not.toContain('upstream')
    expect(body.error).toContain('retry')
    expect(err).toHaveBeenCalled() // the detail landed in the log, not the wire
    err.mockRestore()
  })

  it('throttles one caller — a burst fired rapid-fire gets 429 with Retry-After', async () => {
    const codes: number[] = []
    // seventeen rapid commits from one email: a fresh bucket holds the sustained
    // minute's worth (8), so the ninth through the seventeenth are refused — the
    // store's write budget is not one device's to drain.
    for (let i = 0; i < 17; i++) {
      const res = fakeRes()
      await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
      codes.push(res.status.mock.calls[0][0])
    }
    expect(codes.slice(0, 8)).toEqual(Array(8).fill(200))
    expect(codes.slice(8)).toEqual(Array(9).fill(429))
    // the refusal carries the same Retry-After shape the store lock's 503 does
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
    // the colleague's receipt is already up there under this device's minted code
    mode.existing = 'GRN-2026-0001'
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

  it('rejects a payload naming a table the app does not write with 400 — before any store read', async () => {
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
    mode.forbid = 'vendors'
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
    expect(rs.json).toHaveBeenCalledWith({ state: null, revision: '0', permissions: mode.permissions, withheld: [], flags: [] })
    const rr = fakeRes()
    await revision(fakeReq(null), rr)
    expect(rr.setHeader).toHaveBeenCalledWith('Set-Cookie', mode.setCookies)
    const rc = fakeRes()
    await commit(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), rc)
    expect(rc.setHeader).toHaveBeenCalledWith('Set-Cookie', mode.setCookies)
  })

  it('surfaces a store lock as 503 + Retry-After on every handler', async () => {
    mode.locked = true
    mode.retryAfterSec = 300
    for (const handler of [commit, snapshot, revision]) {
      const res = fakeRes()
      await handler(fakeReq({ changes: { tables: [], counters: {}, empty: false } }), res)
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '300')
      expect(res.status).toHaveBeenCalledWith(503)
    }
  })

  it('answers snapshot and revision reads from the one shared store handle', async () => {
    const rs = fakeRes()
    await snapshot(fakeReq(null), rs)
    expect(rs.status).toHaveBeenCalledWith(200)
    expect(rs.json).toHaveBeenCalledWith({ state: null, revision: '0', permissions: mode.permissions, withheld: [], flags: [] })
    const rr = fakeRes()
    await revision(fakeReq(null), rr)
    expect(rr.status).toHaveBeenCalledWith(200)
    expect(rr.json).toHaveBeenCalledWith({ revision: '0' })
  })

  it('throttles snapshot reads per account — a burst fired rapid-fire gets 429 with Retry-After', async () => {
    // the read-side twin of the commit throttle (the audit's S2-5 interim): a
    // snapshot spend is shared plant budget — every warm miss a batch, every
    // moved revision a fresh assemble — so one account hammering /api/snapshot
    // is refused BEFORE a read is spent. A fresh bucket holds the sustained
    // minute's worth (6); the honest client (boot two calls, the poll ~3/min)
    // never meets it.
    const codes: number[] = []
    for (let i = 0; i < 8; i++) {
      const res = fakeRes()
      await snapshot(fakeReq(null), res)
      codes.push(res.status.mock.calls[0][0])
    }
    expect(codes.slice(0, 6)).toEqual(Array(6).fill(200))
    expect(codes.slice(6)).toEqual(Array(2).fill(429))
    const refused = fakeRes()
    await snapshot(fakeReq(null), refused)
    expect(refused.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String))
    expect(refused.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Too many snapshot reads') }),
    )
  })

  it('speaks the caller page scope in the snapshot body — withheld names the tables this caller may not read', async () => {
    // a suppliers clerk: procurement receipts and the audit trail are withheld;
    // the masters they hold, and the ledger and counters their own page needs,
    // are not. The faked engine serves a null plant here and the list is the
    // same a full one would answer — that constancy is pinned in snapshot.test.ts.
    mode.permissions = ['page.vendors']
    const scoped = fakeRes()
    await snapshot(fakeReq(null), scoped)
    const body = scoped.json.mock.calls[0][0] as { withheld: string[] }
    expect(body.withheld).toContain('grns')
    expect(body.withheld).toContain('audits')
    expect(body.withheld).not.toContain('vendors')
    expect(body.withheld).not.toContain('ledger')
    // the operator (no page slugs at all) reads the whole plant — nothing withheld
    mode.permissions = []
    const open = fakeRes()
    await snapshot(fakeReq(null), open)
    expect((open.json.mock.calls[0][0] as { withheld: string[] }).withheld).toEqual([])
  })
})
