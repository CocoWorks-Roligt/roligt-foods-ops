/**
 * Fetch client for /api/admin/* — the admin screens' whole server surface.
 *
 * Carries dbApi's session semantics (same-origin cookie credential, one 401 is
 * final and swaps in the login screen) with the admin endpoints' own shapes:
 * every mutating call posts `{ action, … }` and the server audits it.
 */
import { notifyUnauthorized } from './authEvents'
import { UnauthorizedError } from './dbApi'

export interface AdminUserRow {
  userId: string
  membershipId: string
  email: string
  name: string
  status: string
  roles: string[]
  lastSignInAt: string | null
}

export interface AdminRole {
  slug: string
  name: string
  permissions: string[]
}

export interface RolesSnapshot {
  roles: AdminRole[]
  permissions: string[]
  assignments: Record<string, number>
  /** Catalog slugs the server could not create in WorkOS (empty when all is well). */
  missing?: string[]
}

export type AdminResult = { ok: true } | { ok: false; error: string }

async function admin(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401) {
    notifyUnauthorized()
    throw new UnauthorizedError()
  }
  return res
}

async function readError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return j.error ?? `request failed (HTTP ${res.status})`
}

export async function fetchAdminUsers(): Promise<AdminUserRow[]> {
  const res = await admin('/api/admin/users')
  if (!res.ok) throw new Error(await readError(res))
  const j = (await res.json()) as { users: AdminUserRow[] }
  return j.users
}

export async function fetchAdminRoles(): Promise<RolesSnapshot> {
  const res = await admin('/api/admin/roles')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as RolesSnapshot
}

async function post(path: string, body: Record<string, unknown>): Promise<AdminResult> {
  let res: Response
  try {
    res = await admin(path, { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return { ok: false, error: e.message }
    }
    throw e
  }
  if (res.ok) return { ok: true }
  return { ok: false, error: await readError(res) }
}

export type UserAction =
  | { action: 'create'; email: string; name?: string; password?: string; roleSlugs?: string[] }
  | { action: 'invite'; email: string; roleSlugs?: string[] }
  | { action: 'deactivate'; membershipId: string }
  | { action: 'reactivate'; membershipId: string }
  | { action: 'set-roles'; membershipId: string; roleSlugs: string[] }
  /** Revokes access: the org membership goes, the WorkOS account survives. The
   *  server resolves the target from the member list — never from the body. */
  | { action: 'remove'; membershipId: string }
  /** Permanent: the WorkOS account and every membership of it. */
  | { action: 'delete'; userId: string }

export function adminUserAction(body: UserAction): Promise<AdminResult> {
  return post('/api/admin/users', body as unknown as Record<string, unknown>)
}

export type RoleAction =
  | { action: 'create-role'; slug: string; name: string }
  | { action: 'set-permissions'; slug: string; permissions: string[] }

export function adminRoleAction(body: RoleAction): Promise<AdminResult> {
  return post('/api/admin/roles', body as unknown as Record<string, unknown>)
}
