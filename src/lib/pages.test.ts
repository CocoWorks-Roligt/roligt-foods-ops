import { describe, expect, it } from 'vitest'
import {
  PAGE_CATALOG,
  allowedPages,
  canViewPage,
  firstAllowedPath,
  isPageSlug,
  pageBySlug,
  pageScope,
  pageSlug,
} from './pages.ts'
import { PERMISSIONS } from './permissions.ts'
import { COLLECTIONS } from './tables.ts'
import { PAGES } from './utils.ts'
import type { ViewId } from '../types.ts'

describe('PAGE_CATALOG', () => {
  it('covers every ViewId and every PAGES title key, exactly once, in nav order', () => {
    // type-level: the catalog's ids are ViewIds…
    const ids: ViewId[] = PAGE_CATALOG.map((p) => p.id)
    // …and runtime: they are all of them, unique, and the display map agrees
    expect(new Set(ids).size).toBe(PAGE_CATALOG.length)
    expect([...ids].sort()).toEqual(Object.keys(PAGES).sort())
    expect(PAGE_CATALOG.length).toBe(26)
  })

  it('has unique paths and unique slugs', () => {
    const paths = PAGE_CATALOG.map((p) => p.path)
    expect(new Set(paths).size).toBe(paths.length)
    const slugs = PAGE_CATALOG.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('names every slug page.<id>, and every slug is a catalog permission', () => {
    // every page is tickable — Settings and Administration included
    for (const page of PAGE_CATALOG) {
      expect(page.slug).toBe(`page.${page.id}`)
      expect(PERMISSIONS).toContain(page.slug)
    }
    expect(pageSlug('settings')).toBe('page.settings')
    expect(pageSlug('admin-users')).toBe('page.admin-users')
    expect(pageSlug('admin-roles')).toBe('page.admin-roles')
  })

  it('every collection page field names a catalog row', () => {
    for (const spec of COLLECTIONS) {
      if (!spec.page) continue
      for (const page of typeof spec.page === 'string' ? [spec.page] : spec.page) {
        expect(PAGE_CATALOG.some((p) => p.id === page), page).toBe(true)
      }
    }
  })
})

describe('pageScope', () => {
  it('null for the operator — no page permissions means the whole day\'s work', () => {
    expect(pageScope([])).toBeNull()
    // a retired manage slug is not a page slug — it grants nothing here
    expect(pageScope(['masters.manage', 'admin.manage'])).toBeNull()
  })

  it('the held pages for a scoped caller', () => {
    expect(pageScope(['page.quality'])).toEqual(new Set(['quality']))
    expect(pageScope(['page.procurement', 'page.inventory'])).toEqual(new Set(['procurement', 'inventory']))
  })

  it('scopes a full administrator too — the admin is just every page ticked, not a special case', () => {
    expect(pageScope(PERMISSIONS)).toEqual(new Set(PAGE_CATALOG.map((p) => p.id)))
  })

  it('ignores slugs no page owns', () => {
    expect(pageScope(['page.nope'])).toBeNull()
  })
})

describe('allowedPages — the one visibility rule', () => {
  it('unscoped: the whole open tier — the operator, and nothing above it', () => {
    const pages = allowedPages([])
    expect(pages.map((p) => p.id)).toEqual(PAGE_CATALOG.filter((p) => p.tier === 'open').map((p) => p.id))
    // a legacy manage slug opens nothing: it is not a page
    expect(allowedPages(['masters.manage', 'config.manage']).map((p) => p.id)).toEqual(pages.map((p) => p.id))
  })

  it('scoped: exactly the ticked pages, Test Parameters included, in catalog order', () => {
    const lab = allowedPages(['page.quality', 'page.control-samples', 'page.reports', 'page.test-parameters'])
    expect(lab.map((p) => p.id)).toEqual(['quality', 'control-samples', 'reports', 'test-parameters'])
  })

  it('a masters tick works on its own — and Settings and Administration are ordinary ticks', () => {
    const clerk = allowedPages(['page.vendors'])
    expect(clerk.map((p) => p.id)).toEqual(['vendors'])
    const admin = allowedPages(['page.settings', 'page.admin-users', 'page.admin-roles'])
    expect(admin.map((p) => p.id)).toEqual(['settings', 'admin-users', 'admin-roles'])
    // every tick at once is the full app — the seeded administrator
    expect(allowedPages([...PERMISSIONS]).map((p) => p.id)).toEqual(PAGE_CATALOG.map((p) => p.id))
  })

  it('firstAllowedPath lands on the first held page', () => {
    expect(firstAllowedPath([])).toBe('/') // the operator's dashboard
    expect(firstAllowedPath(['page.quality', 'page.packing'])).toBe('/quality')
  })

  it('canViewPage keeps reports and live-reports independent', () => {
    const held = ['page.reports']
    expect(canViewPage(held, 'reports')).toBe(true)
    expect(canViewPage(held, 'live-reports')).toBe(false)
    expect(canViewPage(['page.live-reports'], 'reports')).toBe(false)
  })
})

describe('slug lookups', () => {
  it('pageBySlug resolves and rejects', () => {
    expect(pageBySlug('page.quality')?.id).toBe('quality')
    expect(pageBySlug('page.settings')?.id).toBe('settings')
    expect(pageBySlug('masters.manage')).toBeUndefined()
    expect(isPageSlug('page.stock-issues')).toBe(true)
    expect(isPageSlug('page.nope')).toBe(false)
  })
})
