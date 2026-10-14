import type { Page } from '@playwright/test'

/**
 * Shared journey helpers. The harness runs the designed local shape: dev
 * sessions (no WorkOS), so a fresh browser is ALREADY signed in as Admin —
 * there is no Login step. What a fresh context DOES get is W16's first-run
 * tour (device-local, once per context), so every spec closes it via Esc
 * (boot.spec additionally asserts it offered itself).
 */

/** Fails the test on uncaught page errors. Two console errors are by design,
 * not defects: /api/events 404 (the node harness serves no SSE; the client's
 * designed fallback is the /api/revision poll — exactly what the journey
 * exercises) and 429s from the commit/snapshot throttles (Retry-After flow
 * control — the device keeps the change local and the next poll retries it,
 * so a journey's quick legs are EXPECTED to be throttled sometimes). */
export function failOnPageErrors(page: Page, errors: string[]) {
  page.on('pageerror', (err) => errors.push(`pageerror: ${err}`))
  page.on('console', (msg) => {
    const text = msg.text()
    // 429 is the commit throttle the client queues behind, 409 its CAS
    // conflict path (refused whole, winners adopted, re-saved) — both are
    // protocol events the sync engine owns, though the browser still logs
    // the failed fetch itself. Everything else is the page failing.
    if (
      msg.type() === 'error' &&
      !text.includes('/api/events') &&
      !text.includes('429') &&
      !text.includes('409 (Conflict)')
    ) {
      errors.push(text)
    }
  })
}

/** Closes the first-run tour if it offered itself (Esc is the tour's own end). */
export async function dismissTour(page: Page) {
  const tour = page.locator('.tour-card[role="dialog"]').first()
  if (await tour.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
  }
}

/** Waits for the snapshot to land and the app to settle (skeletons gone). */
export async function appReady(page: Page) {
  await page.waitForLoadState('networkidle')
}
