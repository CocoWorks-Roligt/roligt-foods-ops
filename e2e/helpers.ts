import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

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
    // A failed resource load logs "Failed to load resource: …" with NO url in
    // the text — the url rides msg.location(). Exclude the SSE 404 by either
    // (so the exclusion stays narrow: a 404 anywhere else still fails, which
    // is exactly how the missing /api/shipments route was caught).
    const where = msg.location()?.url ?? ''
    // 429 is the commit throttle the client queues behind, 409 its CAS
    // conflict path (refused whole, winners adopted, re-saved), and 422 is
    // the rules gate refusing a write — all three are protocol events the
    // sync engine owns, though the browser still logs the failed fetch
    // itself (journey-d's refusal leg asserts the 422's audit trail itself).
    // ERR_INTERNET_DISCONNECTED is the offline
    // spec's own doing: it cuts the network on purpose, and every in-flight
    // fetch logs it — the test's condition, not the page failing. Everything
    // else is the page failing.
    if (
      msg.type() === 'error' &&
      !text.includes('/api/events') &&
      !where.includes('/api/events') &&
      !text.includes('429') &&
      !text.includes('409 (Conflict)') &&
      !text.includes('422') &&
      !text.includes('net::ERR_INTERNET_DISCONNECTED')
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

/**
 * Picks the option whose visible text matches, in EITHER control the app
 * uses: a native <select> (the PO form) or the hand-rolled listbox
 * (components/Select — button + portaled role=option divs; keyboard-first,
 * so a click opens and an option click picks). Returns the picked text —
 * the journey reads ids back out of it. (Shared from journey-a at Phase 6;
 * the re-click recovery handles a snapshot landing between click and
 * dispatch dropping the click on a node React has since replaced.)
 */
export async function pickOption(control: Locator, matcher: RegExp | string): Promise<string> {
  const isNative = await control
    .evaluate((el) => el instanceof HTMLSelectElement)
    .catch(() => false)
  if (isNative) {
    const label = await control.evaluate((el: HTMLSelectElement, src) => {
      const re = new RegExp(src, 'i')
      const opt = Array.from(el.options).find((o) => re.test(o.textContent ?? ''))
      return opt?.textContent ?? ''
    }, matcher instanceof RegExp ? matcher.source : String(matcher))
    expect(label, `no option matching ${matcher}`).not.toBe('')
    await control.selectOption({ label })
    return label
  }
  await control.click()
  const option = control.page().getByRole('option', { name: matcher }).first()
  await option.waitFor({ state: 'visible', timeout: 3_000 }).catch(async () => {
    const anyOpen = await control.page().getByRole('option').first().isVisible().catch(() => false)
    if (!anyOpen) await control.click()
    await option.waitFor({ state: 'visible' })
  })
  const text = (await option.textContent()) ?? ''
  await option.click()
  return text
}

/**
 * A leg's writes must reach the server before its context closes. The save is
 * debounced, and the next leg boots a FRESH context — none of this tab's
 * localStorage — so an un-flushed save would simply vanish between legs. The
 * app's own contract is the mirror: dirty work sits in a per-tab spill key,
 * and a tab is saved only when no spill remains. The plant's commit budget
 * (8/min sustained) means a busy stretch queues behind the throttle for a
 * while — the poll lets that drain (150s: a leg's burst at the end of a long
 * journey chain can sit behind more than a minute of window).
 */
export async function settleMirror(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              if (k && k.startsWith('roligt_foods_ops_v1:t:')) return true // a spill = unsaved work
            }
            return JSON.parse(localStorage.getItem('roligt_foods_ops_v1') ?? '{}').dirty !== false
          } catch {
            return true
          }
        }),
      { timeout: 150_000 },
    )
    .toBe(false)
}

/** A mid-journey API read. GETs share the throttle with commits, so a read
 *  can meet a 429 (a protocol event, not a failure) — retry until one lands.
 *  Any other status surfaces immediately; assertions keep their meaning.
 *  Takes the request context directly (a page's `page.request`, or the
 *  `request` fixture where a probe has no page at all). */
export async function getJson<T>(
  request: APIRequestContext,
  path: string,
  headers?: Record<string, string>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await request.get(path, headers ? { headers } : undefined)
    if (res.status() === 200) return (await res.json()) as T
    if (res.status() !== 429 || attempt >= 20) throw new Error(`${path} → ${res.status()}`)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
}
