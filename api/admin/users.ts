import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.ts'
import { zoho } from '../_lib/shared.ts'
import { writeAdminAudit } from '../_lib/adminAudit.ts'
import {
  createUserWithRoles,
  deactivateUser,
  deleteUserAccount,
  inviteUser,
  listOrgUsers,
  listRoles,
  reactivateUser,
  removeMembership,
  setUserRoles,
} from '../_lib/workosAdmin.ts'
import { toWebRequest } from '../_lib/vercel.ts'

import { ADMIN_PAGE_SLUGS } from '../../src/lib/permissions.ts'

/**
 * User administration — the Users page's surface (its tick carries this API).
 *
 * GET lists the organization's members with the roles their membership carries;
 * POST performs one action (create/invite/deactivate/reactivate/set-roles/
 * remove/delete). Every mutating action files one audit row and bumps the
 * revision, so the change is visible on every client's Audit page without a
 * reload. Every action that takes access away (deactivate/remove/delete)
 * resolves the target from the live member list — never from the request
 * body — so the caller's own row is always refused no matter what the body
 * claims, and none of them can leave the app without a single active member
 * able to administer it.
 */

type Body = {
  action?: 'create' | 'invite' | 'deactivate' | 'reactivate' | 'set-roles' | 'remove' | 'delete'
  email?: string
  name?: string
  password?: string
  membershipId?: string
  userId?: string
  roleSlugs?: string[]
}

/** Active memberships that would still hold an admin-carrying role after a change. */
async function adminsAfter(change: {
  /** A membership whose roles become these instead of what it holds now. */
  override?: { membershipId: string; roles: string[] }
  /** Memberships that stop counting — removed, deactivated, deleted. */
  without?: Set<string>
}): Promise<number> {
  const [roles, users] = await Promise.all([listRoles(), listOrgUsers()])
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

    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body
    const action = body?.action
    switch (action) {
      case 'create': {
        const email = String(body.email ?? '').trim()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          res.status(400).json({ error: 'A valid email address is required.' })
          return
        }
        const roleSlugs = asSlugs(body.roleSlugs)
        await createUserWithRoles({ email, name: body.name, password: body.password, roleSlugs })
        await writeAdminAudit(zoho, caller, 'user created', email, `roles: ${roleSlugs.join(', ') || 'none'}`)
        break
      }
      case 'invite': {
        const email = String(body.email ?? '').trim()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          res.status(400).json({ error: 'A valid email address is required.' })
          return
        }
        await inviteUser({ email, roleSlug: asSlugs(body.roleSlugs)[0] })
        await writeAdminAudit(zoho, caller, 'user invited', email, 'invitation sent by WorkOS')
        break
      }
      case 'deactivate': {
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
        if (row.email === caller.email) {
          res.status(400).json({ error: 'You cannot deactivate your own access — ask another admin.' })
          return
        }
        if ((await adminsAfter({ without: new Set([membershipId]) })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await deactivateUser(membershipId)
        await writeAdminAudit(zoho, caller, 'user deactivated', row.email, 'organization membership deactivated; their session retires within a minute')
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
        await reactivateUser(membershipId)
        await writeAdminAudit(zoho, caller, 'user reactivated', row.email, 'organization membership reactivated')
        break
      }
      case 'set-roles': {
        const membershipId = String(body.membershipId ?? '')
        if (!membershipId) {
          res.status(400).json({ error: 'membershipId is required.' })
          return
        }
        const roleSlugs = asSlugs(body.roleSlugs)
        if (!(await listOrgUsers()).some((u) => u.membershipId === membershipId)) {
          res.status(400).json({ error: 'That membership is not in the organization.' })
          return
        }
        // The caller may demote themselves — but never to a plant where nobody
        // at all can administer users (grant another admin first).
        if ((await adminsAfter({ override: { membershipId, roles: roleSlugs } })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await setUserRoles(membershipId, roleSlugs)
        await writeAdminAudit(zoho, caller, 'user roles set', membershipId, `roles: ${roleSlugs.join(', ') || 'none'}`)
        break
      }
      case 'remove': {
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
        // The guard reads the resolved row, never the body: a caller naming a
        // different email must not be able to remove their own access.
        if (row.email === caller.email) {
          res.status(400).json({ error: 'You cannot remove your own access — ask another admin.' })
          return
        }
        if ((await adminsAfter({ without: new Set([membershipId]) })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await removeMembership(membershipId)
        await writeAdminAudit(zoho, caller, 'user access removed', row.email, 'organization membership deleted; the WorkOS account survives')
        break
      }
      case 'delete': {
        const userId = String(body.userId ?? '')
        if (!userId) {
          res.status(400).json({ error: 'userId is required.' })
          return
        }
        const row = (await listOrgUsers()).find((u) => u.userId === userId)
        if (!row) {
          res.status(400).json({ error: 'That user is not in the organization — only members can be deleted from here.' })
          return
        }
        if (row.email === caller.email) {
          res.status(400).json({ error: 'You cannot delete your own account — ask another admin.' })
          return
        }
        if ((await adminsAfter({ without: new Set([row.membershipId]) })) === 0) {
          res.status(400).json({ error: 'Refused — this would leave nobody able to manage users. Grant another admin first.' })
          return
        }
        await deleteUserAccount(userId)
        await writeAdminAudit(zoho, caller, 'user deleted', row.email, 'WorkOS account permanently deleted, memberships with it')
        break
      }
      default:
        res.status(400).json({ error: 'Unknown action.' })
        return
    }
    res.status(200).json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    // A WorkOS refusal (409 email exists, 422 bad payload…) is theirs to read.
    const status = (e as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(502).json({ error: `WorkOS refused the request: ${(e as Error).message}` })
      return
    }
    res.status(500).json({ error: (e as Error).message })
  }
}
