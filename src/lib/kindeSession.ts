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
  const claims = await kinde.getClaims<{ roles?: { value?: unknown } }>()
  return {
    session: { user: { email: user?.email ?? 'unknown@user' } },
    role: roleFromClaims(claims?.roles?.value),
    token,
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
