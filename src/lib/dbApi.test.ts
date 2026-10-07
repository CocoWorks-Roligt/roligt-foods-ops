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
