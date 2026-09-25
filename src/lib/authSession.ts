/**
 * The one auth call the SPA makes at boot: GET /api/auth/session. The cookie
 * travels on the request (same-origin), the BFF answers who is signed in and
 * which permissions the session carries — or 401, which means the login
 * screen. Anything else (a 503 from a half-configured deploy, a network drop)
 * is an error the caller surfaces rather than a silent "signed out".
 */

/** What the app reads from a session: who is signed in. */
export interface SessionLike {
  user: { email: string }
}

export interface BootSession {
  session: SessionLike
  permissions: string[]
}

/** Reads the session, or null when the BFF says there is none. */
export async function fetchSession(): Promise<BootSession | null> {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`Session check failed (HTTP ${res.status}).`)
  const j = (await res.json()) as { user?: { email?: string }; permissions?: string[] }
  if (!j.user?.email) return null
  return {
    session: { user: { email: j.user.email } },
    permissions: Array.isArray(j.permissions) ? j.permissions : [],
  }
}
