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
 *    configured. With real auth live (or in production) an anonymous caller
 *    gets AuthError, never a free admin.
 *
 * Authorization is permissions, not roles: the caller holds slugs from
 * src/lib/permissions.ts and commitChanges gates writes on those — this guard
 * is the RLS of the fork.
 */
import { devPermissions } from '../../src/lib/permissions.ts'
import type { Role } from '../../src/types.ts'
import { withAuth, workosConfigured } from './session.ts'
import { isActiveMember } from './workosAdmin.ts'
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
      // Single-org app: /api/auth/start scopes every sign-in to the one
      // organization, so a live session speaks for that org and no other. A
      // session carrying a different org claim is not one of ours — refuse it
      // outright rather than admit a caller with an ambiguous permission set.
      // (No claim ≠ refusal: only the wrong org is provably wrong.)
      const orgId = process.env.WORKOS_ORG_ID
      if (orgId && result.auth.organizationId && result.auth.organizationId !== orgId) {
        throw new AuthError('Your session belongs to another organization. Sign in again.')
      }
      const email = result.auth.user.email || 'unknown@user'
      // The seal outlives the membership it came from: removing, deactivating
      // or deleting someone does nothing to a browser already holding a
      // session, so the app checks the membership itself (a minute-stale at
      // worst; the admin endpoints' own mutations drop the mirror at once).
      // Without the management key there is nothing to check against — then
      // the commit permission gate is the only line, as it always was.
      if (process.env.WORKOS_API_KEY && process.env.WORKOS_ORG_ID) {
        if (!(await isActiveMember(email))) {
          throw new AuthError('Your access to this app was removed or deactivated. Ask an admin to restore it.')
        }
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
