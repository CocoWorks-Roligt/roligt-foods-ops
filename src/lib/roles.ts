/**
 * The one Kinde-roles-to-app-role rule, shared by the SPA session (kindeSession)
 * and the BFF auth guard (api/_lib/auth). This file must stay dependency-free
 * apart from types: it is compiled by both tsconfig projects, including the
 * nodenext api build where browser globals and extensionless imports do not
 * exist (hence the explicit .ts extension on the type import). Kinde issues the access token with a `roles` claim (array of role
 * keys, or of role objects carrying a key) for users assigned roles in the
 * Kinde admin. 'Admin' (case-insensitive) maps to the app's Admin; everything
 * else — including no claim at all — is an Operator.
 */
import type { Role } from '../types.ts'

/** The role rule, pure so a unit test can pin it. */
export function roleFromClaims(roles: unknown): Role {
  if (!Array.isArray(roles)) return 'Operator'
  return roles.some((entry) => {
    const key =
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object'
          ? ((entry as { key?: unknown }).key ?? (entry as { name?: unknown }).name)
          : undefined
    return typeof key === 'string' && key.toLowerCase() === 'admin'
  })
    ? 'Admin'
    : 'Operator'
}
