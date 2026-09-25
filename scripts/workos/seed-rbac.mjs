#!/usr/bin/env node
/**
 * Seed WorkOS RBAC from the app's permission catalog — idempotent.
 *
 * Run with:  npx tsx scripts/workos/seed-rbac.mjs
 *
 * Creates (when missing): the "Roligt Foods" organization, every permission
 * slug in src/lib/permissions.ts, and the seeded app-admin role (the whole
 * catalog). Existing things are left alone unless they disagree with the
 * catalog, in which case the role's permission set is reconciled. Safe to
 * re-run after every catalog change; it prints what it did and, on a fresh
 * org, the WORKOS_ORG_ID to paste into .env.
 *
 * This is a script rather than an endpoint on purpose: bootstrapping the
 * permission to grant permissions through the API itself is a chicken-and-egg
 * no administrator can escape. The first admin user is created once in the
 * WorkOS dashboard; everything after runs from the app.
 */
import { PERMISSIONS, permissionLabel } from '../../src/lib/permissions.ts'
import { WorkOS } from '@workos-inc/node'

const ORG_NAME = 'Roligt Foods'
// slug `admin` is WorkOS's own system role — the app's roles must not collide
// with it (slugs are unique, and reconciling by slug would overwrite the
// system role's permissions). `app-admin` is the only seeded bundle; there is
// deliberately no seeded "operator" role — a user holding no roles at all is
// an operator (the day's work only).
const SEED_ROLES = {
  'app-admin': {
    name: 'App Admin',
    description: 'Administrator — every permission in the catalog',
    permissions: [...PERMISSIONS],
  },
}

const log = (msg) => console.log(`[seed-rbac] ${msg}`)

async function main() {
  const apiKey = process.env.WORKOS_API_KEY
  const clientId = process.env.WORKOS_CLIENT_ID
  if (!apiKey || !clientId) {
    console.error('[seed-rbac] WORKOS_API_KEY and WORKOS_CLIENT_ID must be set (see .env.example).')
    process.exit(1)
  }
  const apiHostname = process.env.WORKOS_API_HOSTNAME || 'api.eu.workos.com'
  const workos = new WorkOS(apiKey, { clientId, apiHostname, maxRetries: 2 })

  // ── 1. Organization ────────────────────────────────────────────────────────
  let orgId = process.env.WORKOS_ORG_ID || ''
  if (orgId) {
    log(`using WORKOS_ORG_ID ${orgId}`)
  } else {
    const orgs = await workos.organizations.listOrganizations()
    const all = 'autoPagination' in orgs ? await orgs.autoPagination() : orgs.data
    const found = all.find((o) => o.name === ORG_NAME)
    if (found) {
      orgId = found.id
      log(`found existing organization "${ORG_NAME}" (${orgId})`)
    } else {
      const created = await workos.organizations.createOrganization({ name: ORG_NAME, domains: [] })
      orgId = created.id
      log(`created organization "${ORG_NAME}" (${orgId})`)
    }
    console.log('')
    console.log(`  Add to .env:  WORKOS_ORG_ID=${orgId}`)
    console.log('')
  }

  // ── 2. Permissions ─────────────────────────────────────────────────────────
  const existingPerms = await workos.authorization.listPermissions()
  const allPerms = 'autoPagination' in existingPerms ? await existingPerms.autoPagination() : existingPerms.data
  const known = new Set(allPerms.map((p) => p.slug))
  for (const slug of PERMISSIONS) {
    if (known.has(slug)) {
      log(`permission ${slug} exists`)
      continue
    }
    await workos.authorization.createPermission({ slug, name: permissionLabel(slug) })
    log(`created permission ${slug} — ${permissionLabel(slug)}`)
  }

  // ── 3. Roles ───────────────────────────────────────────────────────────────
  const roles = await workos.authorization.listEnvironmentRoles()
  const bySlug = new Map(roles.data.map((r) => [r.slug, r]))
  for (const [slug, seed] of Object.entries(SEED_ROLES)) {
    const wanted = seed.permissions
    if (!bySlug.has(slug)) {
      await workos.authorization.createEnvironmentRole({ slug, name: seed.name, description: seed.description })
      await workos.authorization.setEnvironmentRolePermissions(slug, { permissions: wanted })
      log(`created role ${slug} (${wanted.length} permission${wanted.length === 1 ? '' : 's'})`)
      continue
    }
    const held = bySlug.get(slug).permissions
    const same =
      held.length === wanted.length && [...held].sort().every((p, i) => p === [...wanted].sort()[i])
    if (same) {
      log(`role ${slug} already holds exactly the seeded permissions`)
    } else {
      await workos.authorization.setEnvironmentRolePermissions(slug, { permissions: wanted })
      log(`reconciled role ${slug}: ${held.join(', ') || 'none'} → ${wanted.join(', ') || 'none'}`)
    }
  }

  // ── 4. Slug migrations ─────────────────────────────────────────────────────
  // 2026-09-25: the four `quality.*` slugs and then the five `*.manage` slugs
  // became `page.*` ticks (pages are the whole vocabulary now). Both were
  // migrated and deleted from WorkOS the same day, before any production
  // environment existed — nothing left to do here. A future slug migration
  // goes in this slot: union the mapped slugs into every role still holding
  // the old ones (re-listing roles fresh so a reconcile above can't be undone).

  log('done.')
}

main().catch((e) => {
  console.error(`[seed-rbac] failed: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
