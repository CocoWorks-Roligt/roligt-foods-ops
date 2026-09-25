import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSession } from './authSession'

/** The boot fetch's contract: 200 maps, 401 is signed-out, nothing else is guessed. */

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchSession', () => {
  it('maps a 200 to the session and its permissions', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { user: { email: 'lead@roligt.local' }, permissions: ['masters.manage'] }),
    )
    await expect(fetchSession()).resolves.toEqual({
      session: { user: { email: 'lead@roligt.local' } },
      permissions: ['masters.manage'],
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/auth/session')
    expect(init.credentials).toBe('same-origin')
  })

  it('reads a 401 as signed out', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Sign in first.' }))
    await expect(fetchSession()).resolves.toBeNull()
  })

  it('throws on anything else — a broken deploy is not a silent logout', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'Auth is not configured on the server.' }))
    await expect(fetchSession()).rejects.toThrow('HTTP 503')
  })

  it('tolerates a body without a usable user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { permissions: [] }))
    await expect(fetchSession()).resolves.toBeNull()
  })
})
