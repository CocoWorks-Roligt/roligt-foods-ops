import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, SignJWT, exportJWK } from 'jose'
import { authenticate, AuthError } from './auth.ts'

const ISSUER = 'https://roligt.kinde.com'

async function makeToken(roles: string[]) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
  return { token, jwk }
}

// The dev-session decision reads KINDE_DOMAIN, NODE_ENV and ALLOW_DEV_SESSION; every
// test states its own world and this pair puts the world back — a value leaked from
// one test (or from vitest's own NODE_ENV) would silently flip the others.
const ENV_KEYS = ['KINDE_DOMAIN', 'KINDE_AUDIENCE', 'ALLOW_DEV_SESSION', 'NODE_ENV'] as const
let envSaved: Record<string, string | undefined>
beforeEach(() => {
  envSaved = {}
  for (const k of ENV_KEYS) envSaved[k] = process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k]
    else process.env[k] = envSaved[k]
  }
  vi.restoreAllMocks()
})

describe('authenticate', () => {
  it('maps the roles claim to Admin and passes the email through', async () => {
    const { token, jwk } = await makeToken(['Admin'])
    process.env.KINDE_DOMAIN = ISSUER
    process.env.ALLOW_DEV_SESSION = ''
    const mod = await import('./auth.ts')
    mod.__setJwks({ keys: [jwk] }) // test hook: skip network JWKS fetch
    const caller = await authenticate(new Request('https://bff.roligt.local/api/revision', {
      headers: { Authorization: `Bearer ${token}` },
    }))
    expect(caller.role).toBe('Admin')
    expect(caller.email).toBe('unknown@user') // signed token carries no email claim
    mod.__setJwks(null) // reset the hook so later tests take the real JWKS path
  })

  it('rejects a missing token with AuthError', async () => {
    process.env.KINDE_DOMAIN = ISSUER
    process.env.ALLOW_DEV_SESSION = ''
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('issues the dev session when ALLOW_DEV_SESSION=1, no Kinde tenant and not production', async () => {
    delete process.env.KINDE_DOMAIN
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    const caller = await authenticate(new Request('https://bff.roligt.local/api/revision', { headers: { 'X-Dev-Role': 'Operator' } }))
    expect(caller).toEqual({ email: 'dev@roligt.local', role: 'Operator' })
  })

  it('refuses the dev session when KINDE_DOMAIN is configured — anonymous callers must get AuthError', async () => {
    process.env.KINDE_DOMAIN = ISSUER
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('refuses the dev session under NODE_ENV=production even with no Kinde tenant', async () => {
    delete process.env.KINDE_DOMAIN
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_DEV_SESSION = '1'
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('warns once while the dev session is active, then stays quiet', async () => {
    vi.resetModules() // fresh module so the warn-once flag starts clear
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await import('./auth.ts')
    delete process.env.KINDE_DOMAIN
    process.env.NODE_ENV = 'development'
    process.env.ALLOW_DEV_SESSION = '1'
    for (let i = 0; i < 2; i++) {
      const caller = await mod.authenticate(new Request('https://bff.roligt.local/api/revision'))
      expect(caller.role).toBe('Admin')
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/dev session/i)
  })

  it('rejects a present-but-garbage token even in dev mode', async () => {
    process.env.KINDE_DOMAIN = ISSUER
    process.env.ALLOW_DEV_SESSION = '1'
    await expect(authenticate(new Request('https://bff.roligt.local/api/revision', {
      headers: { Authorization: 'Bearer garbage' },
    }))).rejects.toBeInstanceOf(AuthError)
  })
})
