import { describe, expect, it } from 'vitest'
import { roleFromClaims } from './kindeSession'

/**
 * Pins the role rule the whole permission model hangs off: only a Kinde `roles`
 * claim containing 'Admin' (case-insensitive, as a string key or as a role
 * object's key) makes a user an Admin. Anything else — other roles, an empty
 * list, a missing claim — is an Operator, because failing to prove somebody is
 * an admin must never read as proof that they are.
 */
describe('roleFromClaims', () => {
  it('maps the Admin role key to Admin', () => {
    expect(roleFromClaims(['Admin'])).toBe('Admin')
  })

  it('matches the admin key case-insensitively', () => {
    expect(roleFromClaims(['admin'])).toBe('Admin')
  })

  it('accepts Kinde role objects and reads their key', () => {
    expect(roleFromClaims([{ key: 'Admin', name: 'Administrator', id: 'r_1' }])).toBe('Admin')
  })

  it('maps any other role to Operator', () => {
    expect(roleFromClaims(['Operator'])).toBe('Operator')
  })

  it('maps an empty roles list to Operator', () => {
    expect(roleFromClaims([])).toBe('Operator')
  })

  it('maps a missing roles claim to Operator', () => {
    expect(roleFromClaims(undefined)).toBe('Operator')
  })
})
