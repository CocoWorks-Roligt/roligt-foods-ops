import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError, type Caller } from '../_lib/auth.js'
import { LockedError } from '../_lib/store.js'
import { store } from '../_lib/shared.js'
import { writeAdminAudit } from '../_lib/engine.js'
import {
  createPasswordResetLink,
  createUserWithRoles,
  deactivateUser,
  deleteUserAccount,
  listOrgUsers,
  listRoles,
  reactivateUser,
  removeMembership,
  setUserRoles,
} from '../_lib/workosAdmin.js'
import { toWebRequest } from '../_lib/vercel.js'

import { ADMIN_PAGE_SLUGS } from '../../src/lib/permissions.js'

/**
 * User administration — the Users page's surface (its tick carries this API).
 *
 * GET lists the organization's members with the roles their membership carries;
 * POST performs one action (create/reset-link/deactivate/reactivate/set-roles/
 * remove/delete). Create and reset-link answer with the one-time password URL
 * they minted — the person sets their own password through it (verifying their
 * email on the way), so no admin ever types anyone's password and no onboarding
 * step depends on WorkOS mail surviving a Zoho spam filter. Every mutating
 * action writes its audit row FIRST — a failure upstream then leaves a trail
 * row recording the attempt, never a landed action the trail says nothing
 * about — and bumps the revision, so the change is visible on every client's
 * Audit page without a reload. Actions that grant or take over access
 * (create/set-roles/reset-link) sit under the role ceiling below; every action
 * that takes access away (deactivate/remove/delete) resolves the target from
 * the live member list — never from the request body — so the caller's own row
 * is always refused no matter what the body claims, and none of them can leave
 * the app without a single active member able to administer it.
 */

type Body = {
  action?: 'create' | 'reset-link' | 'deactivate' | 'reactivate' | 'set-roles' | 'remove' | 'delete'
  email?: string
  name?: string
  membershipId?: string
  userId?: string
  roleSlugs?: string[]
}

/** Active memberships that would still hold an admin-carrying role after a change.
 *  Takes the member list the handler already resolved — the guard used to fetch
 *  it a second time, two more WorkOS round-trips behind an action's back. */
async function adminsAfter(
  users: Awaited<ReturnType<typeof listOrgUsers>>,
  change: {
    /** A membership whose roles become these instead of what it holds now. */
    override?: { membershipId: string; roles: string[] }
    /** Memberships that stop counting — removed, deactivated, deleted. */
    without?: Set<string>
  },
): Promise<number> {
  const roles = await listRoles()
  const adminSlugs = new Set(
    roles.filter((r) => ADMIN_PAGE_SLUGS.some((p) => r.permissions.includes(p))).map((r) => r.slug),
  )
  return users.filter((u) => {
    if (u.status !== 'active' || change.without?.has(u.membershipId)) return false
    const held =
      change.override && u.membershipId === change.override.membershipId ? change.override.roles : u.roles
    return held.some((s) => adminSlugs.has(s))
  }).length
}

const asSlugs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter((s) => /^[a-z0-9:\-_.*]+$/.test(s)) : []

/** The union of permissions the given role slugs carry — unknown slugs add
 *  nothing (WorkOS refuses them at the mutation itself). */
const unionOfRoles = (roles: Awaited<ReturnType<typeof listRoles>>, slugs: string[]): Set<string> => {
  const union = new Set<string>()
  for (const slug of slugs) {
    for (const p of roles.find((r) => r.slug === slug)?.permissions ?? []) union.add(p)
  }
  return union
}

/**
 * The role ceiling (the audit's S3-7): page.admin-users alone used to be
 * full-admin equivalence — set-roles could grant the full-catalog role, create
 * could mint one, and reset-link could hand a stronger member their password.
 * A caller may only grant or take over access they already hold: the roles
 * involved may carry no permission outside the caller's own set. Actions that
 * merely reduce access (deactivate/remove/delete) are deliberately NOT
 * ceiling-gated — the last-admin guard bounds those, and taking access away is
 * never a privilege escalation.
 */
const withinCeiling = (union: Set<string>, caller: Caller) =>
  [...union].every((p) => caller.permissions.includes(p))

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!caller.permissions.includes('page.admin-users')) {
      res.status(403).json({ error: 'You do not have permission to manage users.' })
      return
    }

    if (req.method === 'GET') {
      res.status(200).json({ users: await listOrgUsers() })
      return
    }

    // same CSRF second line as the commit route: a text/plain form-stitched
    // body never reaches the parser
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'Requests must be application/json.' })
      return
    }
    let body: Body
    try {
      body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body
    } catch {
      res.status(400).json({ error: 'Malformed request body.' })
      return
    }
    const action = body?.action
    /** Fields only some actions answer with — the minted link, when one was. */
    const extra: Record<string, string> = {}
    switch (action) {
      case 'create': {
        const email = String(body.email ?? '').trim()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          res.status(400).json({ error: 'A valid email address is required.' })
          return
        }
        const roleSlugs = asSlugs(body.roleSlugs)
        if (!withinCeiling(unionOfRoles(await listRoles(), roleSlugs), caller)) {
          res.status(403).json({ error: 'You can only grant roles no stronger than your own.' })
          return
        }
        // Audited first: a failure after this leaves a trail row recording the
        // attempt, never an un-audited landed action — and the row's own
        // reset-link action names the state to check.
        await writeAdminAudit(store, caller, 'user created', email, `roles: ${roleSlugs.join(', ') || 'none'}`)
        await createUserWithRoles({ email, name: body.name, roleSlugs })
        try {
          const link = await createPasswordResetLink(email)
          extra.resetUrl = link.url
          extra.expiresAt = link.expiresAt
        } catch (e) {
          extra.linkError = `The user was created, but the password link failed: ${(e as Error).message}`
        }
        break
      }
      case 'reset-link': {
        const membershipId = String(body.membershipId ?? '')
        if (!membershipId) {
          res.status(400).json({ error: 'membershipId is required.' })
          return
        }
        const row = (await listOrgUsers()).find((u) => u.membershipId === membershipId)
        if (!row) {
          res.status(400).json({ error: 'That user is not in the organization — perhaps already removed.' })
          return
        }
        // A password link for a member holding more than the caller is account
        // takeover by another name — the ceiling covers the target's CURRENT
        // roles, not what the request claims about them.
        if (!withinCeiling(unionOfRoles(await listRoles(), row.roles), caller)) {
          res.status(403).json({ error: 'A password link for this member would hand over more access than you hold — ask a full admin.' })
          return
        }
        await writeAdminAudit(store, caller, 'password link minted', row.email, 'one-time link; the holder sets this user’s password')
        const link = await createPasswordResetLink(row.email)
        extra.resetUrl = link.url
        extra.expiresAt = link.expiresAt
        break
      }
      case 'deactivate': {
        const membershipId = String(body.membershipId ?? '')
        if (!membershipId) {
          res.status(400).json({ error: 'membershipId is required.' })
          return
        }
        const users = await listOrgUsers()
        const row = users.find((u) => u.membershipId === membershipId)
        if (!row) {
          res.status(400).json({ error: 'That user is not in the organization — perhaps already removed.' })
          return
        }
        if (row.email === caller.email) {
          res.status(400).json({ error: 'You cannot deactivate your own access — ask another admin.' })
          return
        }
        if ((await adminsAfter(users, { without: new Set([membershipId]) })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await writeAdminAudit(store, caller, 'user deactivated', row.email, 'organization membership deactivated; their session retires within a minute')
        await deactivateUser(membershipId)
        break
      }
      case 'reactivate': {
        const membershipId = String(body.membershipId ?? '')
        if (!membershipId) {
          res.status(400).json({ error: 'membershipId is required.' })
          return
        }
        const row = (await listOrgUsers()).find((u) => u.membershipId === membershipId)
        if (!row) {
          res.status(400).json({ error: 'That user is not in the organization — perhaps already removed.' })
          return
        }
        await writeAdminAudit(store, caller, 'user reactivated', row.email, 'organization membership reactivated')
        await reactivateUser(membershipId)
        break
      }
      case 'set-roles': {
        const membershipId = String(body.membershipId ?? '')
        if (!membershipId) {
          res.status(400).json({ error: 'membershipId is required.' })
          return
        }
        const roleSlugs = asSlugs(body.roleSlugs)
        const users = await listOrgUsers()
        if (!users.some((u) => u.membershipId === membershipId)) {
          res.status(400).json({ error: 'That membership is not in the organization.' })
          return
        }
        if (!withinCeiling(unionOfRoles(await listRoles(), roleSlugs), caller)) {
          res.status(403).json({ error: 'You can only grant roles no stronger than your own.' })
          return
        }
        // The caller may demote themselves — but never to a plant where nobody
        // at all can administer users (grant another admin first).
        if ((await adminsAfter(users, { override: { membershipId, roles: roleSlugs } })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await writeAdminAudit(store, caller, 'user roles set', membershipId, `roles: ${roleSlugs.join(', ') || 'none'}`)
        await setUserRoles(membershipId, roleSlugs)
        break
      }
      case 'remove': {
        const membershipId = String(body.membershipId ?? '')
        if (!membershipId) {
          res.status(400).json({ error: 'membershipId is required.' })
          return
        }
        const users = await listOrgUsers()
        const row = users.find((u) => u.membershipId === membershipId)
        if (!row) {
          res.status(400).json({ error: 'That user is not in the organization — perhaps already removed.' })
          return
        }
        // The guard reads the resolved row, never the body: a caller naming a
        // different email must not be able to remove their own access.
        if (row.email === caller.email) {
          res.status(400).json({ error: 'You cannot remove your own access — ask another admin.' })
          return
        }
        if ((await adminsAfter(users, { without: new Set([membershipId]) })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await writeAdminAudit(store, caller, 'user access removed', row.email, 'organization membership deleted; the WorkOS account survives')
        await removeMembership(membershipId)
        break
      }
      case 'delete': {
        const userId = String(body.userId ?? '')
        if (!userId) {
          res.status(400).json({ error: 'userId is required.' })
          return
        }
        const users = await listOrgUsers()
        const row = users.find((u) => u.userId === userId)
        if (!row) {
          res.status(400).json({ error: 'That user is not in the organization — only members can be deleted from here.' })
          return
        }
        if (row.email === caller.email) {
          res.status(400).json({ error: 'You cannot delete your own account — ask another admin.' })
          return
        }
        if ((await adminsAfter(users, { without: new Set([row.membershipId]) })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await writeAdminAudit(store, caller, 'user deleted', row.email, 'WorkOS account permanently deleted, memberships with it')
        await deleteUserAccount(userId)
        break
      }
      default:
        res.status(400).json({ error: 'Unknown action.' })
        return
    }
    res.status(200).json({ ok: true, ...extra })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    // The audit write is the FIRST write of every action now, so a Zoho lock
    // here means nothing landed at all — retryable, never a 500, and never a
    // change the trail missed.
    if (e instanceof LockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — nothing was changed. Try again shortly.' })
      return
    }
    // A WorkOS refusal (409 email exists, 422 bad payload…) is theirs to read.
    const status = (e as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(502).json({ error: `WorkOS refused the request: ${(e as Error).message}` })
      return
    }
    console.error('[admin/users]', e)
    res.status(500).json({ error: 'The user change failed on the server — check the list before retrying.' })
  }
}
