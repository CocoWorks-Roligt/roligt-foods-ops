/**
 * The create/set-roles contract against WorkOS, pinned after the 2026-10-05
 * production 502: createUserWithRoles must survive a half-created user (the
 * retry adopts the orphan instead of dying on the duplicate email), must never
 * stack a second membership on one that already exists, and must never send an
 * explicit empty roleSlugs array — WorkOS refuses it with 422 "The role is
 * invalid." (verified live against Staging). The operator tier travels as an
 * omitted key on create and as the default `member` role on update.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const workos = vi.hoisted(() => ({
  userManagement: {
    createUser: vi.fn(),
    listUsers: vi.fn(),
    createOrganizationMembership: vi.fn(),
    listOrganizationMemberships: vi.fn(),
    updateOrganizationMembership: vi.fn(),
  },
}))
vi.mock('./workos.js', () => ({ workos }))

import { createUserWithRoles, setUserRoles } from './workosAdmin.js'

const refused = (status: number, message: string) =>
  Object.assign(new Error(message), { status })

beforeEach(() => {
  process.env.WORKOS_ORG_ID = 'org_test'
  vi.clearAllMocks()
  workos.userManagement.createUser.mockResolvedValue({ id: 'user_new' })
  workos.userManagement.listUsers.mockResolvedValue({ data: [] })
  workos.userManagement.listOrganizationMemberships.mockResolvedValue({ data: [] })
  workos.userManagement.createOrganizationMembership.mockResolvedValue({ id: 'om_new' })
})

describe('createUserWithRoles', () => {
  it('creates the user and their membership, passing the roles through', async () => {
    const id = await createUserWithRoles({ email: 'a@roligt.test', roleSlugs: ['app-admin'] })
    expect(id).toBe('user_new')
    expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: 'org_test',
      userId: 'user_new',
      roleSlugs: ['app-admin'],
    })
  })

  it('omits the roleSlugs key for the operator tier — an explicit [] is refused 422', async () => {
    await createUserWithRoles({ email: 'a@roligt.test', roleSlugs: [] })
    const payload = workos.userManagement.createOrganizationMembership.mock.calls[0]![0]
    expect('roleSlugs' in payload).toBe(false)
  })

  it('adopts the existing user when createUser refuses with a duplicate (the 2026-10-05 deadlock)', async () => {
    workos.userManagement.createUser.mockRejectedValue(refused(400, 'Could not create user.'))
    workos.userManagement.listUsers.mockResolvedValue({
      data: [{ id: 'user_orphan', email: 'a@roligt.test' }],
    })
    const id = await createUserWithRoles({ email: 'a@roligt.test', roleSlugs: ['app-admin'] })
    expect(id).toBe('user_orphan')
    expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_orphan', roleSlugs: ['app-admin'] }),
    )
  })

  it('rethrows the original refusal when the email resolves to nobody', async () => {
    const original = refused(400, 'Could not create user.')
    workos.userManagement.createUser.mockRejectedValue(original)
    workos.userManagement.listUsers.mockResolvedValue({ data: [] })
    await expect(createUserWithRoles({ email: 'a@roligt.test', roleSlugs: [] })).rejects.toBe(original)
    expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled()
  })

  it('does not look anything up on a 5xx — that is not an orphan, it is an outage', async () => {
    workos.userManagement.createUser.mockRejectedValue(refused(500, 'boom'))
    await expect(createUserWithRoles({ email: 'a@roligt.test', roleSlugs: [] })).rejects.toThrow('boom')
    expect(workos.userManagement.listUsers).not.toHaveBeenCalled()
  })

  it('keeps an existing membership instead of stacking a second one', async () => {
    workos.userManagement.listOrganizationMemberships.mockResolvedValue({
      data: [{ id: 'om_there' }],
    })
    const id = await createUserWithRoles({ email: 'a@roligt.test', roleSlugs: ['app-admin'] })
    expect(id).toBe('user_new')
    expect(workos.userManagement.createOrganizationMembership).not.toHaveBeenCalled()
  })
})

describe('setUserRoles', () => {
  it('maps the operator tier to the default member role — WorkOS refuses []', async () => {
    await setUserRoles('om_1', [])
    expect(workos.userManagement.updateOrganizationMembership).toHaveBeenCalledWith('om_1', {
      roleSlugs: ['member'],
    })
  })

  it('passes real roles through untouched', async () => {
    await setUserRoles('om_1', ['app-admin', 'qualitytester'])
    expect(workos.userManagement.updateOrganizationMembership).toHaveBeenCalledWith('om_1', {
      roleSlugs: ['app-admin', 'qualitytester'],
    })
  })
})
