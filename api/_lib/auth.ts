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

/**
 * The key set for a tenant, at the JWKS URL its own discovery document declares
 * (falls back to the conventional /.well-known/jwks when discovery cannot be
 * reached). Cached per origin; jose re-fetches on key rotation by itself.
 */
async function jwksFor(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const url = new URL(issuer)
  let set = jwkSets.get(url.origin)
  if (set) return set
  let jwksUrl = new URL(`${url.origin}/.well-known/jwks`)
  try {
    const discovery = await fetch(`${url.origin}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    })
    if (discovery.ok) {
      const config = (await discovery.json()) as { jwks_uri?: unknown }
      if (typeof config.jwks_uri === 'string') jwksUrl = new URL(config.jwks_uri)
    }
  } catch {
    // Unreachable discovery is not fatal — the conventional path is the norm.
  }
  set = createRemoteJWKSet(jwksUrl)
  jwkSets.set(url.origin, set)
  return set
}

/** Dev sessions need all three: the opt-in flag, a non-production process, no Kinde tenant. */
function devSessionAllowed(): boolean {
  return (
    process.env.ALLOW_DEV_SESSION === '1'
    && process.env.NODE_ENV !== 'production'
    && !process.env.KINDE_DOMAIN
  )
}

let devSessionWarned = false

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
    // Lazy on purpose: a malformed token is rejected during decode, before any
    // key is asked for, so neither it nor the test suite pays a discovery fetch.
    const resolveKeys =
      jwksOverride ??
      (async (protectedHeader: Parameters<ReturnType<typeof createRemoteJWKSet>>[0], jwt: Parameters<ReturnType<typeof createRemoteJWKSet>>[1]) =>
        (await jwksFor(issuer))(protectedHeader, jwt))
    const { payload } = await jwtVerify(token, resolveKeys, {
      issuer,
      clockTolerance: 5, // the BFF's clock and Kinde's may disagree a little
      ...(process.env.KINDE_AUDIENCE ? { audience: process.env.KINDE_AUDIENCE } : {}),
    })
    return {
      // Kinde adds `email` to access tokens only via token customization; the
      // user id is always there, so the audit trail never degrades to a placeholder.
      email:
        typeof payload.email === 'string'
          ? payload.email
          : typeof payload.sub === 'string' && payload.sub
            ? payload.sub
            : 'unknown@user',
      role: roleFromClaims(payload.roles),
    }
  } catch (e) {
    throw new AuthError(`Invalid session (${(e as Error).message}). Sign in again.`)
  }
}
