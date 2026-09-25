import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.ts'
import { zoho } from '../_lib/shared.ts'
import { writeAdminAudit } from '../_lib/adminAudit.ts'
import {
  createRole,
  ensurePermissions,
  listOrgUsers,
  listPermissionSlugs,
  listRoles,
  setRolePermissions,
} from '../_lib/workosAdmin.ts'
import { toWebRequest } from '../_lib/vercel.ts'
import { ADMIN_PAGE_SLUGS, PERMISSIONS, permissionLabel } from '../../src/lib/permissions.ts'

/**
 * Role administration — the Roles & Permissions page's surface (its tick
 * carries this API).
 *
 * GET returns the roles, the permission slugs that exist, and who holds what
 * (the matrix's rows and columns plus the assignment counts); POST creates a
 * role or replaces a role's permission set. Mutations audit and bump like the
 * user actions do.
 *
 * Only the app's own catalog is shown or assignable: WorkOS also lists its
 * system `widgets:*` permissions (dashboard widgets — Directory Sync, the
 * users table, SSO…), which the app never reads and no role here should
 * carry. Every permission is a page tick (src/lib/pages.ts).
 */

type Body = {
  action?: 'create-role' | 'set-permissions'
  slug?: string
  name?: string
  permissions?: string[]
}

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!caller.permissions.includes('page.admin-roles')) {
      res.status(403).json({ error: 'You do not have permission to manage roles.' })
      return
    }

    if (req.method === 'GET') {
      const [roles, permissionSlugs, users] = await Promise.all([listRoles(), listPermissionSlugs(), listOrgUsers()])
      const catalog = new Set<string>(PERMISSIONS)
      // A catalog slug that does not exist in WorkOS yet cannot be ticked, and
      // the first admin visit after a deploy is exactly when it must become
      // tickable — so this GET creates what is missing (idempotent, and a GET
      // must never 500 over it: failures come back as `missing` for the banner).
      let present = permissionSlugs
      const wanted = PERMISSIONS.filter((p) => !permissionSlugs.includes(p))
      let notCreated: string[] = []
      if (wanted.length) {
        notCreated = await ensurePermissions(wanted.map((slug) => ({ slug, name: permissionLabel(slug) })))
        if (notCreated.length < wanted.length) present = await listPermissionSlugs()
      }
      const assignments: Record<string, number> = {}
      for (const user of users) {
        for (const slug of user.roles) assignments[slug] = (assignments[slug] ?? 0) + 1
      }
      res.status(200).json({
        roles,
        permissions: present.filter((p) => catalog.has(p)),
        assignments,
        missing: notCreated,
      })
      return
    }

    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body
    switch (body?.action) {
      case 'create-role': {
        const slug = String(body.slug ?? '').trim()
        const name = String(body.name ?? '').trim()
        // WorkOS slug rules: lowercase letters, digits and -._:* — one label, no spaces.
        if (!/^[a-z0-9][a-z0-9.\-_:*]*$/.test(slug) || !name) {
          res.status(400).json({ error: 'A slug (lowercase, no spaces) and a name are required.' })
          return
        }
        await createRole(slug, name)
        await writeAdminAudit(zoho, caller, 'role created', slug, name)
        break
      }
      case 'set-permissions': {
        const slug = String(body.slug ?? '').trim()
        const catalog = new Set<string>(PERMISSIONS)
        const permissions = Array.isArray(body.permissions)
          ? body.permissions.map(String).filter((p) => /^[a-z0-9.\-:_.*]+$/.test(p))
          : []
        if (!slug) {
          res.status(400).json({ error: 'slug is required.' })
          return
        }
        if (permissions.some((p) => !catalog.has(p))) {
          res.status(400).json({ error: 'Only the app\'s own permissions can be assigned to a role.' })
          return
        }
        const roles = await listRoles()
        if (!roles.some((r) => r.slug === slug)) {
          res.status(400).json({ error: 'No such role.' })
          return
        }
        // Somebody must always be able to administer the app: after this save,
        // each Administration page must still be carried by some role, or
        // nobody could ever grant it back from the inside (the seed script
        // would be the only way out).
        for (const page of ADMIN_PAGE_SLUGS) {
          const stillCarried = roles.some((r) =>
            (r.slug === slug ? permissions : r.permissions).includes(page),
          )
          if (!stillCarried) {
            res.status(400).json({ error: `Refused — some role must keep ${page}, or nobody could ever administer the app again.` })
            return
          }
        }
        await setRolePermissions(slug, permissions)
        await writeAdminAudit(zoho, caller, 'role permissions set', slug, `permissions: ${permissions.join(', ') || 'none'}`)
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
    const status = (e as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(502).json({ error: `WorkOS refused the request: ${(e as Error).message}` })
      return
    }
    res.status(500).json({ error: (e as Error).message })
  }
}
