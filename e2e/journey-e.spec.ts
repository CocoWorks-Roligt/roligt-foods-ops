import { test, expect } from '@playwright/test'
import { failOnPageErrors, dismissTour, getJson, settleMirror } from './helpers'

/**
 * HEAVY Journey E (Phase 6) — the delivery return, end to end, on journey C's
 * trip (Event BTL, 2 × 2.5 L Cold Brew BiBs, packaging LOOSE):
 *
 *   the agent delivers 1 and rejects 1 (a reason in its own words) →
 *   Partially Delivered + ONE Open Return record → the board reads both →
 *   QC's decision (the returns API — no decision UI exists yet, an honest
 *   gap this journey records) puts the stock back at the cold room →
 *   the ledger carries the Return line, the record closes →
 *   the challan's PDF link is a presigned, EXPIRING URL
 */
test.describe.serial(() => {
  const ledger: Record<string, string> = {}
  const errors: string[] = []

  test.beforeEach(async ({ page }) => {
    failOnPageErrors(page, errors)
    await page.addInitScript(() => localStorage.setItem('roligt_tour_done_v1', '1'))
  })

  test.afterEach(async ({ page }, info) => {
    if (info.failed) return
    await settleMirror(page)
  })

  test.afterAll(async () => {
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('leg 1 — the agent delivers one and rejects one, with ink', async ({ page }) => {
    await page.goto('/my-deliveries')
    await dismissTour(page)

    const card = page.locator('button.trip-card', { hasText: 'Event BTL' })
    await expect(card).toBeVisible()
    await card.click()

    await page.getByRole('button', { name: 'Start delivery' }).click()
    const line = page.locator('.line-confirm').first()
    await expect(line).toBeVisible({ timeout: 30_000 })

    // One of the two goes out; one comes back with a reason in its own words.
    await page.getByLabel(/^Delivered/).fill('1')
    await page.getByLabel(/Rejected \/ damaged/).fill('1')
    await page.getByLabel(/^Why it came back/).fill('Pouch punctured in transit')

    const pad = page.getByRole('img', { name: /Customer signature/ })
    const box = (await pad.boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 90)
    await page.mouse.down()
    await page.mouse.move(box.x + 180, box.y + 50, { steps: 10 })
    await page.mouse.move(box.x + 320, box.y + 120, { steps: 10 })
    await page.mouse.up()
    await expect(pad).toHaveAccessibleName(/signed/)

    await page.getByLabel(/^Printed name/).fill('BTL Manager')
    await page.getByLabel(/^Phone/).fill('9876543211')
    await page.getByRole('button', { name: 'Submit delivery' }).click()

    // Partial arithmetic → Partially Delivered, and the office hears about it.
    await expect(page.getByText(/Delivery recorded/i)).toBeVisible({ timeout: 30_000 })
  })

  test('leg 2 — the board reads Partially Delivered, with its challan', async ({ page }) => {
    await page.goto('/shipments')
    await dismissTour(page)

    const row = page.locator('tr', { hasText: 'Event BTL' })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Partially Delivered')

    // The drawer carries the verdict and the delivery challan — but NOT the
    // open return: the board has no return surface yet (the honest gap this
    // journey records; leg 3 reads the record off the returns API instead).
    await row.locator('td').first().click()
    const drawer = page.locator('.modal-box')
    await expect(drawer).toContainText('Partially Delivered')
    await expect(drawer).toContainText(/DC\d+\/\d+/)
  })

  test('leg 3 — QC sends the returned pouch back to the cold room', async ({ page }) => {
    // The leg is all API reads, but the page still boots: the afterEach
    // settle reads the app's own mirror state, which a never-navigated page
    // does not have (dirty undefined ≠ false, forever).
    await page.goto('/shipments')
    await dismissTour(page)
    // The returns surface is write-only today — no list route, no snapshot
    // key, no UI (the honest gap this journey records). The one readable
    // trail of the record is the dispatch it came home on: the submit stamps
    // "Return RET-…" into the dispatch's deliveryNote, and dispatches ride
    // the snapshot.
    const body = await getJson<{
      state?: { dispatches?: { deliveryNote?: string }[] }
    }>(page.request, '/api/snapshot')
    const note =
      (body.state?.dispatches ?? []).find((d) => /Return RET-/.test(d.deliveryNote ?? ''))
        ?.deliveryNote ?? ''
    const record = (/Return (RET-[\w-]+)/.exec(note))?.[1] ?? ''
    expect(record, 'the rejection stamped its return id into the dispatch').toMatch(/^RET-/)
    ledger.returnId = record

    // Every POST on the API carries an Idempotency-Key — the decision is
    // no exception (the client's own calls always send one).
    const cut = await page.request.post(`/api/returns/${record}/decision`, {
      headers: { 'Idempotency-Key': `e2e-return-decision-${record}` },
      data: { decision: 'coldroom', note: 'E2E: pouch intact, back to stock' },
    })
    expect(cut.status()).toBe(200)

    // Closed is the decision route's own answer — the record itself is
    // write-only, so its status is read nowhere else (a second verdict 409s).
    expect((await cut.json()).record.status).toMatch(/closed/i)

    // The decision's own arithmetic: ONE Return ledger line, Released, at a
    // cold room — read straight off the snapshot the Inventory page rides.
    const snap = await getJson<{ state?: { ledger?: Record<string, unknown>[] } }>(page.request, '/api/snapshot')
    const state = snap.state
    const lines = (state?.ledger ?? []).filter(
      (l) => l.type === 'Return' && l.doc === record,
    )
    expect(lines.length, 'one Return line for the record').toBe(1)
    expect(String(lines[0].status)).toBe('Released')
    expect(String(lines[0].location)).toMatch(/cold/i)
  })

  test('leg 4 — the challan answers on an expiring, signed URL', async ({ page }) => {
    await page.goto('/shipments')
    await dismissTour(page)

    const row = page.locator('tr', { hasText: 'Event BTL' })
    await expect(row).toContainText('Partially Delivered')
    const link = row.locator('a.challan-link')
    await expect(link).toContainText(/DC\d+/)

    // Not following the 302: the presign itself is the claim — a Signature,
    // and an Expires bounded to the engine's 10-minute window.
    const href = (await link.getAttribute('href'))!
    const res = await page.request.get(href, { maxRedirects: 0 })
    expect(res.status()).toBe(302)
    const location = res.headers()['location'] ?? ''
    expect(location, 'presigned location').toContain('X-Amz-Signature=')
    const expires = Number(/X-Amz-Expires=(\d+)/.exec(location)?.[1] ?? 0)
    expect(expires).toBeGreaterThan(0)
    expect(expires).toBeLessThanOrEqual(600)
  })
})
