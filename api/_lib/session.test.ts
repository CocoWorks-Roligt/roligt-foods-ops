import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, type AuthKitConfig } from '@workos/authkit-session'
import {
  authServiceFor,
  deriveRedirectUri,
  setCookiesOf,
  sessionCookieName,
  VercelCookieSessionStorage,
  workosConfigured,
} from './session.js'

/**
 * The pure halves of the adapter: cookie parsing (which MUST URL-decode — PKCE
 * state verification byte-compares against the decoded seal) and header-bag
 * collection. The networked halves (withAuth, the OAuth routes) are covered by
 * the authenticate tests via __setAuthenticator and the real Phase 2 drive.
 */
const CONFIG: AuthKitConfig = {
  clientId: 'client',
  apiKey: 'sk_test',
  redirectUri: 'http://localhost:3000/api/auth/callback',
  cookiePassword: 'x'.repeat(32),
  apiHostname: 'api.eu.workos.com',
  apiHttps: true,
  cookieMaxAge: 60 * 60 * 24,
  cookieName: 'wos-session',
}

const storage = new VercelCookieSessionStorage(CONFIG)

describe('VercelCookieSessionStorage.getCookie', () => {
  it('finds the named cookie among many and URL-decodes its value', async () => {
    const req = new Request('https://bff.roligt.local/api/revision', {
      headers: { cookie: 'first=1; wos-session=Fe26.2%2Babc%3D%3D; last=2' },
    })
    // the seal was written with encodeURIComponent; byte-comparison against the
    // original happens on the DECODED value, so raw '+' would break PKCE state
    await expect(storage.getCookie(req, 'wos-session')).resolves.toBe('Fe26.2+abc==')
  })

  it('returns null for a missing cookie or absent header', async () => {
    const req = new Request('https://bff.roligt.local/api/revision', {
      headers: { cookie: 'other=1' },
    })
    await expect(storage.getCookie(req, 'wos-session')).resolves.toBeNull()
    await expect(storage.getCookie(new Request('https://bff.roligt.local/'), 'wos-session')).resolves.toBeNull()
  })

  it('round-trips through the base class serializer', async () => {
    // protected on the base class; reached through a prototype cast for the test
    const serialize = (
      VercelCookieSessionStorage.prototype as unknown as {
        serializeCookie: (name: string, value: string, options: Record<string, unknown>) => string
      }
    ).serializeCookie.bind(storage)
    const header = serialize('wos-session', 'Fe26.2+abc==', { path: '/', httpOnly: true })
    const req = new Request('https://x/', { headers: { cookie: header } })
    await expect(storage.getCookie(req, 'wos-session')).resolves.toBe('Fe26.2+abc==')
  })
})

describe('setCookiesOf', () => {
  it('reads one cookie or a list, never comma-joined', () => {
    expect(setCookiesOf(undefined)).toEqual([])
    expect(setCookiesOf({})).toEqual([])
    expect(setCookiesOf({ 'Set-Cookie': 'a=1; Path=/' })).toEqual(['a=1; Path=/'])
    expect(setCookiesOf({ 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] })).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  })
})

describe('deriveRedirectUri', () => {
  it('prefers the forwarded host and proto a proxy provides', () => {
    const req = new Request('https://internal/', {
      headers: { 'x-forwarded-host': 'ops.roligt.example', 'x-forwarded-proto': 'https' },
    })
    expect(deriveRedirectUri(req)).toBe('https://ops.roligt.example/api/auth/callback')
  })

  it('takes the first value of a comma-listed proto', () => {
    const req = new Request('https://internal/', {
      headers: { host: 'ops.roligt.example', 'x-forwarded-proto': 'https, http' },
    })
    expect(deriveRedirectUri(req)).toBe('https://ops.roligt.example/api/auth/callback')
  })

  it('defaults local hosts to http and anything else to https', () => {
    expect(deriveRedirectUri(new Request('https://internal/', { headers: { host: 'localhost:3000' } }))).toBe(
      'http://localhost:3000/api/auth/callback',
    )
    expect(deriveRedirectUri(new Request('https://internal/', { headers: { host: '127.0.0.1:3000' } }))).toBe(
      'http://127.0.0.1:3000/api/auth/callback',
    )
    expect(deriveRedirectUri(new Request('https://internal/', { headers: { host: 'ops.example' } }))).toBe(
      'https://ops.example/api/auth/callback',
    )
  })
})

describe('workosConfigured / sessionCookieName', () => {
  const KEYS = ['WORKOS_CLIENT_ID', 'WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD', 'WORKOS_COOKIE_NAME'] as const
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) saved[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('requires all three server vars', () => {
    expect(workosConfigured()).toBe(false)
    process.env.WORKOS_CLIENT_ID = 'client'
    expect(workosConfigured()).toBe(false)
    process.env.WORKOS_API_KEY = 'sk'
    expect(workosConfigured()).toBe(false)
    process.env.WORKOS_COOKIE_PASSWORD = 'x'.repeat(32)
    expect(workosConfigured()).toBe(true)
  })

  it('names the cookie wos-session unless overridden', () => {
    expect(sessionCookieName()).toBe('wos-session')
    process.env.WORKOS_COOKIE_NAME = 'custom'
    expect(sessionCookieName()).toBe('custom')
  })
})

describe("authServiceFor — the cookie's Secure flag follows the request's protocol", () => {
  const KEYS = ['WORKOS_REDIRECT_URI'] as const
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) saved[k] = process.env[k]
    // the package-global config both service variants resolve lazily — what
    // ensureConfigured would set on a first request. Sealing through it never
    // reaches the WorkOS network; it only serializes against the baked options.
    configure({
      clientId: 'client',
      apiKey: 'sk_test',
      redirectUri: process.env.WORKOS_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback',
      cookiePassword: 'x'.repeat(32),
    })
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  /** The session cookie this request's own service would seal, as header strings. */
  const sealOn = async (req: Request): Promise<string[]> =>
    setCookiesOf((await authServiceFor(req).saveSession(undefined, 'Fe26.2-seal')).headers)
  const httpsReq = (headers: Record<string, string> = {}) =>
    new Request('https://internal/api/revision', {
      headers: { 'x-forwarded-host': 'ops.roligt.example', 'x-forwarded-proto': 'https', ...headers },
    })

  it('seals a Secure session cookie over https even with WORKOS_REDIRECT_URI unset', async () => {
    delete process.env.WORKOS_REDIRECT_URI
    const [cookie] = await sealOn(httpsReq())
    expect(cookie).toContain('wos-session=')
    expect(cookie).toMatch(/; Secure/)
  })

  it('keeps the plain cookie for local http traffic — the default service, unchanged', async () => {
    delete process.env.WORKOS_REDIRECT_URI
    const [cookie] = await sealOn(new Request('https://internal/', { headers: { host: 'localhost:3000' } }))
    expect(cookie).toContain('wos-session=')
    expect(cookie).not.toMatch(/secure/i)
  })

  it('an https env pin needs no patching — one default service serves both, still Secure', async () => {
    process.env.WORKOS_REDIRECT_URI = 'https://ops.roligt.example/api/auth/callback'
    // the default service's storage bakes its flag at FIRST use, from the env
    // in effect then — a fresh module is the honest way to pin the pin
    vi.resetModules()
    configure({
      clientId: 'client',
      apiKey: 'sk_test',
      redirectUri: 'https://ops.roligt.example/api/auth/callback',
      cookiePassword: 'x'.repeat(32),
    })
    const fresh = await import('./session.ts')
    const [cookie] = setCookiesOf(
      (await fresh.authServiceFor(httpsReq()).saveSession(undefined, 'Fe26.2-seal')).headers,
    )
    expect(cookie).toMatch(/; Secure/)
    // and http traffic gets the very same service — no second variant exists
    const httpReq = new Request('https://internal/', { headers: { host: 'localhost:3000' } })
    expect(fresh.authServiceFor(httpsReq())).toBe(fresh.authServiceFor(httpReq))
  })
})
