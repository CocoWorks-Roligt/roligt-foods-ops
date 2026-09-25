import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * The four /api/auth routes at the handler level: status codes, Location
 * targets and Set-Cookie forwarding, with _lib/session and _lib/auth mocked —
 * the WorkOS network is the Phase 2 drive's job, not the suite's. What these
 * tests pin is the route contract the SPA will lean on: return-path
 * sanitizing, 302 shapes, 400s with a cause, 401/503.
 */
const world = vi.hoisted(() => ({
  configured: true,
  signIn: { url: 'https://authkit.workos.io/…', setCookies: ['wos-auth-verifier-x=v1; Path=/'] },
  capturedSignIn: null as null | { returnPathname: string; organizationId?: string },
  callback: { error: null as string | null, returnPathname: '/vendors' },
  signOut: { logoutUrl: 'https://authkit.workos.io/user/logout?sid=1' as string | null },
  auth: { error: null as string | null, caller: { email: 'lead@roligt.local', permissions: ['masters.manage'] }, setCookies: [] as string[] },
  dev: false,
}))

vi.mock('../_lib/session.ts', () => ({
  workosConfigured: () => world.configured,
  createSignInUrl: vi.fn(async (_req: unknown, opts: { returnPathname: string; organizationId?: string }) => {
    world.capturedSignIn = opts
    return world.signIn
  }),
  handleAuthCallback: vi.fn(async () => {
    if (world.callback.error) throw new Error(world.callback.error)
    return { returnPathname: world.callback.returnPathname, setCookies: ['wos-session=seal; Path=/; HttpOnly'] }
  }),
  clearVerifierCookies: vi.fn(async () => ['wos-auth-verifier-x=; Max-Age=0']),
  signOutUrl: vi.fn(async () => ({ logoutUrl: world.signOut.logoutUrl, setCookies: ['wos-session=; Max-Age=0'] })),
}))

vi.mock('../_lib/auth.ts', () => ({
  authenticate: vi.fn(async () => {
    if (world.auth.error) throw new (class AuthError extends Error {})(world.auth.error)
    return { caller: world.auth.caller, ...(world.auth.setCookies.length ? { setCookies: world.auth.setCookies } : {}) }
  }),
  AuthError: class AuthError extends Error {},
  devSessionAllowed: () => world.dev,
  devCaller: () => ({ email: 'dev@roligt.local', permissions: ['masters.manage'] }),
}))

const start = (await import('./start.ts')).default
const callback = (await import('./callback.ts')).default
const signout = (await import('./signout.ts')).default
const session = (await import('./session.ts')).default

beforeEach(() => {
  world.configured = true
  world.signIn = { url: 'https://authkit.workos.io/…', setCookies: ['wos-auth-verifier-x=v1; Path=/'] }
  world.callback = { error: null, returnPathname: '/vendors' }
  world.signOut = { logoutUrl: 'https://authkit.workos.io/user/logout?sid=1' }
  world.auth = { error: null, caller: { email: 'lead@roligt.local', permissions: ['masters.manage'] }, setCookies: [] }
  world.dev = false
  delete process.env.WORKOS_ORG_ID
})
afterEach(() => delete process.env.WORKOS_ORG_ID)

function fakeRes() {
  const res = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: unknown) => {
      res.headers[name] = value
      return res
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code
      return res
    }),
    json: vi.fn(),
    end: vi.fn(),
  }
  return res as unknown as VercelResponse & typeof res
}

function fakeReq(url: string, headers: Record<string, string> = {}): VercelRequest {
  return { headers, url, method: 'GET' } as unknown as VercelRequest
}

describe('GET /api/auth/start', () => {
  it('302s to the hosted page with the verifier cookie, passing the return path and org', async () => {
    process.env.WORKOS_ORG_ID = 'org_123'
    const res = fakeRes()
    await start(fakeReq('/api/auth/start?return=/vendors'), res)
    expect(res.status).toHaveBeenCalledWith(302)
    expect(res.setHeader).toHaveBeenCalledWith('Location', world.signIn.url)
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', world.signIn.setCookies)
    expect(res.end).toHaveBeenCalled()
    expect(world.capturedSignIn).toEqual({ returnPathname: '/vendors', organizationId: 'org_123' })
  })

  it('neutralizes an off-site return path before it is sealed into the flow', async () => {
    for (const hostile of ['//evil.example', '/\\evil.example', 'https://evil.example', '..']) {
      const res = fakeRes()
      await start(fakeReq(`/api/auth/start?return=${encodeURIComponent(hostile)}`), res)
      expect(world.capturedSignIn!.returnPathname).toBe('/')
    }
  })

  it('answers 503 when the server has no WorkOS config', async () => {
    world.configured = false
    const res = fakeRes()
    await start(fakeReq('/api/auth/start'), res)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.end).not.toHaveBeenCalled()
  })
})

describe('GET /api/auth/callback', () => {
  it('302s to the state-sealed return path with the session cookie', async () => {
    const res = fakeRes()
    await callback(fakeReq('/api/auth/callback?code=c&state=s'), res)
    expect(res.status).toHaveBeenCalledWith(302)
    expect(res.setHeader).toHaveBeenCalledWith('Location', '/vendors')
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', ['wos-session=seal; Path=/; HttpOnly'])
  })

  it('refuses to redirect off-site even if the sealed path were hostile', async () => {
    world.callback.returnPathname = '//evil.example'
    const res = fakeRes()
    await callback(fakeReq('/api/auth/callback?code=c&state=s'), res)
    expect(res.setHeader).toHaveBeenCalledWith('Location', '/')
  })

  it('answers 400 without a code', async () => {
    const res = fakeRes()
    await callback(fakeReq('/api/auth/callback?state=s'), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('code') }))
  })

  it('answers 400 with the cause and clears the verifier when the exchange fails', async () => {
    world.callback.error = 'invalid_grant'
    const res = fakeRes()
    await callback(fakeReq('/api/auth/callback?code=bad&state=s'), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('invalid_grant') }))
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', ['wos-auth-verifier-x=; Max-Age=0'])
  })
})

describe('GET /api/auth/signout', () => {
  it('302s to the WorkOS logout URL and clears the session cookie', async () => {
    const res = fakeRes()
    await signout(fakeReq('/api/auth/signout'), res)
    expect(res.status).toHaveBeenCalledWith(302)
    expect(res.setHeader).toHaveBeenCalledWith('Location', world.signOut.logoutUrl)
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', ['wos-session=; Max-Age=0'])
  })

  it('falls back to / when there is no session to end', async () => {
    world.signOut.logoutUrl = null
    const res = fakeRes()
    await signout(fakeReq('/api/auth/signout'), res)
    expect(res.setHeader).toHaveBeenCalledWith('Location', '/')
  })
})

describe('GET /api/auth/session', () => {
  it('answers 200 with the caller and forwards refresh cookies', async () => {
    world.auth.setCookies = ['wos-session=fresh; Path=/']
    const res = fakeRes()
    await session(fakeReq('/api/auth/session'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ user: { email: 'lead@roligt.local' }, permissions: ['masters.manage'] })
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', ['wos-session=fresh; Path=/'])
  })

  it('answers 401 when authenticate refuses', async () => {
    world.auth.error = 'Sign in first.'
    const res = fakeRes()
    await session(fakeReq('/api/auth/session'), res)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Sign in first.' })
  })

  it('answers the dev session when unconfigured and dev is allowed', async () => {
    world.configured = false
    world.dev = true
    const res = fakeRes()
    await session(fakeReq('/api/auth/session', { 'x-dev-role': 'Operator' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ dev: true, user: { email: 'dev@roligt.local' } }))
  })

  it('answers 503 when unconfigured and dev is not allowed', async () => {
    world.configured = false
    world.dev = false
    const res = fakeRes()
    await session(fakeReq('/api/auth/session'), res)
    expect(res.status).toHaveBeenCalledWith(503)
  })
})
