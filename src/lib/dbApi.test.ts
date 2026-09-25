import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchRevision, saveDb, UnauthorizedError, ThrottledError } from './dbApi'
import type { AppState } from '../types'
import { setUnauthorizedHandler } from './authEvents'

// These tests pin the dev-fallback contract, which holds only while WorkOS is
// unconfigured — a developer's .env.local (VITE_WORKOS_CLIENT_ID set for
// localhost testing) must not decide which mode the suite exercises.
vi.mock('./authMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authMode')>()),
  WORKOS_CONFIGURED: false,
}))

/**
 * Pins the cookie-session contract dbApi implements: the request carries no
 * Authorization header ever (the httpOnly cookie is the credential, refreshed
 * server-side), a single 401 is final — UnauthorizedError plus the auth event,
 * no retry — and a 503 with Retry-After is throttling. Unconfigured (no
 * VITE_WORKOS_CLIENT_ID), every request also carries the dev picker's role.
 */

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

let unauthorizedNotified = false
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  unauthorizedNotified = false
  setUnauthorizedHandler(() => {
    unauthorizedNotified = true
  })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // getDevRole reads localStorage, which the node test environment lacks.
  vi.stubGlobal('localStorage', { getItem: () => 'Operator', setItem: vi.fn() })
})

afterEach(() => {
  setUnauthorizedHandler(null)
  vi.unstubAllGlobals()
})

describe('api request shape', () => {
  it('sends the cookie credential and the dev role header — never an Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { revision: 7 }))
    await expect(fetchRevision()).resolves.toBe(7)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/revision')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('authorization')).toBeNull()
    expect(new Headers(init.headers).get('x-dev-role')).toBe('Operator') // the picker's choice
  })
})

describe('api session handling', () => {
  it('reports UnauthorizedError and notifies auth on a single 401 — no retry exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Sign in first.' }))
    await expect(fetchRevision()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(unauthorizedNotified).toBe(true)
  })

  it('maps a 503 with Retry-After to ThrottledError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'busy' }, { 'retry-after': '120' }))
    const err: unknown = await fetchRevision().catch((e) => e)
    expect(err).toBeInstanceOf(ThrottledError)
    expect((err as ThrottledError).retryAfterSec).toBe(120)
    expect(unauthorizedNotified).toBe(false)
  })
})

describe('saveDb unauthorized mapping', () => {
  it('maps a dead session to the unauthorized result, not an exception', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Sign in first.' }))
    const result = await saveDb({ vendors: [] } as unknown as AppState, null)
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'Your session expired — sign in again.',
    })
  })
})
