import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDb, ThrottledError } from './dbApi.ts'

/**
 * The throttle contract's client half (the audit's S3-11): both refusal
 * statuses — the BFF's own token buckets (429) and the Zoho lock it forwards
 * (503) — carry the server's Retry-After, and api() folds them into one
 * ThrottledError so AppContext's save-retry scheduler waits the server's own
 * hint rather than a fixed 30 s probe. fetch is stubbed; nothing leaves the tab.
 */
const stubFetch = (status: number, headers: Record<string, string> = {}) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: null, revision: '0' }), { status, headers }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('api — the throttle mapping', () => {
  it('maps a 429 to ThrottledError carrying the server\'s Retry-After', async () => {
    stubFetch(429, { 'retry-after': '17' })
    const err = await fetchDb().catch((e) => e)
    expect(err).toBeInstanceOf(ThrottledError)
    expect((err as ThrottledError).retryAfterSec).toBe(17)
  })

  it('keeps the 503 mapping and falls back to 60 s when the header is missing', async () => {
    stubFetch(503)
    const err = await fetchDb().catch((e) => e)
    expect(err).toBeInstanceOf(ThrottledError)
    expect((err as ThrottledError).retryAfterSec).toBe(60)
  })

  it('does not throw ThrottledError for an ordinary failure — that is saveDb\'s branch', async () => {
    stubFetch(500)
    const err = await fetchDb().catch((e) => e)
    expect(err).not.toBeInstanceOf(ThrottledError)
    expect((err as Error).message).toContain('Failed to read the plant')
  })
})

describe('fetchDb — one snapshot on the wire at a time', () => {
  /**
   * 2026-10-07: while Zoho choked, one tab stacked four pending /api/snapshot
   * requests — the boot read, the poll and a conflict adoption each asking while
   * another's request still hung on the server's budget wait, every stacked call
   * another read the shared window had to answer. Concurrent callers now share
   * the in-flight request instead of adding to it.
   */
  it('shares the in-flight request across concurrent callers', async () => {
    let release!: (r: Response) => void
    const fetchMock = vi.fn(
      async () => new Promise<Response>((resolve) => (release = resolve)),
    )
    vi.stubGlobal('fetch', fetchMock)
    const a = fetchDb()
    const b = fetchDb()
    release(new Response(JSON.stringify({ state: null, revision: '9' }), { status: 200 }))
    const [ra, rb] = await Promise.all([a, b])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ra.revision).toBe('9')
    expect(rb.revision).toBe('9')
  })

  it('frees the slot when the request settles, so a later caller retries fresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('no', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: null, revision: '2' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await fetchDb().catch((e) => e)
    expect(first).toBeInstanceOf(ThrottledError)
    const second = await fetchDb()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.revision).toBe('2')
  })
})
