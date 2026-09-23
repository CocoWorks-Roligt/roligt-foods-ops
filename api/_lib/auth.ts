/**
 * Who is calling the BFF. With Kinde configured, the bearer JWT is verified against
 * the tenant's JWKS and the roles claim decides Admin/Operator. Without a token, a dev
 * session is issued only when ALLOW_DEV_SESSION=1 AND the server is not running as
 * production AND no Kinde tenant is configured — with real auth live (or in production),
 * an anonymous caller gets AuthError, never a free Admin role. The guard is the RLS of
 * this fork: every endpoint calls it, and the commit endpoint refuses operator writes
 * to admin-only tables based on exactly this decision.
 */
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose'
import { roleFromClaims } from '../../src/lib/roles.ts'

export class AuthError extends Error {
  readonly status = 401 as const
}

export interface Caller {
  email: string
  role: 'Admin' | 'Operator'
}

let jwksOverride: ReturnType<typeof createLocalJWKSet> | null = null
/** Test hook — replaces the network JWKS fetch. */
export function __setJwks(jwks: { keys: unknown[] } | null): void {
  jwksOverride = jwks ? createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]) : null
}

const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/** Dev sessions need all three: the opt-in flag, a non-production process, no Kinde tenant. */
function devSessionAllowed(): boolean {
  return (
    process.env.ALLOW_DEV_SESSION === '1'
    && process.env.NODE_ENV !== 'production'
    && !process.env.KINDE_DOMAIN
  )
}

let devSessionWarned = false

function jwksFor(issuer: string) {
  const url = new URL(issuer)
  const key = url.origin
  let set = jwkSets.get(key)
  if (!set) {
    set = createRemoteJWKSet(new URL(`${url.origin}/openid/jwks`))
    jwkSets.set(key, set)
  }
  return set
}

export async function authenticate(req: Request): Promise<Caller> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    if (devSessionAllowed()) {
      if (!devSessionWarned) {
        devSessionWarned = true
        console.warn(
          '[auth] dev session active (ALLOW_DEV_SESSION=1, no KINDE_DOMAIN) — anonymous callers get Admin. ' +
            'Ignored under NODE_ENV=production or once Kinde is configured; never ship enabled.',
        )
      }
      return { email: 'dev@roligt.local', role: req.headers.get('x-dev-role') === 'Operator' ? 'Operator' : 'Admin' }
    }
    throw new AuthError('Sign in first.')
  }

  const issuer = (process.env.KINDE_DOMAIN ?? '').replace(/\/$/, '')
  if (!issuer) throw new AuthError('Auth is not configured on the server.')
  try {
    const { payload } = await jwtVerify(token, jwksOverride ?? jwksFor(issuer), {
      issuer,
      ...(process.env.KINDE_AUDIENCE ? { audience: process.env.KINDE_AUDIENCE } : {}),
    })
    return {
      email: typeof payload.email === 'string' ? payload.email : 'unknown@user',
      role: roleFromClaims(payload.roles),
    }
  } catch (e) {
    throw new AuthError(`Invalid session (${(e as Error).message}). Sign in again.`)
  }
}
