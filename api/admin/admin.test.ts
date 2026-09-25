import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { PERMISSIONS } from '../../src/lib/permissions.ts'

/**
 * Admin endpoint tests: the admin.manage gate, the WorkOS wrapper's arguments,
 * and the audit contract — every mutating action writes exactly one Audit Log
 * row and one app_revision bump through the shared Zoho client, then
 * invalidates the snapshot cache so every client's poll sees it.
 */
const mode = vi.hoisted(() => ({
  permissions: [] as string[],
  orgUsers: [] as {
    userId: string
    membershipId: string
    email: string
    name: string
    status: string
    roles: string[]
    lastSignInAt: string | null
  }[],
  roles: [] as { slug: string; name: string; permissions: string[] }[],
  permissionSlugs: [] as string[],
  calls: [] as string[],
  refuse: null as null | { status: number; message: string },
  /** When set, the mocked ensurePermissions throws — the GET must survive it. */
  refuseEnsure: false,
}))

vi.mock('../_lib/auth.ts', () => ({
  authenticate: vi.fn(async () => ({
    caller: { email: 'who@roligt.local', permissions: mode.permissions },
  })),
  AuthError: class AuthError extends Error {},
}))

vi.mock('../_lib/workosAdmin.ts', () => ({
  listOrgUsers: vi.fn(async () => mode.orgUsers),
  listRoles: vi.fn(async () => mode.roles),
  listPermissionSlugs: vi.fn(async () => mode.permissionSlugs),
  ensurePermissions: vi.fn(async (wanted: readonly { slug: string; name: string }[]) => {
    if (mode.refuseEnsure) {
      return wanted.map((w) => w.slug) // WorkOS refused everything
    }
    mode.calls.push(`ensure:${wanted.map((w) => w.slug).join('+')}`)
    mode.permissionSlugs = [...mode.permissionSlugs, ...wanted.map((w) => w.slug)]
    return []
  }),
  createUserWithRoles: vi.fn(async (input: { email: string }) => {
    mode.calls.push(`create:${input.email}`)
    if (mode.refuse) throw Object.assign(new Error(mode.refuse.message), { status: mode.refuse.status })
    return 'user_1'
  }),
  inviteUser: vi.fn(async (input: { email: string }) => {
    mode.calls.push(`invite:${input.email}`)
  }),
  setUserRoles: vi.fn(async (membershipId: string, roleSlugs: string[]) => {
    mode.calls.push(`set-roles:${membershipId}=${roleSlugs.join('+')}`)
  }),
  deactivateUser: vi.fn(async (membershipId: string) => {
    mode.calls.push(`deactivate:${membershipId}`)
  }),
  reactivateUser: vi.fn(async (membershipId: string) => {
    mode.calls.push(`reactivate:${membershipId}`)
  }),
  removeMembership: vi.fn(async (membershipId: string) => {
    mode.calls.push(`remove:${membershipId}`)
    if (mode.refuse) throw Object.assign(new Error(mode.refuse.message), { status: mode.refuse.status })
  }),
  deleteUserAccount: vi.fn(async (userId: string) => {
    mode.calls.push(`delete:${userId}`)
    if (mode.refuse) throw Object.assign(new Error(mode.refuse.message), { status: mode.refuse.status })
  }),
  createRole: vi.fn(async (slug: string, name: string) => {
    mode.calls.push(`create-role:${slug}:${name}`)
  }),
  setRolePermissions: vi.fn(async (slug: string, permissions: string[]) => {
    mode.calls.push(`set-permissions:${slug}=${permissions.join('+')}`)
  }),
}))

/** The writes writeAdminAudit makes, recorded off the stubbed wire. */
const writes = vi.hoisted(() => [] as { url: string; body: string }[])

vi.mock('../_lib/shared.ts', async () => {
  const { ZohoClient } = await vi.importActual<typeof import('../_lib/zoho.ts')>('../_lib/zoho.ts')
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const full = String(url)
    if (full.startsWith('https://accounts.zoho.in')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    if (init?.method === 'PUT') writes.push({ url: full, body: String(init.body ?? '') })
    return new Response(JSON.stringify({ records: { fetched: [] } }), { status: 200 })
  }
  return { zoho: new ZohoClient({ fetchImpl, env: {} as Record<string, string | undefined> }) }
})

vi.mock('../_lib/snapshot.ts', () => ({
  invalidateSnapshotCache: vi.fn(),
}))

const usersHandler = (await import('./users.ts')).default
const rolesHandler = (await import('./roles.ts')).default
const { T } = await import('../_lib/baseSchema.ts')
const { invalidateSnapshotCache } = await import('../_lib/snapshot.ts')

// the two Administration pages — the caller needs both to drive both handlers
const ADMIN = ['page.admin-users', 'page.admin-roles']

beforeEach(() => {
  mode.permissions = [...ADMIN]
  mode.orgUsers = []
  mode.roles = []
  mode.permissionSlugs = []
  mode.calls = []
  mode.refuse = null
  mode.refuseEnsure = false
  writes.length = 0
  vi.clearAllMocks()
})

function fakeRes() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
  }
  return res as unknown as VercelResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }
}

function fakeReq(body: unknown, method = 'POST'): VercelRequest {
  return { headers: {}, url: '/', method, body } as unknown as VercelRequest
}

/** A member row for the org list — the server resolves every target from these. */
function row(userId: string, membershipId: string, email: string, roles: string[] = []) {
  return { userId, membershipId, email, name: '', status: 'active', roles, lastSignInAt: null }
}

/** The caller as a listed active admin — production guarantees it (permissions
 *  ride a live membership), so the last-admin guards' tests mirror that. */
function withCallerAdmin(...others: ReturnType<typeof row>[]) {
  mode.roles = [{ slug: 'app-admin', name: 'App Admin', permissions: [...ADMIN] }]
  mode.orgUsers = [row('u1', 'm1', 'who@roligt.local', ['app-admin']), ...others]
}

/** The criteria of every recorded write, decoded — `"<fieldId>" = "<value>"` strings. */
const criteriaOf = () =>
  writes.map((w) => {
    const inQuery = /[?&]criteria=([^&]*)/.exec(w.url)?.[1]
    return decodeURIComponent((inQuery ?? w.body).replace(/\+/g, ' '))
  })
/** Which table each write hit — the criteria names the row, this names the table. */
const tableIdsOf = () => writes.map((w) => /[?&]table_id=([^&]*)/.exec(w.url)?.[1] ?? '')

describe('admin gate', () => {
  it('refuses both endpoints without the admin pages, touching nothing', async () => {
    mode.permissions = ['page.vendors']
    for (const handler of [usersHandler, rolesHandler]) {
      const res = fakeRes()
      await handler(fakeReq({ action: 'create', email: 'x@y.co' }), res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })
})

describe('GET', () => {
  it('lists users with their roles', async () => {
    mode.orgUsers = [
      {
        userId: 'u1',
        membershipId: 'm1',
        email: 'lead@roligt.local',
        name: 'Lead',
        status: 'active',
        roles: ['admin'],
        lastSignInAt: null,
      },
    ]
    const res = fakeRes()
    await usersHandler(fakeReq(null, 'GET'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ users: mode.orgUsers })
  })

  it('lists roles, permissions and assignment counts', async () => {
    mode.roles = [{ slug: 'admin', name: 'admin', permissions: [...ADMIN] }]
    mode.permissionSlugs = [...ADMIN]
    mode.orgUsers = [
      { userId: 'u1', membershipId: 'm1', email: 'a@x.co', name: '', status: 'active', roles: ['admin'], lastSignInAt: null },
      { userId: 'u2', membershipId: 'm2', email: 'b@x.co', name: '', status: 'active', roles: ['admin', 'operator'], lastSignInAt: null },
    ]
    const res = fakeRes()
    await rolesHandler(fakeReq(null, 'GET'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    // the page slugs missing from WorkOS were created on load, then listed
    const payload = res.json.mock.calls[0]![0] as { roles: unknown[]; permissions: string[]; assignments: Record<string, number>; missing: string[] }
    expect(payload.roles).toEqual(mode.roles)
    expect(payload.assignments).toEqual({ admin: 2, operator: 1 })
    expect(payload.missing).toEqual([])
    expect([...payload.permissions].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('hides WorkOS system widget permissions from the columns', async () => {
    mode.permissionSlugs = [...ADMIN, 'widgets:dsync:manage', 'widgets:users-table:manage']
    const res = fakeRes()
    await rolesHandler(fakeReq(null, 'GET'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const payload = res.json.mock.calls[0]![0] as { roles: unknown[]; permissions: string[]; assignments: Record<string, number>; missing: string[] }
    expect(payload.roles).toEqual([])
    expect(payload.assignments).toEqual({})
    expect(payload.missing).toEqual([])
    // order-insensitive: the admin pages start life in permissionSlugs, so `present` need not be in catalog order
    expect([...payload.permissions].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('creates the catalog slugs WorkOS is missing — a page must be tickable the moment an admin looks', async () => {
    mode.permissionSlugs = ['page.admin-users'] // a nearly-empty environment
    const res = fakeRes()
    await rolesHandler(fakeReq(null, 'GET'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls.some((c) => c.startsWith('ensure:') && c.includes('page.quality'))).toBe(true)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        missing: [],
        permissions: expect.arrayContaining(['page.quality', 'page.procurement', 'page.admin-roles']),
      }),
    )
  })

  it('survives WorkOS refusing to create slugs — 200, the failures listed, nothing invented', async () => {
    mode.permissionSlugs = [...ADMIN]
    mode.refuseEnsure = true
    const res = fakeRes()
    await rolesHandler(fakeReq(null, 'GET'), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const payload = res.json.mock.calls[0]![0] as { missing: string[]; permissions: string[] }
    expect(payload.missing.length).toBe(PERMISSIONS.length - ADMIN.length)
    expect(payload.permissions).toEqual([...ADMIN]) // only what really exists
  })

  it('refuses assigning a slug that only looks like a page permission', async () => {
    const res = fakeRes()
    await rolesHandler(fakeReq({ action: 'set-permissions', slug: 'app-admin', permissions: ['page.nope'] }), res)
    expect(res.status).toHaveBeenCalledWith(400)
  })
})

describe('mutations audit and bump', () => {
  it('creates a user, files one audit row and one revision bump, invalidates the cache', async () => {
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'create', email: 'new@roligt.local', roleSlugs: ['operator'] }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true })
    expect(mode.calls).toEqual(['create:new@roligt.local'])
    expect(writes).toHaveLength(2) // exactly one audit row + one revision bump
    const criteria = criteriaOf().join(' | ')
    const tables = tableIdsOf()
    expect(tables).toContain(T['Audit Log'].id)
    expect(tables).toContain(T['Config'].id)
    expect(criteria).toContain(`"${T['Audit Log'].appId}" = "AUD-admin-`) // fresh insert-only id
    expect(criteria).toContain(`"${T['Config'].fields['Setting']}" = "app_revision"`)
    expect(invalidateSnapshotCache).toHaveBeenCalledTimes(1)
  })

  it('sets roles on a membership and audits', async () => {
    mode.roles = [{ slug: 'admin', name: 'Admin', permissions: [...ADMIN] }]
    mode.orgUsers = [row('u9', 'm9', 'lead@roligt.local')]
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'set-roles', membershipId: 'm9', roleSlugs: ['admin'] }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls).toEqual(['set-roles:m9=admin'])
    expect(writes).toHaveLength(2)
  })

  // Budget note: every successful mutation rides the real ZohoClient in the
  // shared.ts mock, whose serialized Budget allows 17 writes a minute — and
  // writeAdminAudit costs 2 writes each. At most 8 successful-mutation tests
  // can run per file; the 9th sleeps a full minute waiting for the window and
  // times out. Keep audit-content assertions folded into existing successes,
  // not in new ones.

  it('creates a role and audits', async () => {
    const res = fakeRes()
    await rolesHandler(fakeReq({ action: 'create-role', slug: 'shift-lead', name: 'Shift Lead' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls).toEqual(['create-role:shift-lead:Shift Lead'])
    expect(writes).toHaveLength(2)
  })

  it('removes a membership, files one audit row and one revision bump', async () => {
    withCallerAdmin(row('u7', 'm7', 'gone@roligt.local'))
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'remove', membershipId: 'm7' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true })
    expect(mode.calls).toEqual(['remove:m7'])
    expect(writes).toHaveLength(2)
    expect(criteriaOf().join(' | ')).toContain(`"AUD-admin-`) // fresh insert-only id
  })

  it('permanently deletes a user and audits under their email', async () => {
    withCallerAdmin(row('u7', 'm7', 'gone@roligt.local'))
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'delete', userId: 'u7' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls).toEqual(['delete:u7'])
    expect(writes).toHaveLength(2)
    // the email rides in the audit row's record — URL-encoded into the data= param
    const wire = writes.map((w) => decodeURIComponent(`${w.url} ${w.body}`).replace(/\+/g, ' ')).join(' ')
    expect(wire).toContain('gone@roligt.local')
    expect(wire).toContain('user deleted')
  })

  it('deactivates a member and audits under their email', async () => {
    withCallerAdmin(row('u2', 'm2', 'napping@roligt.local'))
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'deactivate', membershipId: 'm2' }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls).toEqual(['deactivate:m2'])
    expect(writes).toHaveLength(2)
    const wire = writes.map((w) => decodeURIComponent(`${w.url} ${w.body}`).replace(/\+/g, ' ')).join(' ')
    expect(wire).toContain('napping@roligt.local')
    expect(wire).toContain('user deactivated')
  })
})

describe('self-protection and last-admin', () => {
  it('refuses removing the caller own access even when the body lies about the email', async () => {
    // the demonstrated bypass: ids name the caller, email claims someone else
    mode.orgUsers = [row('u1', 'm1', 'who@roligt.local')]
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'remove', membershipId: 'm1', email: 'someone.else@roligt.local' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses deleting the caller own account the same way', async () => {
    mode.orgUsers = [row('u1', 'm1', 'who@roligt.local')]
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'delete', userId: 'u1', email: 'someone.else@roligt.local' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses ids that are not members — nothing to audit, nothing to call', async () => {
    for (const body of [{ action: 'remove', membershipId: 'mX' }, { action: 'delete', userId: 'uX' }]) {
      const res = fakeRes()
      await usersHandler(fakeReq(body), res)
      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses a role change that would leave zero admins', async () => {
    mode.roles = [{ slug: 'app-admin', name: 'App Admin', permissions: [...ADMIN] }]
    mode.orgUsers = [row('u1', 'm1', 'who@roligt.local', ['app-admin'])]
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'set-roles', membershipId: 'm1', roleSlugs: [] }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses deactivating the caller own access', async () => {
    mode.orgUsers = [row('u1', 'm1', 'who@roligt.local')]
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'deactivate', membershipId: 'm1' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('refuses taking out the last active admin — by deactivation or removal', async () => {
    // the caller holds admin.manage via a session whose membership lost the
    // role — the guards must not care how stale the caller's claim is
    mode.roles = [{ slug: 'app-admin', name: 'App Admin', permissions: [...ADMIN] }]
    mode.orgUsers = [
      row('u1', 'm1', 'who@roligt.local'),
      row('u2', 'm2', 'sole@roligt.local', ['app-admin']),
    ]
    for (const body of [
      { action: 'deactivate', membershipId: 'm2' },
      { action: 'remove', membershipId: 'm2' },
      { action: 'delete', userId: 'u2' },
    ]) {
      const res = fakeRes()
      await usersHandler(fakeReq(body), res)
      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('allows self-demotion while another admin remains', async () => {
    mode.roles = [{ slug: 'app-admin', name: 'App Admin', permissions: [...ADMIN] }]
    mode.orgUsers = [
      row('u1', 'm1', 'who@roligt.local', ['app-admin']),
      row('u2', 'm2', 'other@roligt.local', ['app-admin']),
    ]
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'set-roles', membershipId: 'm1', roleSlugs: [] }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls).toEqual(['set-roles:m1='])
  })

  it('refuses stripping the admin pages from the last role carrying them', async () => {
    mode.roles = [{ slug: 'app-admin', name: 'App Admin', permissions: [...ADMIN] }]
    const res = fakeRes()
    await rolesHandler(fakeReq({ action: 'set-permissions', slug: 'app-admin', permissions: ['page.roster'] }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('allows stripping them once another role carries the admin pages — and audits the change', async () => {
    mode.roles = [
      { slug: 'app-admin', name: 'App Admin', permissions: [...ADMIN] },
      { slug: 'board', name: 'Board', permissions: [...ADMIN] },
    ]
    const res = fakeRes()
    await rolesHandler(fakeReq({ action: 'set-permissions', slug: 'app-admin', permissions: ['page.roster'] }), res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(mode.calls).toEqual(['set-permissions:app-admin=page.roster'])
    expect(writes).toHaveLength(2)
    const wire = writes.map((w) => decodeURIComponent(`${w.url} ${w.body}`).replace(/\+/g, ' ')).join(' ')
    expect(wire).toContain('role permissions set')
  })
})

describe('validation and upstream failures', () => {
  it('refuses a bad email with 400 and no writes', async () => {
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'create', email: 'not-an-email' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(writes).toEqual([])
  })

  it('refuses a bad role slug with 400', async () => {
    const res = fakeRes()
    await rolesHandler(fakeReq({ action: 'create-role', slug: 'Not A Slug', name: 'X' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('refuses assigning a permission outside the app catalog', async () => {
    const res = fakeRes()
    await rolesHandler(fakeReq({ action: 'set-permissions', slug: 'app-admin', permissions: ['widgets:dsync:manage'] }), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(mode.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('answers an unknown action with 400', async () => {
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'explode' }), res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('maps a WorkOS 4xx refusal to 502 without auditing a row that did not happen', async () => {
    mode.refuse = { status: 409, message: 'user exists' }
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'create', email: 'dupe@roligt.local', roleSlugs: [] }), res)
    expect(res.status).toHaveBeenCalledWith(502)
    expect(writes).toEqual([])
  })

  it('maps a WorkOS refusal on delete the same way', async () => {
    mode.refuse = { status: 404, message: 'user not found' }
    withCallerAdmin(row('uX', 'mX', 'x@roligt.local'))
    const res = fakeRes()
    await usersHandler(fakeReq({ action: 'delete', userId: 'uX' }), res)
    expect(res.status).toHaveBeenCalledWith(502)
    expect(writes).toEqual([])
  })
})
