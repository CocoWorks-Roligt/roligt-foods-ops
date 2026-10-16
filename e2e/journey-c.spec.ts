import { test, expect } from '@playwright/test'
import { failOnPageErrors, dismissTour, getJson, pickOption, settleMirror } from './helpers'

/**
 * HEAVY Journey C (Phase 6) — loose BIB dispatch leaves packaging-material
 * stock untouched. The §3.3-9 carton decision (BOXED/LOOSE at dispatch, carton
 * deduction) has no master to ride on and was deferred — so the honest claim
 * under test is the one the system makes today: a BIB dispatch is LOOSE by
 * construction (B5a), consumes NO packaging material, and the carton-family
 * PM rows are byte-identical across the dispatch. When the carton master
 * lands, BOXED will be the journey that breaks this spec — by design.
 *
 *   pack 2 × 2.5 L Cold Brew BiBs (journey B's bulk) → PM position snapshot →
 *   order + dispatch the BiBs → PM position identical → board the trip →
 *   the trip's packaging reads LOOSE
 *
 * (The PM snapshot is taken AFTER packing: packing itself rightly draws
 * pouches — FG-0009's BOM is one PM-PP-0011 per pack — so the comparison
 * must start from the post-pack position, isolating what DISPATCH moves.)
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

  /** The PM position off the live snapshot: item → net qty (qty_in − qty_out).
   *  The API throttles snapshot GETs and a journey's own read can meet a 429
   *  (a protocol event, not a failure) — retry until one lands. */
  async function pmPosition(page: import('@playwright/test').Page): Promise<Record<string, number>> {
    const body = await getJson<{ state?: { ledger?: Record<string, unknown>[] } }>(
      page.request,
      '/api/snapshot',
    )
    const rows = body.state?.ledger ?? []
    const pos: Record<string, number> = {}
    for (const r of rows) {
      const item = String(r.item ?? '')
      if (!item.startsWith('PM-')) continue
      pos[item] = (pos[item] ?? 0) + (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0)
    }
    return pos
  }

  test('leg 1 — pack the remaining cold brew bulk into 2.5 L BiBs', async ({ page }) => {
    await page.goto('/production?stage=pack')
    await dismissTour(page)

    // The drink's plain name — the "(bulk)" suffix is stripped at load — and
    // its own arithmetic: the blend posted 29, spoilage kept 1, journey B
    // bottled 23 → 5 L left. Pinned so the dump-era 0.1 L lot can't win.
    await pickOption(page.getByLabel(/^Filling from/), /^Cold Brew Coffee/)
    await pickOption(page.getByRole('combobox', { name: /^Batch lot/ }), /5 L on hand/)

    // The pack options are pack labels; two products share a label only
    // within one bulk, and this bulk's are all distinct — no "· drink"
    // suffix, so anchor the label exactly.
    await pickOption(page.getByRole('combobox', { name: /^Pack/ }), /^2\.5 L BiB$/)
    await page.getByLabel(/^Packs filled/).fill('2')

    await pickOption(page.getByLabel('Storage area'), /Cold Room A/i)
    await page.getByRole('button', { name: 'Post packing run' }).click()
    await expect(page.getByText(/— the packs carry the bulk/i)).toBeVisible()
  })

  test('leg 2 — order and dispatch the two BiBs, PM stock untouched', async ({ page }) => {
    // Two writes and two mid-leg settles: a settle can wait out the commit
    // throttle's whole window, so this leg outlives the default budget.
    test.setTimeout(240_000)
    // BEFORE: the post-pack PM position, cartons included.
    const before = await pmPosition(page)
    expect(typeof before['PM-PP-0017'], 'the 5 L carton row exists in the position').toBe('number')

    // The order: two loose BiBs for a third customer.
    await page.goto('/orders?tab=desk')
    await dismissTour(page)
    await page.getByRole('button', { name: '+ Raise an order' }).click()
    await pickOption(
      page.locator('.field').filter({ hasText: /^Customer/ }).getByRole('combobox'),
      /Event BTL/,
    )
    await page.locator('.field').filter({ hasText: /^Ship by/ }).locator('input').fill('2026-10-17')
    // Both cold brews sit in the drink list, but the desk's drink is the
    // blend's bulk, "Cold Brew Coffee" (the legacy "(bulk)" suffix is
    // stripped at load). Its 2.5 L product is named for the drink itself and
    // reads "Cold Brew Coffee · BiB" in the desk's pack picker.
    await pickOption(page.getByRole('combobox', { name: 'Add drink' }), /^Cold Brew Coffee/)
    await pickOption(page.getByRole('combobox', { name: /Add pack for Cold/ }), /^Cold Brew Coffee · BiB$/)
    await page.getByPlaceholder('Units').first().fill('2')
    await page.getByRole('button', { name: 'Raise order', exact: true }).click()
    await expect(page.getByText('Order raised.')).toBeVisible()
    await settleMirror(page)

    // The dispatch itself.
    await page.goto('/orders?tab=dispatch')
    await dismissTour(page)
    await pickOption(page.getByRole('combobox', { name: /^Order/ }), /Event BTL/)
    await page.getByPlaceholder('Registration or transporter').fill('TS 09 AA 1234')
    const send = page.locator('button.btn-primary').filter({ hasText: /^Dispatch ORD/ })
    ledger.orderId = (/Dispatch (ORD-[\d-]+)/.exec((await send.textContent()) ?? '') ?? [])[1] ?? ''
    expect(ledger.orderId, 'the dispatch button names its order').toMatch(/ORD-\d+-\d+/)
    await send.click()
    await expect(page.getByText(/No open orders/i)).toBeVisible()
    await settleMirror(page)

    // AFTER: identical to the byte — a loose dispatch moves no packaging.
    const after = await pmPosition(page)
    expect(after).toEqual(before)
  })

  test('leg 3 — board the trip; its packaging reads LOOSE', async ({ page }) => {
    await page.goto('/shipments')
    await dismissTour(page)

    await page.getByRole('button', { name: 'New trip' }).click()
    const modal = page.locator('.modal-box')
    expect(ledger.orderId, 'leg 2 captured the order id').toMatch(/ORD-\d+/)
    await pickOption(modal.getByLabel(/^Order/), new RegExp(ledger.orderId))
    const rowsToBoard = modal.locator('label.check-row')
    await expect(rowsToBoard.first()).toBeVisible()
    for (let i = 0; i < await rowsToBoard.count(); i++) await rowsToBoard.nth(i).click()
    await modal.getByLabel(/^Agent \(email\)/).fill('dev@roligt.local')
    await modal.getByRole('button', { name: 'Create trip' }).click()
    await expect(modal).toBeHidden()

    const row = page.locator('tr', { hasText: 'Event BTL' })
    await expect(row).toBeVisible({ timeout: 30_000 })

    // The wire's own word, not the board's rendering of it: B5a's rule is
    // packaging reads LOOSE until dispatch_v2 stamps per-line decisions.
    // The list wire is ShipmentDetail[] — the trip itself nests under
    // .shipment (lines and challan links ride beside it).
    const body = await getJson<{
      shipments?: { shipment: { id: string; orderId?: string; packaging?: string } }[]
    }>(page.request, '/api/shipments')
    const trip = body.shipments?.find((s) => s.shipment.orderId === ledger.orderId)
    expect(trip, `a trip for ${ledger.orderId}`).toBeTruthy()
    ledger.tripId = trip!.shipment.id
    expect(trip!.shipment.packaging).toBe('LOOSE')
  })
})
