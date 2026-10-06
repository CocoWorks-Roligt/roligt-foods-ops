import { describe, expect, it, vi } from 'vitest'
import { ZohoApiError, ZohoClient, ZohoLockedError } from './zoho.js'

/**
 * A fetchImpl that records calls and answers from a scripted map.
 * A reply may carry `raw` (a non-JSON body served verbatim, e.g. a proxy HTML error page)
 * or `body` (JSON-serialized).
 */
function fakeFetch(
  calls: { url: string; init?: RequestInit }[],
  replies: Array<{ status?: number; body?: unknown; raw?: string }>,
) {
  let tokenCalls = 0
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.startsWith('https://accounts.zoho.in')) {
      tokenCalls++
      return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }), { status: 200 })
    }
    const r = replies.shift()
    if (!r) throw new Error(`unexpected extra call: ${url}`)
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status ?? 200 })
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }
}

const ENV = { ZOHO_CLIENT_ID: 'ci', ZOHO_CLIENT_SECRET: 'cs', ZOHO_REFRESH_TOKEN: 'rt', ZOHO_BASE_ID: 'BASE' }

describe('ZohoClient', () => {
  it('fetches pages via the reference_record_id cursor until a short page', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const replies = [
      { body: { records: { fetched: [
        { recordID: 'r1', data: {} }, { recordID: 'r2', data: {} }, { recordID: 'r3', data: {} },
      ] } } },
      { body: { records: { fetched: [] } } },
    ]
    // force pagination by treating count as 3: use a client with page override
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, replies), env: ENV, page: 3 })
    const out = await c.fetchAll('T1')
    expect(out.map((r) => r.recordID)).toEqual(['r1', 'r2', 'r3'])
    // calls[0] is the token refresh, calls[1] the first page — the cursor appears on calls[2]
    const second = new URL(calls[2]!.url)
    expect(second.pathname).toBe('/api/v1/fetchRecordsWithCriteria')
    expect(second.searchParams.get('reference_record_id')).toBe('r3')
  })

  it('upserts by key with is_upsert_needed and string field-id criteria', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [{ body: { status: 'success' } }]), env: ENV })
    await c.upsertByKey('T1', 'FAPP', 'GRN-1', { FAPP: 'GRN-1', FDATA: '{"a":1}' })
    const u = new URL(calls[1]!.url)
    expect(u.pathname).toBe('/api/v1/records')
    expect(calls[1]!.init?.method).toBe('PUT')
    expect(u.searchParams.get('is_upsert_needed')).toBe('true')
    expect(u.searchParams.get('is_ids_used_in_params')).toBe('true')
    expect(u.searchParams.get('is_ids_used_in_data')).toBe('true')
    // The live probe (criteria-array-shape vs criteria-fieldid-string) pinned this:
    // Zoho 500s on the JSON-array criteria and accepts the string form below.
    expect(u.searchParams.get('criteria')).toBe('"FAPP" = "GRN-1"')
    expect(JSON.parse(u.searchParams.get('data')!)).toEqual({ FAPP: 'GRN-1', FDATA: '{"a":1}' })
    // small payloads ride the query string — no request body
    expect(calls[1]!.init?.body).toBeUndefined()
  })

  it('sends large upserts as an x-www-form-urlencoded body (query params 414 past ~4 KB)', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [{ body: { status: 'success' } }]), env: ENV })
    const big = 'x'.repeat(8192)
    await c.upsertByKey('T1', 'FAPP', 'GRN-1', { FAPP: 'GRN-1', FNOTES: big })
    const u = new URL(calls[1]!.url)
    expect(u.pathname).toBe('/api/v1/records')
    expect(u.search).toBe('') // everything moved out of the URL
    const ct = (calls[1]!.init as RequestInit & { headers: Record<string, string> }).headers['Content-Type']
    expect(ct).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(calls[1]!.init?.body))
    expect(body.get('criteria')).toBe('"FAPP" = "GRN-1"')
    expect(body.get('is_upsert_needed')).toBe('true')
    expect(body.get('is_ids_used_in_params')).toBe('true')
    expect(body.get('is_ids_used_in_data')).toBe('true')
    expect(JSON.parse(body.get('data')!)).toEqual({ FAPP: 'GRN-1', FNOTES: big })
  })

  it('refuses a key value containing a quote — no silent duplicate upserts', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, []), env: ENV })
    await expect(c.upsertByKey('T1', 'F', 'bad"key', {})).rejects.toThrow(/quote/)
    expect(calls.filter((x) => !x.url.startsWith('https://accounts.zoho.in'))).toHaveLength(0) // no API call left the building
  })

  it('maps a rate-limit lock response to ZohoLockedError', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { status: 429, body: { error: { code: 'LOCKED', message: 'API limit reached. Try after some time.' } } },
    ]), env: ENV })
    await expect(c.upsertByKey('T1', 'F', 'k', {})).rejects.toBeInstanceOf(ZohoLockedError)
  })

  it('maps a non-JSON 500 to ZohoApiError', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { status: 500, raw: '<html>Bad Gateway</html>' },
    ]), env: ENV })
    await expect(c.upsertByKey('T1', 'F', 'k', {})).rejects.toBeInstanceOf(ZohoApiError)
  })

  it('throws on a 200 carrying a Zoho error object', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { body: { error: { code: 'X', message: 'boom' } } },
    ]), env: ENV })
    await expect(c.upsertByKey('T1', 'F', 'k', {})).rejects.toBeInstanceOf(ZohoApiError)
  })

  it('does not treat healthy data mentioning limit as a lock', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { body: { records: { fetched: [{ recordID: 'r1', data: { f: 'credit limit ok' } }] } } },
    ]), env: ENV })
    const out = await c.fetchAll('T1')
    expect(out).toHaveLength(1)
    expect(out[0]!.recordID).toBe('r1')
  })

  it('reads a handful of keys as one criteria call each, flagging the criteria as field IDs', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { body: { records: { fetched: [{ recordID: 'r1', data: { FAPP: 'A' } }] } } },
      { body: { records: { fetched: [] } } },
    ]), env: ENV })
    const out = await c.fetchByKeyIn('T1', 'FAPP', ['A', 'B', 'A', ''])
    expect(out.map((r) => r.recordID)).toEqual(['r1'])
    const criteriaCalls = calls.filter((x) => x.url.includes('/fetchRecordsWithCriteria'))
    expect(criteriaCalls).toHaveLength(2) // deduped, blanks dropped
    expect(new URL(criteriaCalls[0]!.url).searchParams.get('criteria')).toBe('"FAPP" = "A"')
    expect(new URL(criteriaCalls[1]!.url).searchParams.get('criteria')).toBe('"FAPP" = "B"')
    // without the flag Zoho parses the criteria as field NAMES — a field-ID criteria
    // then answers HTTP 200 wrapping INTERNAL SERVER ERROR (pinned live 2026-09-28),
    // which is how every commit died in its pre-flight until this was sent
    for (const x of criteriaCalls) {
      expect(new URL(x.url).searchParams.get('is_ids_used_in_params')).toBe('true')
    }
  })

  it('reads nothing at all when no keys are named', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, []), env: ENV })
    expect(await c.fetchByKeyIn('T1', 'FAPP', [])).toEqual([])
    expect(calls.filter((x) => !x.url.startsWith('https://accounts'))).toHaveLength(0)
  })

  it('falls back to one paged sweep when more than ten keys are asked', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { body: { records: { fetched: [{ recordID: 'r1', data: {} }] } } },
    ]), env: ENV })
    await c.fetchByKeyIn('T1', 'F', Array.from({ length: 11 }, (_, i) => `K${i}`))
    // the sweep, not eleven criteria reads — a multi-value OR was never probed live
    expect(calls.filter((x) => x.url.includes('/fetchRecordsWithCriteria'))).toHaveLength(1)
  })

  it('refuses key values containing quotes — a broken criteria silently matches nothing', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, []), env: ENV })
    await expect(c.fetchByKeyIn('T1', 'F', ['bad"key'])).rejects.toThrow(/quote/)
    expect(calls.filter((x) => !x.url.startsWith('https://accounts'))).toHaveLength(0)
  })

  it('runs calls concurrently behind the budget — one refresh, overlapped reads', async () => {
    // The old everything-through-one-chain client ran one HTTP call at a time:
    // a 26-call snapshot sweep occupied it for its whole duration and any small
    // request queued behind all of it (a 35s admin action). The pool admits
    // several calls at once while the per-minute budgets stay untouched.
    const calls: { url: string; init?: RequestInit }[] = []
    let inFlight = 0
    let maxInFlight = 0
    const reply = () => new Response(JSON.stringify({ records: { fetched: [] } }), { status: 200 })
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.startsWith('https://accounts.zoho.in')) {
        await new Promise((r) => setTimeout(r, 5))
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return reply()
    }
    const c = new ZohoClient({ fetchImpl: f, env: ENV })
    await Promise.all(Array.from({ length: 6 }, () => c.fetchAll('T1')))
    // one token refresh shared by every concurrent first-call, not one each
    expect(calls.filter((x) => x.url.startsWith('https://accounts.zoho.in'))).toHaveLength(1)
    // the six reads genuinely overlapped instead of queueing one-at-a-time
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(6) // the pool's cap held
  })

  it('fails fast into ZohoLockedError when the budget wait would outlive maxWaitMs', async () => {
    vi.useFakeTimers()
    try {
      const calls: { url: string; init?: RequestInit }[] = []
      const empty = { body: { records: { fetched: [] } } }
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, Array.from({ length: 26 }, () => empty)),
        env: ENV,
        maxWaitMs: 1_000,
      })
      for (let i = 0; i < 26; i++) await c.fetchAll('T1') // the read budget is spent at t0
      // a minute nearly gone: the next read would have to wait past the cap —
      // sleeping there used to run the function into its platform timeout with
      // rows half-written; now it throws, and the handler answers 503 + Retry-After
      vi.setSystemTime(Date.now() + 59_000)
      const err: unknown = await c.fetchAll('T1').catch((e) => e)
      expect(err).toBeInstanceOf(ZohoLockedError)
      expect((err as ZohoLockedError).retryAfterSec).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- the split read budget: sweeps self-restrain, interactive keeps its slots ----

  it('a sweep past its cap waits for its own window while an interactive read walks through', async () => {
    vi.useFakeTimers()
    try {
      const calls: { url: string; init?: RequestInit }[] = []
      const empty = { body: { records: { fetched: [] } } }
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, Array.from({ length: 8 }, () => empty)),
        env: ENV,
        sweepReadsPerMin: 3,
      })
      for (let i = 0; i < 3; i++) await c.fetchAll('T1', { scope: 'sweep' }) // sweep window spent at t0
      // the 4th sweep read sleeps out its own window — it does NOT throw, and it
      // does NOT reach the wire yet
      const fourth = c.fetchAll('T1', { scope: 'sweep' })
      await Promise.resolve()
      const before = calls.filter((x) => !x.url.startsWith('https://accounts')).length
      // an interactive read lands immediately: the global 26 still has 23 slots
      await c.fetchByKeyIn('T1', 'F', ['K'])
      expect(calls.filter((x) => !x.url.startsWith('https://accounts')).length).toBe(before + 1)
      // the window slides and the parked sweep read completes — pacing alone never throws
      await vi.advanceTimersByTimeAsync(61_000)
      await fourth
    } finally {
      vi.useRealTimers()
    }
  })

  it('sweep reads count against the global 26 too — the shared window is unchanged', async () => {
    vi.useFakeTimers()
    try {
      const calls: { url: string; init?: RequestInit }[] = []
      const empty = { body: { records: { fetched: [] } } }
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, Array.from({ length: 27 }, () => empty)),
        env: ENV,
        sweepReadsPerMin: 18,
        maxWaitMs: 1_000,
      })
      // 18 sweeps + 8 interactive = the whole global window at t0
      for (let i = 0; i < 18; i++) await c.fetchAll('T1', { scope: 'sweep' })
      for (let i = 0; i < 8; i++) await c.fetchAll('T1')
      vi.setSystemTime(Date.now() + 59_000)
      // the 27th read — interactive — fails fast exactly as it always did
      const err: unknown = await c.fetchAll('T1').catch((e) => e)
      expect(err).toBeInstanceOf(ZohoLockedError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a cold burst rides past the sweep cap but never past the global 26 — and the sweep window still learned', async () => {
    vi.useFakeTimers()
    try {
      const calls: { url: string; init?: RequestInit }[] = []
      const empty = { body: { records: { fetched: [] } } }
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, Array.from({ length: 7 }, () => empty)),
        env: ENV,
        sweepReadsPerMin: 3,
      })
      // the cold sweep's shape: a whole table set burst in parallel, past the
      // self-cap that would otherwise park reads 4+ for a minute — the ~60s
      // cold GET /api/snapshot this exists to skip (pinned on the dev log,
      // 2026-10-06)
      await Promise.all(Array.from({ length: 6 }, () => c.fetchAll('T1', { scope: 'cold' })))
      const wire = calls.filter((x) => !x.url.startsWith('https://accounts'))
      expect(wire).toHaveLength(6) // every cold read reached the wire, zero timer slides
      // the burst was not free: it recorded into the sweep window, so the next
      // WARM sweep still paces itself — once per process, not a new hole
      const paced = c.fetchAll('T1', { scope: 'sweep' })
      await Promise.resolve()
      expect(calls.filter((x) => !x.url.startsWith('https://accounts'))).toHaveLength(6)
      await vi.advanceTimersByTimeAsync(61_000)
      await paced
    } finally {
      vi.useRealTimers()
    }
  })

  it('26 cold reads spend the whole global window — the 27th read fails fast exactly as before', async () => {
    vi.useFakeTimers()
    try {
      const calls: { url: string; init?: RequestInit }[] = []
      const empty = { body: { records: { fetched: [] } } }
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, Array.from({ length: 27 }, () => empty)),
        env: ENV,
        maxWaitMs: 1_000,
      })
      // a cold sweep is exactly 26 reads — one per mapped table plus Counters
      // plus Config — which is precisely the global burst capacity
      for (let i = 0; i < 26; i++) await c.fetchAll('T1', { scope: 'cold' })
      vi.setSystemTime(Date.now() + 59_000)
      const err: unknown = await c.fetchAll('T1').catch((e) => e)
      expect(err).toBeInstanceOf(ZohoLockedError) // `cold` bought pace, never headroom
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- fetchSince: the delta read behind the snapshot sweep ----
  // `contains` on the Data JSON column keyed by hour buckets — the only criteria form
  // the live probe found working (scripts/zoho/probe-since.mjs, 2026-09-30). Every
  // wire test pins the clock: the bucket range runs to the current hour.

  it('fetchSince sends one contains-per-hour-bucket criteria, paged by cursor, deduped by record', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-30T10:30:00Z'))
      const calls: { url: string; init?: RequestInit }[] = []
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, [
          // bucket 08: a full page then a short one (cursor paging within a bucket)
          { body: { records: { fetched: [
            { recordID: 'r1', data: { FAPP: 'L1' } }, { recordID: 'r2', data: { FAPP: 'L2' } }, { recordID: 'r3', data: { FAPP: 'L3' } },
          ] } } },
          { body: { records: { fetched: [] } } },
          // bucket 09: one row — a false-positive superset re-mentioning L1's id
          { body: { records: { fetched: [{ recordID: 'r1', data: { FAPP: 'L1' } }, { recordID: 'r4', data: { FAPP: 'L4' } }] } } },
          // bucket 10: nothing
          { body: { records: { fetched: [] } } },
        ]),
        env: ENV,
        page: 3,
      })
      const out = await c.fetchSince('LEDGER', 'jRNMfg', '2026-09-30T08:00:00.000Z', { scope: 'sweep' })
      // r1 appears in two buckets' replies and survives once — superset merges are idempotent
      expect(out.map((r) => r.data.FAPP)).toEqual(['L1', 'L2', 'L3', 'L4'])
      const pages = calls.filter((x) => x.url.includes('/fetchRecordsWithCriteria'))
      expect(pages).toHaveLength(4)
      const criteria = pages.map((x) => new URL(x.url).searchParams.get('criteria'))
      expect(criteria).toEqual([
        '"jRNMfg" contains "2026-09-30T08"',
        '"jRNMfg" contains "2026-09-30T08"',
        '"jRNMfg" contains "2026-09-30T09"',
        '"jRNMfg" contains "2026-09-30T10"',
      ])
      // without the flag a field-ID criteria answers HTTP 200 wrapping INTERNAL SERVER
      // ERROR (pinned live 2026-09-28) — the delta read would look like "no rows"
      for (const x of pages) expect(new URL(x.url).searchParams.get('is_ids_used_in_params')).toBe('true')
      // the cursor continues WITHIN a bucket's pages
      expect(new URL(pages[1]!.url).searchParams.get('reference_record_id')).toBe('r3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetchSince refuses a gap wider than maxBuckets — the caller falls back to a full read', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
      const calls: { url: string; init?: RequestInit }[] = []
      const c = new ZohoClient({ fetchImpl: fakeFetch(calls, []), env: ENV })
      // a weekend-idle device: ~53 hour buckets between watermark and now
      await expect(c.fetchSince('T1', 'jRNMfg', '2026-09-28T07:00:00.000Z')).rejects.toThrow(/too wide/)
      expect(calls.filter((x) => !x.url.startsWith('https://accounts'))).toHaveLength(0) // not one read spent
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetchSince refuses a watermark containing a quote — no silently-broken criteria', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, []), env: ENV })
    await expect(c.fetchSince('T1', 'jRNMfg', 'bad"mark')).rejects.toThrow(/quote/)
    expect(calls.filter((x) => !x.url.startsWith('https://accounts'))).toHaveLength(0)
  })

  it('fetchSince propagates a wrapped INTERNAL SERVER ERROR as a loud failure, never as empty', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-30T08:30:00Z'))
      const calls: { url: string; init?: RequestInit }[] = []
      const c = new ZohoClient({
        fetchImpl: fakeFetch(calls, [
          { body: { error: { code: 500, message: 'INTERNAL SERVER ERROR' } } }, // HTTP 200 wrapping failure
        ]),
        env: ENV,
      })
      // a delta read that silently read as "nothing new" would cache a watermark the
      // rows behind it never reached — the sweep must fail loudly and fall back
      await expect(c.fetchSince('T1', 'jRNMfg', '2026-09-30T08:00:00.000Z')).rejects.toBeInstanceOf(ZohoApiError)
    } finally {
      vi.useRealTimers()
    }
  })
})
