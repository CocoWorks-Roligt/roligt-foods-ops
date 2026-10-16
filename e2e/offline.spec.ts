import { test, expect } from '@playwright/test'
import { failOnPageErrors, dismissTour, getJson } from './helpers'

/**
 * HEAVY negative duty (Phase 6) — offline sync replay, on journey B's trip
 * (Naga Chaitanya, 8 glass bottles): the whole delivery round is run with the
 * network CUT, parks in the PWA's intent outbox under the Idempotency-Key it
 * was BORN with, and replays exactly once when the network returns.
 *
 *   offline → Start delivery (parked) → confirm + ink + submit (parked) →
 *   the chip counts what waits → online → the flush lands both intents →
 *   the server sees ONE started walk and ONE idempotent submit → Delivered
 */
test.describe.serial(() => {
  const errors: string[] = []

  test.beforeEach(async ({ page }) => {
    failOnPageErrors(page, errors)
    await page.addInitScript(() => localStorage.setItem('roligt_tour_done_v1', '1'))
  })

  test.afterAll(async () => {
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('the round runs offline and replays once online', async ({ page }) => {
    // Online first: the device cache loads the trip list while it can.
    await page.goto('/my-deliveries')
    await dismissTour(page)
    const card = page.locator('button.trip-card', { hasText: 'Naga Chaitanya' })
    await expect(card).toBeVisible()
    await card.click()

    // Cut the network — the round is now entirely device-local.
    await page.context().setOffline(true)

    await page.getByRole('button', { name: 'Start delivery' }).click()

    // The round view runs on the PARKED started intent alone: the server was
    // never told (it is offline), so the header still carries the server's
    // own status, Created — while the confirm flow below opens anyway. (The
    // "waits to sync" banner is the LIST view's copy; the round's offline
    // words come after submit.)
    await expect(page.getByText(/TS 09 AA 1234 · Created/)).toBeVisible({ timeout: 15_000 })

    // The confirm flow is reachable on the strength of the PARKED started
    // intent alone (startedPending) — no server round-trip happened.
    const line = page.locator('.line-confirm').first()
    await expect(line).toBeVisible({ timeout: 15_000 })

    // All-delivered is the draft's default; the ink is local bytes.
    const pad = page.getByRole('img', { name: /Customer signature/ })
    const box = (await pad.boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 90)
    await page.mouse.down()
    await page.mouse.move(box.x + 180, box.y + 50, { steps: 10 })
    await page.mouse.move(box.x + 320, box.y + 120, { steps: 10 })
    await page.mouse.up()
    await expect(pad).toHaveAccessibleName(/signed/)
    await page.getByLabel(/^Printed name/).fill('Naga Chaitanya Jr')
    await page.getByLabel(/^Phone/).fill('9876543212')

    await page.getByRole('button', { name: 'Submit delivery' }).click()
    // Offline, the round's own copy says where the record sits; online it
    // says the office has it. Either way the submit held.
    await expect(page.getByText(/Delivery recorded|Recorded on this device/i)).toBeVisible({
      timeout: 15_000,
    })

    // Both intents sit in the outbox — nothing left the device.
    const parked = await page.evaluate(() => JSON.parse(localStorage.getItem('delivery-outbox-v1') ?? '[]'))
    expect(parked.length, 'both intents parked').toBe(2)

    // Back online: the flush walks the started intent first, then the submit —
    // each under its born key, so the server sees each exactly once.
    await page.context().setOffline(false)
    await expect
      .poll(
        () =>
          page.evaluate(() => JSON.parse(localStorage.getItem('delivery-outbox-v1') ?? '[]').length),
        { timeout: 30_000 },
      )
      .toBe(0)

    // The server's truth: the trip is Delivered (one submit, one outcome).
    // The outbox emptying only means the flush POPPED the intents — the
    // submit's POST can still be in flight — so poll the wire until the NAGA
    // trip (the customer names it; journey A's Fernandez trip is Delivered
    // from its own leg) carries the verdict.
    await expect
      .poll(
        async () => {
          const body = await getJson<{
            shipments?: { shipment: { status: string; stops?: { customerName?: string }[] } }[]
          }>(page.request, '/api/shipments')
          return (
            body.shipments?.find((s) => s.shipment.stops?.[0]?.customerName === 'Naga Chaitanya')
              ?.shipment.status ?? 'pending'
          )
        },
        { timeout: 30_000 },
      )
      .toBe('Delivered')
  })
})
