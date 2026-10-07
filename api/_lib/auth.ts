/**
 * Who is calling the BFF. Two ways in, tried in order:
 *
 * 1. The WorkOS AuthKit session cookie — the browser's only credential. The
 *    seal is opened by api/_lib/session.ts (@workos/authkit-session), which
 *    also refreshes the short-lived access token server-side and hands back
 *    the re-sealed cookie for the response to carry (the data handlers forward
 *    `setCookies` — a dropped refresh cookie means a session that can never
 *    refresh twice).
 * 2. The dev session: ALLOW_DEV_SESSION=1 AND not production AND WorkOS not
 *    configured AND the request's own host is loopback (or named in
 *    ALLOW_DEV_HOSTS) — the env conditions license the process, never a plant
 *    domain. With real auth live (or in production) an anonymous caller gets
 *    AuthError, never a free admin.
 *
 * Authorization is permissions, not roles: the caller holds slugs from
 * src/lib/permissions.ts and commitChanges gates writes on those — this guard
 * is the RLS of the fork.
 */
import { devPermissions } from '../../src/lib/permissions.js'
import type { Role } from '../../src/types.js'
import { withAuth, workosConfigured } from './session.js'
import { isActiveMember } from './workosAdmin.js'
import type { AuthResult } from '@workos/authkit-session'

export class AuthError extends Error {
  readonly status = 401 as const
}

export interface Caller {
  email: string
  permissions: string[]
}

export interface Authentication {
  caller: Caller
  /** Re-sealed session cookies a refresh produced; the response must carry them back. */
  setCookies?: string[]
}

export type SessionAuthenticator = (
  req: Request,
) => Promise<{ auth: AuthResult; setCookies: string[] } | null>

let authenticatorOverride: SessionAuthenticator | null = null
/** Test hook — replaces the cookie branch wholesale. Return null to fall through. */
export function __setAuthenticator(fn: SessionAuthenticator | null): void {
  authenticatorOverride = fn
}

/** Dev sessions need all three: the opt-in flag, a non-production process, no WorkOS config. */
export function devSessionAllowed(): boolean {
  return (
    process.env.ALLOW_DEV_SESSION === '1'
    && process.env.NODE_ENV !== 'production'
    && !workosConfigured()
  )
}

/**
 * The hosts a dev session may be minted for: the loopback interface, plus any
 * host named in ALLOW_DEV_HOSTS (csv — a LAN dev box, a preview URL). The three
 * env conditions above say the PROCESS may mint dev callers; they say nothing
 * about where a request came from, and on a mis-deployed instance (NODE_ENV
 * unset, flag leaked into env) they alone would mint anonymous admins on a
 * plant domain. The host is read with the same x-forwarded-host precedence
 * hostProto uses — behind the platform proxy that header is the proxy's own,
 * not client choice.
 */
export function devHostAllowed(host: string | null | undefined): boolean {
  if (!host || host.includes(',')) return false // a proxy chain's appended list is not a dev box
  const bare = host.split(':')[0].trim().toLowerCase()
  if (!bare) return false
  if (bare === 'localhost' || bare === '127.0.0.1') return true
  return (process.env.ALLOW_DEV_HOSTS ?? '')
    .split(',')
    .some((named) => named.trim().toLowerCase() === bare)
}

/** The dev session for an x-dev-role header value ('Operator'/'QualityTester' pick themselves, anything else admin). */
export function devCaller(xDevRole: unknown): Caller {
  const raw = Array.isArray(xDevRole) ? xDevRole[0] : xDevRole
  const role: Role = raw === 'Operator' || raw === 'QualityTester' ? raw : 'Admin'
  return {
    email: 'dev@roligt.local',
    permissions: devPermissions(role),
  }
}

let devSessionWarned = false

export async function authenticate(req: Request): Promise<Authentication> {
  // 1. the session cookie
  if (authenticatorOverride || (workosConfigured() && req.headers.get('cookie'))) {
    let result: { auth: AuthResult; setCookies: string[] } | null
    try {
      result = authenticatorOverride ? await authenticatorOverride(req) : await withAuth(req)
    } catch (e) {
      throw new AuthError(`Invalid session (${(e as Error).message}). Sign in again.`)
    }
    if (result && result.auth.user) {
      // Fail closed on an incomplete server configuration (the audit's S3-9):
      // with WORKOS_ORG_ID unset, neither the wrong-org refusal below nor the
      // membership retirement gate can run, and a removed member's seal would
      // live on until its refresh token died. Refuse every session rather
      // than serve unvalidated ones — a deploy missing the org id locks
      // everyone out loudly instead of admitting everyone quietly.
      const orgId = process.env.WORKOS_ORG_ID
      if (!orgId) {
        throw new AuthError('The server cannot validate sessions (WORKOS_ORG_ID is not set). Ask an admin to fix the configuration.')
      }
      // Single-org app: /api/auth/start scopes every sign-in to the one
      // organization, so a live session speaks for that org and no other. A
      // session carrying a different org claim is not one of ours — refuse it
      // outright rather than admit a caller with an ambiguous permission set.
      // (No claim ≠ refusal: only the wrong org is provably wrong.)
      if (result.auth.organizationId && result.auth.organizationId !== orgId) {
        throw new AuthError('Your session belongs to another organization. Sign in again.')
      }
      const email = result.auth.user.email || 'unknown@user'
      // The seal outlives the membership it came from: removing, deactivating
      // or deleting someone does nothing to a browser already holding a
      // session, so the app checks the membership itself (a minute-stale at
      // worst; the admin endpoints' own mutations drop the mirror at once).
      // The real cookie branch only runs when workosConfigured() has already
      // demanded the management key, so the check needs no second env guard.
      if (!(await isActiveMember(email))) {
        throw new AuthError('Your access to this app was removed or deactivated. Ask an admin to restore it.')
      }
      return {
        caller: { email, permissions: result.auth.permissions ?? [] },
        ...(result.setCookies.length ? { setCookies: result.setCookies } : {}),
      }
    }
    // a present-but-unusable cookie is anonymous: dev fallback, then 401
  }

  // 2. the dev session
  if (devSessionAllowed()) {
    // Fail-closed on the host too: the env conditions license the process, not
    // this request — a plant domain never mints a dev admin, and the refusal is
    // the same one any anonymous caller gets, leaking nothing about the flag.
    if (!devHostAllowed(req.headers.get('x-forwarded-host') ?? req.headers.get('host'))) {
      throw new AuthError('Sign in first.')
    }
    if (!devSessionWarned) {
      devSessionWarned = true
      console.warn(
        '[auth] dev session active (ALLOW_DEV_SESSION=1, no WorkOS config) — anonymous callers get every permission. ' +
          'Ignored under NODE_ENV=production or once WorkOS is configured; never ship enabled.',
      )
    }
    return { caller: devCaller(req.headers.get('x-dev-role')) }
  }

  throw new AuthError('Sign in first.')
}
