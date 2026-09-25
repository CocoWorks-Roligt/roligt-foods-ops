/**
 * The page catalog — every screen of the app in one list, and the one visibility
 * rule computed from it.
 *
 * A permission IS a page: there is no separate "manage" vocabulary, only
 * `page.<id>` slugs. The default app is the whole day's work (the open tier),
 * free to every signed-in caller; a caller holding any page slug is scoped
 * instead, to exactly the pages they hold — day's work, masters, Settings,
 * Administration, all of it just ticks. The admin composes that at runtime on
 * the Roles screen — tick pages, save, assign — so nothing here is keyed to a
 * page name or a role, and a new scoped role is never a code change.
 *
 * One row per nav entry, in sidebar order, so `firstAllowedPath` is where a
 * scoped caller lands. Layout's nav, App's route gates, the Roles editor and
 * the BFF's commit gate all read this list — visibility can never disagree
 * between the UI and the server.
 *
 * Like the other isomorphic libs this module is compiled by both tsconfig
 * projects: .ts extension on imports, no React, no browser globals. It must
 * also never import permissions.ts (permissions is derived from pages — the
 * dependency runs one way).
 */
import type { ViewId } from '../types.ts'

export type PageTier = 'open' | 'masters' | 'settings' | 'admin'

export interface PageRow {
  id: ViewId
  path: string
  label: string
  /** `page.<id>` — every page is tickable on a role, and a tick carries the page's writes. */
  slug: string
  tier: PageTier
  /** Sidebar sub-heading inside the day's work ('Planning', 'Stock', …). */
  group?: string
}

/** Every page, in sidebar order. */
export const PAGE_CATALOG: readonly PageRow[] = [
  // The day's work — open to every signed-in caller, tickable for scoped roles.
  { id: 'dashboard', path: '/', label: 'Dashboard', slug: 'page.dashboard', tier: 'open' },
  { id: 'procurement', path: '/procurement', label: 'Procurement', slug: 'page.procurement', tier: 'open' },
  // Planning sits between what arrived and what gets made: the roster says who is
  // here, the plan says what the week will produce. The staff register is the
  // Roster page's own master — its tick carries its writes.
  { id: 'roster', path: '/roster', label: 'Staff Roster', slug: 'page.roster', tier: 'open', group: 'Planning' },
  { id: 'production-planning', path: '/production-planning', label: 'Production Planning', slug: 'page.production-planning', tier: 'open' },
  // The order is the order the work happens in. Quality Control gates everything a
  // batch produces, so it belongs beside the two stages that produce it.
  { id: 'production', path: '/production', label: 'Production', slug: 'page.production', tier: 'open', group: 'Production' },
  { id: 'quality', path: '/quality', label: 'Quality Control', slug: 'page.quality', tier: 'open' },
  { id: 'control-samples', path: '/control-samples', label: 'Control Samples', slug: 'page.control-samples', tier: 'open' },
  { id: 'packing', path: '/packing', label: 'Packing', slug: 'page.packing', tier: 'open', group: 'After production' },
  { id: 'orders', path: '/orders', label: 'Orders', slug: 'page.orders', tier: 'open' },
  { id: 'dispatch', path: '/dispatch', label: 'Dispatch', slug: 'page.dispatch', tier: 'open' },
  { id: 'inventory', path: '/inventory', label: 'Inventory', slug: 'page.inventory', tier: 'open', group: 'Stock' },
  { id: 'packing-materials', path: '/packing-materials', label: 'Packing Materials', slug: 'page.packing-materials', tier: 'open' },
  { id: 'stock-issues', path: '/stock-issues', label: 'Stock Issues', slug: 'page.stock-issues', tier: 'open' },
  { id: 'storage', path: '/storage', label: 'Storage', slug: 'page.storage', tier: 'open' },
  { id: 'stickers', path: '/stickers', label: 'Stickers', slug: 'page.stickers', tier: 'open' },
  { id: 'traceability', path: '/traceability', label: 'Traceability', slug: 'page.traceability', tier: 'open', group: 'Records' },
  { id: 'reports', path: '/reports', label: 'Lab Reports', slug: 'page.reports', tier: 'open' },
  { id: 'live-reports', path: '/reports/live', label: 'Live Reports', slug: 'page.live-reports', tier: 'open' },
  { id: 'audit', path: '/audit', label: 'Audit Log', slug: 'page.audit', tier: 'open' },
  // Masters — the screens that rewrite what everything else is measured against.
  // A "suppliers clerk" role is page.vendors and nothing else, and the tick
  // carries that page's master writes (see tables.ts).
  { id: 'vendors', path: '/vendors', label: 'Suppliers', slug: 'page.vendors', tier: 'masters' },
  { id: 'customers', path: '/customers', label: 'Customers', slug: 'page.customers', tier: 'masters' },
  { id: 'purchase-products', path: '/purchase-products', label: 'Products & Materials', slug: 'page.purchase-products', tier: 'masters' },
  { id: 'test-parameters', path: '/test-parameters', label: 'Test Parameters', slug: 'page.test-parameters', tier: 'masters' },
  // Settings and Administration are pages like any other: their screens are
  // their permission (page.settings carries the config keys, the admin pages
  // carry the user/role admin APIs), so an administrator is just a role with
  // them ticked.
  { id: 'settings', path: '/settings', label: 'Settings', slug: 'page.settings', tier: 'settings' },
  { id: 'admin-users', path: '/admin/users', label: 'Users', slug: 'page.admin-users', tier: 'admin' },
  { id: 'admin-roles', path: '/admin/roles', label: 'Roles & Permissions', slug: 'page.admin-roles', tier: 'admin' },
]

const BY_SLUG = new Map(PAGE_CATALOG.map((p) => [p.slug, p]))

export function pageSlug(id: ViewId): string | undefined {
  return PAGE_CATALOG.find((p) => p.id === id)?.slug
}

export function pageBySlug(slug: string): PageRow | undefined {
  return BY_SLUG.get(slug)
}

/** True for a permission slug this catalog knows — false for `page.nope` or anything else. */
export function isPageSlug(slug: string): boolean {
  return BY_SLUG.has(slug)
}

/**
 * The pages this caller is scoped to, or null when the default (the whole day's
 * work) applies. Holds any page slug ⇒ scoped to exactly those pages; a caller
 * whose roles tick no pages is an operator — the open tier, nothing else. A
 * full administrator is not a special case, just a role with every page ticked.
 */
export function pageScope(held: readonly string[]): ReadonlySet<ViewId> | null {
  const pages = PAGE_CATALOG.filter((p) => held.includes(p.slug))
  return pages.length ? new Set(pages.map((p) => p.id)) : null
}

/**
 * Every page this caller may see, in catalog order — the one rule Layout's nav,
 * Layout's off-path redirect and App's route gates all consume, so they cannot
 * disagree. Unscoped: the whole open tier (the operator). Scoped: exactly the
 * pages ticked on the caller's roles, any tier — Test Parameters is a masters
 * page a lab role ticks, Settings and Administration are pages an admin ticks.
 */
export function allowedPages(held: readonly string[]): readonly PageRow[] {
  const scope = pageScope(held)
  if (!scope) return PAGE_CATALOG.filter((p) => p.tier === 'open')
  return PAGE_CATALOG.filter((p) => scope.has(p.id))
}

/** Whether one page opens for this caller. */
export function canViewPage(held: readonly string[], id: ViewId): boolean {
  return allowedPages(held).some((p) => p.id === id)
}

/** Where a scoped caller lands — the first page they hold; null when they hold none. */
export function firstAllowedPath(held: readonly string[]): string | null {
  return allowedPages(held)[0]?.path ?? null
}
