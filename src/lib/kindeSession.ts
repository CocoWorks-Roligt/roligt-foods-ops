/**
 * The one file that talks to Kinde. AuthContext imports it dynamically, so the
 * dev-fallback path never loads it (and never loads the SDK) at all.
 *
 * The installed SDK (@kinde-oss/kinde-auth-react 5.13.1) has no non-React client
 * export — no `getKindeClient`/`kindeClient`; every method hangs off
 * `useKindeAuth()` under <KindeProvider>. So main.tsx mounts a hidden
 * <KindeBridge/> that hands the provider's context to this module via
 * `bindKinde()`, and the three functions below keep the public shape
 * AuthContext expects regardless of that wiring detail.
 *
 * Roles: the shared rule lives in ./roles (re-exported here) so the BFF auth
 * guard in api/_lib/auth.ts enforces exactly the same Admin/Operator decision.
 */
import type { KindeContextProps } from '@kinde-oss/kinde-auth-react'
import { KINDE_CONFIGURED } from './authMode'
import { roleFromClaims } from './roles'
import type { SessionLike } from '../context/AuthContext'
import type { Role } from '../types'

export { roleFromClaims } from './roles'

let bound: KindeContextProps | null = null
const waiters: Array<(client: KindeContextProps) => void> = []

/**
 * Called by the hidden <KindeBridge/> in main.tsx. Also releases anything that
 * was already waiting for the provider's context.
 */
export function bindKinde(client: KindeContextProps): void {
  bound = client
  for (const release of waiters.splice(0)) release(client)
}

async function client(): Promise<KindeContextProps> {
  if (bound) return bound
  // The bridge mounts before the app tree's effects run, so this wait is belt
  // and braces — it just removes the ordering assumption entirely.
  return new Promise((release) => {
    waiters.push(release)
  })
}

export interface KindeSession {
  session: SessionLike | null
  role: Role
  token: string | null
}

export async function getKindeSession(): Promise<KindeSession> {
  if (!KINDE_CONFIGURED) throw new Error('Kinde is not configured')
  const kinde = await client()
  const token = await kinde.getToken()
  if (!token) return { session: null, role: 'Operator', token: null }
  const user = await kinde.getUserProfile()
  // getClaims returns the decoded token itself, so `roles` is the raw claim
  // array (role keys, or role objects carrying key/name). The wrapped
  // {name, value} shape belongs to getClaim(key) — not to getClaims().
  const claims = await kinde.getClaims<{ roles?: unknown }>()
  let role = roleFromClaims(claims?.roles)
  if (role !== 'Admin') {
    try {
      // No roles claim in the token (customization unticked)? The SDK can
      // still ask Kinde's account API what roles this user holds. The BFF
      // keeps enforcing from the token, so a divergence only costs a 403.
      role = roleFromClaims(await kinde.getRoles())
    } catch {
      // Claim absent and the account API refused — Operator stands.
    }
  }
  return {
    session: { user: { email: user?.email ?? 'unknown@user' } },
    role,
    token,
  }
}

/**
 * A current access token for the BFF. `force` first asks the SDK to refresh
 * (Kinde access tokens are short-lived); getToken alone may hand back one that
 * has already expired. Never throws — a dead session reads as null, which is
 * the caller's cue to send the user back to the login screen.
 */
export async function freshToken(force = false): Promise<string | null> {
  const kinde = await client()
  if (force) {
    try {
      // The provider binds the tenant config into this method; the context type
      // still demands it, so call through the shape the runtime accepts.
      await (kinde.refreshToken as (config?: unknown) => Promise<unknown>)()
    } catch {
      // Refresh refused (signed out elsewhere, refresh token expired) — the
      // getToken below reports the truth.
    }
  }
  try {
    return (await kinde.getToken()) ?? null
  } catch {
    return null
  }
}

export async function login(): Promise<void> {
  const kinde = await client()
  // `state` is the SDK's post-login appState (a Record<string, string>); the
  // browser comes back to the path the user was on.
  await kinde.login({ state: { path: location.pathname } })
}

export async function logout(): Promise<void> {
  const kinde = await client()
  await kinde.logout()
}
