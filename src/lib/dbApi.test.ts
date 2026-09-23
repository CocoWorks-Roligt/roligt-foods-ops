import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchRevision, saveDb, UnauthorizedError } from './dbApi'
import type { AppState } from '../types'
import { setAuthTokenProvider, setUnauthorizedHandler } from './authToken'

/**
 * Pins the Kinde token lifecycle dbApi implements: a current token on every
 * request, exactly one forced-refresh retry when the BFF answers 401, and a
 * dead session (401 twice) reported as UnauthorizedError — never as offline.
 */

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

let unauthorizedNotified = false
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  unauthorizedNotified = false
  setUnauthorizedHandler(() => {
    unauthorizedNotified = true
  })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  setUnauthorizedHandler(null)
  setAuthTokenProvider(async () => null)
  vi.unstubAllGlobals()
})

describe('api token handling', () => {
  it('sends the provider’s current token as the Bearer header', async () => {
    setAuthTokenProvider(async () => 'token-a')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { revision: 7 }))
    await expect(fetchRevision()).resolves.toBe(7)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-a')
  })

  it('refreshes once and retries when the first token is refused', async () => {
    const tokens = ['stale-token', 'fresh-token']
    setAuthTokenProvider(async (force) => (force ? tokens[1] : tokens[0]))
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { revision: 9 }))
    await expect(fetchRevision()).resolves.toBe(9)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(new Headers(retryInit?.headers).get('authorization')).toBe('Bearer fresh-token')
    expect(unauthorizedNotified).toBe(false)
  })

  it('reports UnauthorizedError and notifies auth when the refresh does not help', async () => {
    setAuthTokenProvider(async (force) => (force ? 'still-dead' : 'dead'))
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Sign in first.' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Sign in first.' }))
    await expect(fetchRevision()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(unauthorizedNotified).toBe(true)
  })

  it('does not retry when no fresh token can be minted', async () => {
    setAuthTokenProvider(async () => null)
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Sign in first.' }))
    await expect(fetchRevision()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(unauthorizedNotified).toBe(true)
  })
})

describe('saveDb unauthorized mapping', () => {
  it('maps a dead session to the unauthorized result, not an exception', async () => {
    setAuthTokenProvider(async () => 'dead')
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Sign in first.' }))
    const result = await saveDb({ vendors: [] } as unknown as AppState, null)
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'Your session expired — sign in again.',
    })
  })
})
