/**
 * Whether the app runs against a real Kinde account (both SPA envs present) or
 * the dev fallback session. Split out of AuthContext so Login, kindeSession and
 * main can read it without pulling in the provider — and so the context file
 * stays fast-refresh clean.
 */
import type { Role } from '../types'

export const KINDE_CONFIGURED = Boolean(
  import.meta.env.VITE_KINDE_DOMAIN && import.meta.env.VITE_KINDE_CLIENT_ID,
)

/** Reads the persisted login-screen role choice for the dev fallback session. */
export function getDevRole(): Role {
  const saved = localStorage.getItem('devRole')
  return saved === 'Operator' || saved === 'Admin' ? saved : 'Admin'
}

/** Persists the login-screen role choice for the dev fallback session. */
export function setDevRole(role: Role) {
  localStorage.setItem('devRole', role)
}
