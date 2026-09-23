import { describe, expect, it } from 'vitest'
import { ZohoApiError, ZohoClient, ZohoLockedError } from './zoho.ts'

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
})
