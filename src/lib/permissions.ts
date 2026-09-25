/**
 * The permission catalog — this fork's whole authorization vocabulary.
 *
 * Roles live in WorkOS and admins compose them out of these slugs at runtime;
 * the BFF's commit gate, the SPA's route guards and the seeded roles all read
 * this one list, so a slug can never mean one thing on the server and another
 * in the UI. Slugs are immutable once shipped (WorkOS refuses renames) and
 * deliberately few: all of them ride inside the sealed session cookie, and a
 * cookie is capped around 4 KB — the size test below is that constraint.
 *
 * Every slug is a page (`page.<id>`), derived from src/lib/pages.ts — there is
 * no separate "manage" vocabulary. A tick opens the page and carries the page's
 * writes; see pages.ts for the narrowing rule.
 *
 * Like the other isomorphic libs this module is compiled by both tsconfig
 * projects, so the .ts extension on imports and no browser globals.
 */
import type { Role } from '../types.ts'
import { PAGE_CATALOG, pageBySlug } from './pages.ts'

/** Every page slug, in catalog (sidebar) order — the whole catalog, nothing else. */
export const PERMISSIONS = PAGE_CATALOG.map((p) => p.slug) as readonly string[]

/**
 * The Administration pages — a role carrying either of them can administer the
 * app, and the last-admin guards key on these slugs: some role must always keep
 * each one, or nobody could ever grant it back from the inside.
 */
export const ADMIN_PAGE_SLUGS = PAGE_CATALOG.filter((p) => p.tier === 'admin').map(
  (p) => p.slug,
) as readonly PermissionKey[]

export type PermissionKey = (typeof PAGE_CATALOG)[number]['slug']

/**
 * The label for any catalog slug — the page's own ("The Quality Control page").
 * Shown in the Roles editor and the audit trail; the seed script sends the same
 * text to WorkOS so the dashboard's permission list reads identically to ours.
 */
export function permissionLabel(slug: string): string {
  return `The ${pageBySlug(slug)?.label ?? slug} page`
}

/**
 * True when the caller holds any one of the needed permissions. No needed
 * permissions means yes — an unchecked action is open to every signed-in
 * caller, which is exactly the "the day's work" tier.
 */
export function canAny(held: readonly string[], ...needed: PermissionKey[]): boolean {
  return needed.length === 0 || needed.some((p) => held.includes(p))
}

/**
 * Today's Admin, derived: a caller is an admin exactly when they hold the whole
 * catalog. A partial-permission caller is an operator with extra reach — this
 * is the byte-for-byte equivalent of the Admin/Operator split it replaces.
 */
export function isAdminPermissions(held: readonly string[]): boolean {
  return PERMISSIONS.every((p) => held.includes(p))
}

/** The dev session's picker roles, spelled in permissions. */
export function devPermissions(devRole: Role): PermissionKey[] {
  if (devRole === 'Admin') return [...PERMISSIONS] as PermissionKey[]
  if (devRole === 'QualityTester') {
    // the lab tester's app: the four quality pages, and nothing else to tap through
    return ['page.quality', 'page.control-samples', 'page.reports', 'page.test-parameters']
  }
  return []
}

/**
 * Write gates for the tables that are not collections: the config row is the
 * Settings page's own (page.settings), and the audit trail is insert-only for
 * callers without the Audit page (sync.ts only ever emits audit removals from
 * admin-side edits).
 */
export const TABLE_WRITE_PERMISSION = {
  app_config: 'page.settings',
  audits: 'page.audit',
} as const satisfies Record<string, PermissionKey>

/**
 * Config is stored as one row, so a table-level gate cannot tell a report-type
 * edit from a numbering change. The commit path diffs the incoming config
 * against the stored one key by key and gates each key that actually changed;
 * a key listed here passes on any one of its permissions, everyone else's keys
 * need TABLE_WRITE_PERMISSION.app_config. Unchanged keys pass whoever the
 * caller is — a whole-object payload (what sync sends) must not read as a
 * write to every key it carries.
 *
 * The two listed keys are the ones a page tick owns outright: the lab's report
 * types (page.test-parameters) and the storage areas the Storage page maintains
 * (page.storage). A ticked page carries its page's writes.
 */
export const CONFIG_KEY_WRITE_PERMISSION = {
  testCategories: ['page.test-parameters'],
  defaultAreas: ['page.storage'],
} as const satisfies Record<string, readonly PermissionKey[]>
