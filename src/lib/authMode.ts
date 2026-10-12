/**
 * Whether the app runs against a real WorkOS account (the client id env
 * present) or the dev fallback session. The SPA never talks to WorkOS itself:
 * the id is only the flag that says the /api/auth/* surface exists — the
 * server-owned cookie does the rest. Split out of AuthContext so Login and
 * main can read it without pulling in the provider — and so the context file
 * stays fast-refresh clean.
 */
import type { Role } from '../types'

export const WORKOS_CONFIGURED = Boolean(import.meta.env.VITE_WORKOS_CLIENT_ID)

/** Reads the persisted login-screen role choice for the dev fallback session. */
export function getDevRole(): Role {
  // The dev fallback only ever runs in a browser, but dbApi imports this module
  // unconditionally and its tests run where localStorage does not exist — without
  // the guard, the suite is green only on machines whose .env.local answers
  // WORKOS_CONFIGURED (a fresh clone runs red).
  if (typeof localStorage === 'undefined') return 'Admin'
  const saved = localStorage.getItem('devRole')
  return saved === 'Operator' || saved === 'QualityTester' || saved === 'Npd' || saved === 'Admin'
    ? saved
    : 'Admin'
}

/** Persists the login-screen role choice for the dev fallback session. */
export function setDevRole(role: Role) {
  localStorage.setItem('devRole', role)
}
