import type { Page } from '@playwright/test'

/**
 * Shared journey helpers. The harness runs the designed local shape: dev
 * sessions (no WorkOS), so a fresh browser is ALREADY signed in as Admin —
 * there is no Login step. What a fresh context DOES get is W16's first-run
 * tour (device-local, once per context), so every spec closes it via Esc
 * (boot.spec additionally asserts it offered itself).
 */

/** Fails the test on uncaught page errors; /api/events 404 is by design
 * (the node harness serves no SSE; the client's designed fallback is the
 * /api/revision poll — exactly what the journey exercises). */
export function failOnPageErrors(page: Page, errors: string[]) {
  page.on('pageerror', (err) => errors.push(`pageerror: ${err}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('/api/events')) {
      errors.push(msg.text())
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
