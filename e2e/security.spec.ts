import { test, expect } from '@playwright/test'
import { getJson } from './helpers'

/**
 * HEAVY security duty (Phase 6) — the RBAC matrix by test, at the BFF, using
 * the dev session's per-request role header (x-dev-role: the Login page's own
 * picker — the harness's stand-in for a signed-in operator). Read-only probes;
 * the write-side refusals, the delivery-agent 404-never-403 privacy pairs and
 * the export injection guards are pinned by the service suites (B5c, B5a, H1
 * projection, exports.test) — cited in QA_REPORT §security.
 *
 * The app's real model (pages.ts / RBAC.md), which these probes pin:
 *   - A PAGELESS caller is the day worker: unscoped, they hold the whole open
 *     tier — every export (each gate carries the open-tier Live Reports page),
 *     every KPI module, the day's own collections — while the admin tier
 *     (/api/admin/*) still refuses them.
 *   - A SCOPED caller is clamped to exactly their pages, open tier included:
 *     the lab tester reads the QC surfaces and nothing else, and the snapshot
 *     itself is projected for them — masters contact fields are DROPPED from
 *     the payload (H1) and the read-gated collections are named in `withheld`.
 */
test.describe('BFF RBAC probes', () => {
  const as = (role: string) => ({ headers: { 'x-dev-role': role } })

  test('a pageless caller holds the open tier — the day’s work, not the admin one', async ({ request }) => {
    // The open tier answers: exports, KPIs, the snapshot with nothing withheld.
    const exports = await request.get('/api/exports/procurement-lots', as('Operator'))
    expect(exports.status()).toBe(200)
    const kpis = await request.get('/api/kpis/procurement', as('Operator'))
    expect(kpis.status()).toBe(200)

    const body = await getJson<{
      withheld?: string[]
      state?: { grns?: unknown[]; vendors?: { phone?: string }[] }
    }>(request, '/api/snapshot')
    expect(body.withheld, 'the open tier withholds nothing').toEqual([])
    expect((body.state?.grns ?? []).length, 'the day’s receipts ride the snapshot').toBeGreaterThan(0)

    // The admin tier is a wall, not a formality.
    const users = await request.get('/api/admin/users', as('Operator'))
    expect(users.status()).toBe(403)
    const roles = await request.get('/api/admin/roles', as('Operator'))
    expect(roles.status()).toBe(403)
  })

  test('the lab tester reads their own module and register — and the snapshot is projected for them', async ({
    request,
  }) => {
    // qc-records gates any-of [live-reports, quality] — the tester holds quality.
    const reg = await request.get('/api/exports/qc-records?from=2026-01-01&to=2026-12-31', as('QualityTester'))
    expect(reg.status()).toBe(200)
    const qc = await request.get('/api/kpis/qc', as('QualityTester'))
    expect(qc.status()).toBe(200)

    // Scoping clamps the open tier too: procurement is nobody-specified for them.
    const notTheirs = await request.get('/api/exports/procurement-lots', as('QualityTester'))
    expect(notTheirs.status()).toBe(403)

    // H1, end to end: masters contact fields are DROPPED (never masked in
    // place), and the collections they hold no page for are named in withheld.
    const body = await getJson<{
      withheld?: string[]
      state?: { vendors?: Record<string, unknown>[]; grns?: unknown[] }
    }>(request, '/api/snapshot', as('QualityTester').headers)
    const vendor = body.state?.vendors?.[0]
    expect(vendor, 'masters rows ride unmasked-except-contacts').toBeTruthy()
    expect(vendor?.phone).toBeUndefined()
    expect(vendor?.email).toBeUndefined()
    expect(body.withheld, 'the read-gated collections are named').toContain('grns')
    expect((body.state?.grns ?? []).length, 'a withheld collection arrives empty').toBe(0)
  })

  test('the NPD person is refused the KPI surface', async ({ request }) => {
    const kpis = await request.get('/api/kpis/procurement', as('Npd'))
    expect(kpis.status()).toBe(403)
    await getJson(request, '/api/snapshot') // their own snapshot still answers
  })

  test('an unknown KPI module 404s before any gating', async ({ request }) => {
    const res = await request.get('/api/kpis/not-a-module')
    expect(res.status()).toBe(404)
  })
})
