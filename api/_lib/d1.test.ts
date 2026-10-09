import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1ApiError, D1Client } from './d1.js'
import { LockedError } from './store.js'

/**
 * The D1 client's own contract: the wire shapes it emits, the envelopes it
 * accepts, and — the part the routes depend on — the error mapping that turns
 * provider trouble into LockedError's 503 + Retry-After shape. The store's
 * SQL behavior is pinned by d1Engine.test.ts against real SQLite; this suite
 * never leaves the fetch stub.
 */
const ENV = { D1_ACCOUNT_ID: 'acct', D1_DATABASE_ID: 'db', D1_API_TOKEN: 'tok' }
const OK = { success: true, result: [{ results: [{ one: 1 }], success: true, meta: { changes: 1 } }] }

const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

function client() {
  return new D1Client({ ...ENV } as NodeJS.ProcessEnv)
}

describe('D1Client', () => {
  it('refuses construction without its env', () => {
    expect(() => new D1Client({} as NodeJS.ProcessEnv)).toThrow(/D1_ACCOUNT_ID/)
  })

  it('posts the documented single-query shape and returns result rows', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => OK })
    const rows = await client().query<{ one: number }>('SELECT 1 AS one')
    expect(rows).toEqual([{ one: 1 }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query')
    expect(init.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ sql: 'SELECT 1 AS one', params: [] })
  })

  it('posts batches under the batch key and returns per-statement results with meta', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ success: true, result: [{ results: [], success: true, meta: { changes: 0 } }, { results: [{ v: 'x' }], success: true, meta: { changes: 1 } }] }),
    })
    const out = await client().batch([{ sql: 'DELETE FROM t' }, { sql: 'UPDATE t SET v=? RETURNING v', params: ['x'] }])
    expect(out).toEqual([
      { results: [], meta: { changes: 0 } },
      { results: [{ v: 'x' }], meta: { changes: 1 } },
    ])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ batch: [{ sql: 'DELETE FROM t', params: [] }, { sql: 'UPDATE t SET v=? RETURNING v', params: ['x'] }] })
  })

  it('maps HTTP 429 to the LockedError shape (60s)', async () => {
    fetchMock.mockResolvedValueOnce({ status: 429, json: async () => ({ success: false, errors: [] }) })
    const err = await client().query('SELECT 1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockedError)
    expect((err as LockedError).retryAfterSec).toBe(60)
  })

  it('retries a 5xx once for reads, then surfaces LockedError(30) if it persists', async () => {
    fetchMock.mockResolvedValueOnce({ status: 503, json: async () => ({ success: false }) })
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => OK })
    expect(await client().query('SELECT 1')).toEqual([{ one: 1 }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockResolvedValueOnce({ status: 503, json: async () => ({ success: false }) })
    fetchMock.mockResolvedValueOnce({ status: 503, json: async () => ({ success: false }) })
    const err = await client().query('SELECT 1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockedError)
    expect((err as LockedError).retryAfterSec).toBe(30)
  })

  it('never retries a batch — a 5xx is one call and a LockedError', async () => {
    fetchMock.mockResolvedValueOnce({ status: 500, json: async () => ({ success: false }) })
    const err = await client().batch([{ sql: 'INSERT INTO t VALUES (1)' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a refused statement (success:false) as D1ApiError with the provider message', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 400,
      json: async () => ({ success: false, errors: [{ code: 75000, message: 'CHECK constraint failed: _assert_changed' }] }),
    })
    const err = await client().batch([{ sql: 'INSERT INTO _assert_changed VALUES (0)' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(D1ApiError)
    expect((err as D1ApiError).message).toContain('_assert_changed')
    expect((err as D1ApiError).code).toBe(75000)
  })

  it('refuses params near the 2 MB row cap before anything travels', async () => {
    const huge = 'x'.repeat(1_500_001)
    const err = await client().query('INSERT INTO t VALUES (?)', [huge]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(D1ApiError)
    expect((err as D1ApiError).message).toMatch(/row-size/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
