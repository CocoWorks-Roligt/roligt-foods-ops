/**
 * The one place the BFF touches WorkOS's management API.
 *
 * Everything here runs server-side under the M2M key (sk_) and is reached only
 * through /api/admin/*, which is gated by the Users page tick — the permission to
 * administer permissions. The SDK's exact method names and payload shapes are
 * pinned here (verified against @workos-inc/node 10.14.0's types) so the
 * handlers above never see WorkOS vocabulary, and a SDK upgrade breaks in this
 * one file rather than everywhere.
 */
import { workos } from './workos.js'

/** An org member as the admin screens see them. */
export interface AdminUserRow {
  userId: string
  membershipId: string
  email: string
  name: string
  status: string
  /** Environment-role slugs the membership carries; sessions translate these to permissions. */
  roles: string[]
  lastSignInAt: string | null
}

/** A role as the matrix sees it. */
export interface AdminRole {
  slug: string
  name: string
  permissions: string[]
}

function orgId(): string {
  const id = process.env.WORKOS_ORG_ID
  if (!id) {
    throw new Error('WORKOS_ORG_ID is not set — run scripts/workos/seed-rbac.mjs and add it to the environment.')
  }
  return id
}

/** Everyone in the organization, with the roles their membership carries. */
export async function listOrgUsers(): Promise<AdminUserRow[]> {
  // autoPagination, not .data — the default page is 10 rows and this list must be whole.
  const [memberships, users] = await Promise.all([
    workos.userManagement.listOrganizationMemberships({ organizationId: orgId() }).then((l) => l.autoPagination()),
    workos.userManagement.listUsers().then((l) => l.autoPagination()),
  ])
  const byId = new Map(users.map((u) => [u.id, u]))
  return memberships
    .map((m): AdminUserRow | null => {
      const user = byId.get(m.userId)
      if (!user) return null // a membership whose user was deleted; not ours to show
      const roles = m.roles?.map((r) => r.slug) ?? [m.role.slug]
      return {
        userId: user.id,
        membershipId: m.id,
        email: user.email,
        name: user.name ?? '',
        status: m.status,
        roles,
        lastSignInAt: user.lastSignInAt,
      }
    })
    .filter((r): r is AdminUserRow => r !== null)
}

/** Creates the user and their org membership in one action. No password —
 *  the person sets their own through a link minted right after (below).
 *
 *  Idempotent by design: the two calls can die between them (the 2026-10-05
 *  production 502 — the user was created, the membership was refused), and the
 *  half-created user is invisible in the member list yet blocks every retry
 *  with "Could not create user." So a refused createUser adopts the existing
 *  user by email, and a membership that already exists is kept rather than
 *  duplicated — WorkOS accepts a second membership for the same user+org
 *  (pinned against Staging 2026-10-05), so a blind create would stack one per
 *  retry. */
export async function createUserWithRoles(input: {
  email: string
  name?: string
  roleSlugs: string[]
}): Promise<AdminUserRow['userId']> {
  let userId: string
  try {
    const user = await workos.userManagement.createUser({
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
    })
    userId = user.id
  } catch (e) {
    // A 4xx refusal is usually "the email already exists", but it could be
    // anything — adopt the user only when the email resolves to exactly them.
    const status = (e as { status?: number }).status
    if (typeof status !== 'number' || status < 400 || status >= 500) throw e
    const existing = (await workos.userManagement.listUsers({ email: input.email })).data.find(
      (u) => u.email.toLowerCase() === input.email.toLowerCase(),
    )
    if (!existing) throw e
    userId = existing.id
  }
  const memberships = await workos.userManagement.listOrganizationMemberships({
    organizationId: orgId(),
    userId,
  })
  if (!memberships.data.length) {
    await workos.userManagement.createOrganizationMembership({
      organizationId: orgId(),
      userId,
      // An explicit empty array is refused (422 "The role is invalid." — the
      // other half of the 2026-10-05 502, pinned against Staging); omitting the
      // key gives the environment's default role instead, which carries no page
      // permissions — the picker's "No role — the day's work only" tier.
      ...(input.roleSlugs.length ? { roleSlugs: input.roleSlugs } : {}),
    })
  }
  invalidateMemberMirror()
  return userId
}

/**
 * A minute-stale mirror of who is an active member. WorkOS's sealed session
 * cookie outlives the membership it came from — removing, deactivating or
 * deleting someone does nothing to a browser already holding a session — so
 * authenticate() asks this before trusting one. Refreshes are kept off the
 * hot path by the TTL; a failed refresh serves the stale mirror rather than
 * locking the whole plant out.
 */
let memberMirror: { at: number; emails: Set<string> } | null = null
const MEMBER_MIRROR_TTL_MS = 60_000

/** True when the email belongs to an active member — the session-retirement gate. */
export async function isActiveMember(email: string): Promise<boolean> {
  if (!memberMirror || Date.now() - memberMirror.at > MEMBER_MIRROR_TTL_MS) {
    try {
      memberMirror = {
        at: Date.now(),
        emails: new Set(
          (await listOrgUsers())
            .filter((u) => u.status === 'active')
            .map((u) => u.email.toLowerCase()),
        ),
      }
    } catch (e) {
      if (!memberMirror) throw e
      console.warn('[workosAdmin] member mirror refresh failed — serving the stale mirror', e)
    }
  }
  return memberMirror.emails.has(email.toLowerCase())
}

/** Drops the mirror so this file's own mutations bite at once. */
export function invalidateMemberMirror(): void {
  memberMirror = null
}

/**
 * Mints a one-time password-reset link for a user. WorkOS also sends the usual
 * reset email — which Zoho inboxes keep spam-foldering — so the URL is handed
 * back for the admin to deliver by a channel that actually reaches the person;
 * when the mail does arrive, it is a bonus, not the path. Completing the link
 * sets the password and verifies the email in one step. It is NOT an app
 * sign-in: the completion redirect reaches /api/auth/callback with no live
 * sign-in session to exchange (the state+verifier pair only exists when the
 * Sign-in button started the flow), so it is refused and lands on the login
 * card — the person signs in with their new password from there. Tokens are
 * single-use and expire in ~15 minutes.
 */
export async function createPasswordResetLink(email: string): Promise<{ url: string; expiresAt: string }> {
  const reset = await workos.userManagement.createPasswordReset({ email })
  return { url: reset.passwordResetUrl, expiresAt: reset.expiresAt }
}

export async function setUserRoles(membershipId: string, roleSlugs: string[]): Promise<void> {
  await workos.userManagement.updateOrganizationMembership(membershipId, {
    // Empty is the operator tier, but the update call refuses an empty array
    // just like the create does (422 "The role is invalid.", pinned against
    // Staging 2026-10-05) — the tier is the environment's default `member`
    // role, which is assignable and carries no page permissions.
    roleSlugs: roleSlugs.length ? roleSlugs : ['member'],
  })
}

export async function deactivateUser(membershipId: string): Promise<void> {
  await workos.userManagement.deactivateOrganizationMembership(membershipId)
  invalidateMemberMirror()
}

export async function reactivateUser(membershipId: string): Promise<void> {
  await workos.userManagement.reactivateOrganizationMembership(membershipId)
  invalidateMemberMirror()
}

/**
 * Removes the user from the organization — they can no longer sign in to the
 * app, but their WorkOS account survives, so re-adding them later is one click.
 */
export async function removeMembership(membershipId: string): Promise<void> {
  await workos.userManagement.deleteOrganizationMembership(membershipId)
  invalidateMemberMirror()
}

/**
 * Permanently deletes the user. Verified against Staging (2026-09-25): the org
 * memberships die with the user, so there is nothing to remove first.
 */
export async function deleteUserAccount(userId: string): Promise<void> {
  await workos.userManagement.deleteUser(userId)
  invalidateMemberMirror()
}

/**
 * WorkOS's built-in roles (`member`, `admin`) ship with every environment,
 * cannot be deleted, and carry none of our permission slugs — the system
 * `admin` holds WorkOS dashboard-widget permissions the app never reads.
 * Showing them in the matrix only invites "why are there two admins?"; the
 * app manages its own roles, so these stay ours to filter out.
 */
const SYSTEM_ROLE_SLUGS = new Set(['member', 'admin'])

/** Every environment role with its attached permission slugs. */
export async function listRoles(): Promise<AdminRole[]> {
  const roles = await workos.authorization.listEnvironmentRoles()
  return roles.data
    .filter((r) => !SYSTEM_ROLE_SLUGS.has(r.slug))
    .map((r) => ({ slug: r.slug, name: r.name, permissions: [...r.permissions] }))
}

/** Every permission slug that exists in the environment. */
export async function listPermissionSlugs(): Promise<string[]> {
  const permissions = await workos.authorization.listPermissions()
  return (await permissions.autoPagination()).map((p) => p.slug)
}

export async function createRole(slug: string, name: string): Promise<void> {
  await workos.authorization.createEnvironmentRole({ slug, name })
}

/**
 * Creates any catalog slugs missing from the environment, idempotently — the
 * Roles screen calls this on load so a new page permission is tickable the
 * moment an admin first looks, without waiting for the seed script. Returns
 * the slugs that could NOT be created (the caller shows them; a GET must never
 * 500 over this). A 4xx "already exists" counts as success.
 */
export async function ensurePermissions(
  wanted: readonly { slug: string; name: string }[],
): Promise<string[]> {
  const failed: string[] = []
  for (const { slug, name } of wanted) {
    try {
      await workos.authorization.createPermission({ slug, name })
    } catch (e) {
      const status = (e as { status?: number }).status
      // 409/422 = it already exists; anything else is a real refusal worth surfacing
      if (typeof status !== 'number' || status < 400 || status >= 500) {
        if (!/already exists|duplicate/i.test((e as Error).message)) failed.push(slug)
      }
    }
  }
  return failed
}

/** Replaces the role's permission set wholesale — the matrix's Save button. */
export async function setRolePermissions(slug: string, permissions: string[]): Promise<void> {
  await workos.authorization.setEnvironmentRolePermissions(slug, { permissions })
}
