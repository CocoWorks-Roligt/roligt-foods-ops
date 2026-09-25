import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate, AuthError, __setAuthenticator } from './auth.ts'
import { PERMISSIONS } from '../../src/lib/permissions.ts'
import type { AuthResult } from '@workos/authkit-session'

/** The signed-in branch of AuthResult — the shape withAuth returns for a live session. */
type SignedIn = Exclude<AuthResult, { user: null }>

/** A signed-in AuthResult for the cookie-branch fake. */
const authResult = (over: Partial<SignedIn> = {}): SignedIn =>
  ({
    user: { email: 'lead@roligt.local' },
    sessionId: 'sid-1',
    accessToken: 'at',
    refreshToken: 'rt',
    claims: { sid: 'sid-1' },
    permissions: ['masters.manage'],
    ...over,
  }) as SignedIn

// The membership probe (the session-retirement gate) reads the live member
// list through workosAdmin — mocked here so a test can say who is still in.
const memberState = vi.hoisted(() => ({ active: true }))
vi.mock('./workosAdmin.ts', () => ({
  isActiveMember: vi.fn(async () => memberState.active),
}))

// The branch decisions read WORKOS_*/NODE_ENV/ALLOW_DEV_SESSION; every test
// states its own world and this pair puts the world back — a value leaked from one
// test (or from vitest's own NODE_ENV) would silently flip the others.
const ENV_KEYS = [
  'WORKOS_CLIENT_ID',
  'WORKOS_API_KEY',
  'WORKOS_COOKIE_PASSWORD',
  'WORKOS_ORG_ID',
  'ALLOW_DEV_SESSION',
  'NODE_ENV',
] as const
let envSaved: Record<string, string | undefined>
beforeEach(() => {
  envSaved = {}
  for (const k of ENV_KEYS) envSaved[k] = process.env[k]
  memberState.active = true
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k]
    else process.env[k] = envSaved[k]
  }
  __setAuthenticator(null)
  vi.restoreAllMocks()
})

describe('authenticate — the WorkOS session cookie', () => {
  it('maps the session to a Caller and forwards refreshed cookies', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.WORKOS_API_KEY = 'sk_test'
    process.env.WORKOS_COOKIE_PASSWORD = 'x'.repeat(32)
    const fake = vi.fn(async () => ({
      auth: authResult(),
      setCookies: ['wos-session=re-sealed; Path=/; HttpOnly'],
    }))
    __setAuthenticator(fake)
    const auth = await authenticate(new Request('https://bff.roligt.local/api/revision', {
      headers: { cookie: 'wos-session=stale' },
    }))
    expect(auth.caller).toEqual({ email: 'lead@roligt.local', permissions: ['masters.manage'] })
    expect(auth.setCookies).toEqual(['wos-session=re-sealed; Path=/; HttpOnly'])
  })

  it('omits setCookies when no refresh happened', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    const fake = vi.fn(async () => ({ auth: authResult(), setCookies: [] }))
    __setAuthenticator(fake)
    const auth = await authenticate(new Request('https://bff.roligt.local/api/revision'))
    expect(auth.caller.email).toBe('lead@roligt.local')
    expect(auth.setCookies).toBeUndefined()
  })

  it('treats a signed-out cookie as anonymous — no free caller', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.ALLOW_DEV_SESSION = ''
    const fake = vi.fn(async () => ({ auth: { user: null } as AuthResult, setCookies: [] }))
    __setAuthenticator(fake)
    await expect(
      authenticate(new Request('https://bff.roligt.local/api/revision', { headers: { cookie: 'other=1' } })),
    ).rejects.toBeInstanceOf(AuthError)
  })

  it('turns an unopenable seal into AuthError, not a crash', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    const fake = vi.fn(async () => {
      throw new Error('seal expired')
    })
    __setAuthenticator(fake)
    await expect(
      authenticate(new Request('https://bff.roligt.local/api/revision', { headers: { cookie: 'wos-session=junk' } })),
    ).rejects.toMatchObject({ message: expect.stringContaining('Sign in again') })
  })

  it('reads the email even when the provider claims none', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    const fake = vi.fn(async () => ({
      auth: authResult({ user: { email: '' } as SignedIn['user'], permissions: [] }),
      setCookies: [],
    }))
    __setAuthenticator(fake)
    const auth = await authenticate(new Request('https://bff.roligt.local/api/revision'))
    expect(auth.caller.email).toBe('unknown@user')
  })

  it('ignores a stray Authorization header — the cookie is the only credential', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.ALLOW_DEV_SESSION = ''
    const auth = await authenticate(new Request('https://bff.roligt.local/api/revision', {
      headers: { Authorization: 'Bearer whatever' },
    })).catch((e) => e)
    // no cookie present → anonymous → AuthError; the header never authenticates anyone
    expect(auth).toBeInstanceOf(AuthError)
  })

  it('refuses a session that speaks for a different organization', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.WORKOS_ORG_ID = 'org_ours'
    const fake = vi.fn(async () => ({ auth: authResult({ organizationId: 'org_theirs' }), setCookies: [] }))
    __setAuthenticator(fake)
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toMatchObject({
      message: expect.stringContaining('another organization'),
    })
  })

  it('accepts the one organization — and a session with no org claim at all', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.WORKOS_ORG_ID = 'org_ours'
    __setAuthenticator(vi.fn(async () => ({ auth: authResult({ organizationId: 'org_ours' }), setCookies: [] })))
    expect((await authenticate(new Request('https://bff.roligt.local/api/revision'))).caller.email).toBe('lead@roligt.local')
    __setAuthenticator(vi.fn(async () => ({ auth: authResult(), setCookies: [] })))
    expect((await authenticate(new Request('https://bff.roligt.local/api/revision'))).caller.email).toBe('lead@roligt.local')
  })

  it('retires a session whose membership is gone or deactivated', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.WORKOS_API_KEY = 'sk_test'
    process.env.WORKOS_ORG_ID = 'org_ours'
    memberState.active = false
    __setAuthenticator(vi.fn(async () => ({ auth: authResult(), setCookies: [] })))
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toMatchObject({
      message: expect.stringContaining('removed'),
    })
  })

  it('lets an active member through the same gate', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.WORKOS_API_KEY = 'sk_test'
    process.env.WORKOS_ORG_ID = 'org_ours'
    memberState.active = true
    __setAuthenticator(vi.fn(async () => ({ auth: authResult(), setCookies: [] })))
    expect((await authenticate(new Request('https://bff.roligt.local/api/revision'))).caller.email).toBe('lead@roligt.local')
  })

  it('skips the gate without the management key — the cookie alone decides', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    memberState.active = false
    __setAuthenticator(vi.fn(async () => ({ auth: authResult(), setCookies: [] })))
    expect((await authenticate(new Request('https://bff.roligt.local/api/revision'))).caller.email).toBe('lead@roligt.local')
  })
})

describe('authenticate — anonymous', () => {
  it('rejects a caller with no credential with AuthError', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.ALLOW_DEV_SESSION = ''
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('issues the dev session when ALLOW_DEV_SESSION=1, no WorkOS config and not production', async () => {
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    const op = await authenticate(new Request('https://bff.roligt.local/api/revision', { headers: { 'X-Dev-Role': 'Operator' } }))
    expect(op.caller).toEqual({ email: 'dev@roligt.local', permissions: [] })
    const admin = await authenticate(new Request('https://bff.roligt.local/api/revision'))
    expect(admin.caller).toEqual({ email: 'dev@roligt.local', permissions: [...PERMISSIONS] })
  })

  it('gives the dev Quality Tester the quality pages and nothing else', async () => {
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    const lab = await authenticate(new Request('https://bff.roligt.local/api/revision', { headers: { 'X-Dev-Role': 'QualityTester' } }))
    expect(lab.caller).toEqual({
      email: 'dev@roligt.local',
      permissions: ['page.quality', 'page.control-samples', 'page.reports', 'page.test-parameters'],
    })
  })

  it('refuses the dev session once WorkOS is configured — anonymous callers must get AuthError', async () => {
    process.env.WORKOS_CLIENT_ID = 'client'
    process.env.WORKOS_API_KEY = 'sk_test'
    process.env.WORKOS_COOKIE_PASSWORD = 'x'.repeat(32)
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('refuses the dev session under NODE_ENV=production even with no WorkOS config', async () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_DEV_SESSION = '1'
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('warns once while the dev session is active, then stays quiet', async () => {
    vi.resetModules() // fresh module so the warn-once flag starts clear
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await import('./auth.ts')
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    for (let i = 0; i < 2; i++) {
      const auth = await mod.authenticate(new Request('https://bff.roligt.local/api/revision'))
      expect(auth.caller.permissions).toEqual([...PERMISSIONS])
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/dev session/i)
  })
})
