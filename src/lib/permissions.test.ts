import { describe, expect, it } from 'vitest'
import {
  ADMIN_PAGE_SLUGS,
  PERMISSIONS,
  canAny,
  devPermissions,
  isAdminPermissions,
  permissionLabel,
  CONFIG_KEY_WRITE_PERMISSION,
  TABLE_WRITE_PERMISSION,
} from './permissions.ts'
import { PAGE_CATALOG } from './pages.ts'

describe('permission catalog', () => {
  it('is a list of dot-namespaced slugs with no duplicates', () => {
    expect(PERMISSIONS.length).toBe(new Set(PERMISSIONS).size)
    // hyphens are legal (page.control-samples) — the first WorkOS-created slug
    // that shipped with one broke the old letters-only regex
    for (const p of PERMISSIONS) expect(p).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)
  })

  it('stays small enough to ride in the session cookie', () => {
    // Every slug rides the sealed session cookie (~4 KB browser cap) inside a
    // JWT claim. 60 generous slugs ≈ 1.2 KB of claim — past that, trim or
    // restructure before the cookie silently stops fitting.
    expect(PERMISSIONS.length).toBeLessThanOrEqual(60)
  })

  it('keys every non-collection write gate to a catalog slug', () => {
    for (const perm of Object.values(TABLE_WRITE_PERMISSION)) {
      expect(PERMISSIONS).toContain(perm)
    }
    for (const perms of Object.values(CONFIG_KEY_WRITE_PERMISSION)) {
      for (const perm of perms) expect(PERMISSIONS).toContain(perm)
    }
  })

  it('is exactly the page catalog — pages are the whole vocabulary, and the manage slugs are gone', () => {
    expect([...PERMISSIONS].sort()).toEqual([...PAGE_CATALOG.map((p) => p.slug)].sort())
    for (const retired of ['masters.manage', 'staff.manage', 'config.manage', 'audit.manage', 'admin.manage']) {
      expect(PERMISSIONS).not.toContain(retired)
    }
  })

  it('labels every slug with its page', () => {
    for (const slug of PERMISSIONS) {
      expect(permissionLabel(slug).trim().length).toBeGreaterThan(0)
    }
    expect(permissionLabel('page.quality')).toBe('The Quality Control page')
    expect(permissionLabel('page.settings')).toBe('The Settings page')
    expect(permissionLabel('page.nope')).toBe('The page.nope page') // unknown slugs still render
  })

  it('names the Administration pages for the last-admin guards', () => {
    expect([...ADMIN_PAGE_SLUGS]).toEqual(['page.admin-users', 'page.admin-roles'])
  })
})

describe('canAny', () => {
  it('matches a held permission', () => {
    expect(canAny(['page.roster'], 'page.roster')).toBe(true)
  })

  it('needs only one of the alternatives', () => {
    expect(canAny(['page.roster'], 'page.vendors', 'page.roster')).toBe(true)
    expect(canAny([], 'page.vendors', 'page.roster')).toBe(false)
  })

  it('treats no requirements as open to any signed-in caller', () => {
    expect(canAny([])).toBe(true)
  })

  it('does not prefix-match', () => {
    expect(canAny(['page.roster.all'], 'page.roster')).toBe(false)
  })
})

describe('isAdminPermissions', () => {
  it('requires the whole catalog', () => {
    expect(isAdminPermissions([...PERMISSIONS])).toBe(true)
    expect(isAdminPermissions(PERMISSIONS.slice(1))).toBe(false)
    expect(isAdminPermissions([])).toBe(false)
  })
})

describe('devPermissions', () => {
  it('gives the dev Admin everything and the dev Operator nothing', () => {
    expect(devPermissions('Admin')).toEqual([...PERMISSIONS])
    expect(devPermissions('Operator')).toEqual([])
  })

  it('gives the dev Quality Tester the quality pages and nothing else', () => {
    expect(devPermissions('QualityTester')).toEqual([
      'page.quality',
      'page.control-samples',
      'page.reports',
      'page.test-parameters',
    ])
  })
})
