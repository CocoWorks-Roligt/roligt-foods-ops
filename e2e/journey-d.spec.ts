import { test, expect, type Page } from '@playwright/test'
import { failOnPageErrors, dismissTour, getJson, pickOption, settleMirror } from './helpers'

/**
 * HEAVY Journey D (Phase 6) — the QC hard gate, end to end, under
 * E2E_FLAGS=qc_gate_v2 (this spec SKIPS itself in a default-flags run: its
 * refusal leg only exists with the gate on, and its pass legs must prove the
 * gate lets honest work through — so it runs as its own playwright invocation
 * on the fresh DB the flags env builds):
 *
 *   coconut PO → staged receipt → grading → extraction (close) →
 *   a blend drawing the still-QUARANTINE water is REFUSED BY THE SERVER —
 *     the client's own rules still allow the draw (classic DRAWABLE), the
 *     commit 422s, and the refused write is left stuck-dirty on the device
 *     (the offline retry loop cannot tell a refusal from an outage — a
 *     ROLLOUT gate recorded in QA_REPORT) →
 *   the lab RELEASES the water (the malai never sits on the QC page — it is
 *     qcExempt, released as booked) →
 *   pack the now-Released water → the packs carry the verdict →
 *   order → dispatch sails through the new arm on Released packs →
 *   No open orders
 *
 * The gate's OTHER refusal arms stay unit-pinned in rulesGate.test.ts: a
 * packing draw of non-Released bulk 422s the same way (observed on this
 * journey's own iterations — the plant's own flow can no longer stage one,
 * because the packs inherit the verdict), and a dispatch draw of non-Released
 * packs is unreachable for the same reason (the dispatch tab pools Released
 * packs only, so its button dies client-side before the server is asked).
 */
test.describe.serial(() => {
  test.skip(
    !process.env.E2E_FLAGS?.includes('qc_gate_v2'),
    'journey-d runs only with E2E_FLAGS=qc_gate_v2 (its own fresh-DB invocation)',
  )

  const ledger: Record<string, string> = {}
  const errors: string[] = []
  // The refusal leg's write never settles — by design. It opts out of the
  // settle guard (settleMirror would wait out its 90 s and fail the leg).
  let settleExempt = false

  test.beforeEach(async ({ page }) => {
    failOnPageErrors(page, errors)
    await page.addInitScript(() => localStorage.setItem('roligt_tour_done_v1', '1'))
  })

  test.afterEach(async ({ page }, info) => {
    if (info.failed || settleExempt) {
      settleExempt = false
      return
    }
    await settleMirror(page)
  })

  test.afterAll(async () => {
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('leg 1 — raise a coconut PO and acknowledge it', async ({ page }) => {
    await page.goto('/procurement?tab=orders')
    await dismissTour(page)

    await page.getByRole('button', { name: '+ Raise a purchase order' }).click()
    const form = page.locator('.card').filter({ hasText: 'Supplier' })

    await form.getByLabel(/^Supplier/).selectOption({ label: 'Kanaka Durga Rao' })
    await form.getByLabel(/^Material/).first().fill('Tender Coconut')
    await form.getByLabel(/^Qty/).fill('500')
    await form.getByLabel(/^Unit/).fill('Piece')
    await form.getByLabel(/^Rate/).fill('22')

    await form.getByRole('button', { name: 'Raise draft' }).click()
    await expect(page.getByText(/PO-\d+ raised/).or(page.getByText(/raised as a draft/))).toBeVisible()

    const card = page
      .locator('.card')
      .filter({ has: page.getByRole('button', { name: /Mark/ }) })
      .last()
    await expect(card).toBeVisible()
    ledger.po = (await card.locator('h3').textContent()) ?? ''
    await card.getByRole('button', { name: /Mark Sent/i }).click()
    await expect(card.getByRole('button', { name: /Mark Acknowledged/i })).toBeVisible()
    await card.getByRole('button', { name: /Mark Acknowledged/i }).click()
    // Wait for the STATE, not the word (journey-a leg 1's own lesson).
    await expect(card.getByRole('button', { name: /Mark Acknowledged/i })).toBeHidden()
    await expect(card.getByRole('button', { name: /Mark Received/i })).toBeVisible()
  })

  test('leg 2 — receive the load staged, linked to the PO', async ({ page }) => {
    await page.goto('/procurement?tab=receive')
    await dismissTour(page)

    await pickOption(page.getByLabel(/^Order/), /^PO-\d+ · Kanaka/)
    await page.getByRole('button', { name: 'Receive this' }).click()

    await page.getByText('Grade later — the lot is held until the Grading stage sorts it').click()
    await expect(page.getByText(/held in quarantine until it is graded/i)).toBeVisible()

    await page.getByLabel(/Total received/i).fill('500')
    await pickOption(page.getByLabel('Storage area'), /Raw material area/i)

    await page.getByRole('button', { name: 'Post receipt, held for grading' }).click()
    await expect(page.getByText(/RFLOT\d+ linked to PO-\d+ \(received\)/i)).toBeVisible({
      timeout: 30_000,
    })
  })

  test('leg 3 — grade the staged lot', async ({ page }) => {
    await page.goto('/procurement?tab=grading')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Lot/ }), /Tender Coconut/i)

    await page.getByLabel(/^Grade A/).fill('300')
    await page.getByLabel(/^Grade B/).fill('150')
    await page.getByLabel(/^Grade C/).fill('40')
    await page.getByLabel(/^Rejected/).fill('10')
    await expect(page.getByText(/grades account for the whole load/i)).toBeVisible()

    await page.getByRole('button', { name: /Post grades for / }).click()
    await expect(page.getByText(/graded — \d+ accepted/i)).toBeVisible()
  })

  test('leg 4 — press the graded lot: outputs + spoilage + close', async ({ page }) => {
    await page.goto('/production?stage=run')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Lot/ }), /tender coconut/i)
    await page.getByLabel(/^Quantity \(piece\)/).fill('490')

    await expect(page.getByLabel(/^Bulk/).first()).toBeVisible()
    await page.getByLabel(/^Quantity \(litre\)/).fill('200')
    await page.getByLabel(/^Quantity \(kg\)/).fill('100')
    await pickOption(page.getByLabel('Put away in'), /Cold Room A/i)

    await page.getByLabel(/Spoiled at the press/i).fill('8')
    await pickOption(page.getByLabel(/^Reason/), /rotten/i)

    await page.getByRole('button', { name: 'Post pressing & close' }).click()
    await expect(page.getByText(/closed — variance/i)).toBeVisible({ timeout: 60_000 })
  })

  test('leg 5 — the blend drawing the quarantined water is refused BY THE SERVER', async ({ page }) => {
    settleExempt = true // the refused write never settles — that is the finding
    await page.goto('/production?stage=blend')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Blend recipe/ }), /Coconut Milk \(E2E\)/)

    // The classic client still allows a Quarantine draw (DRAWABLE) — the
    // journey's whole point is that the SERVER says no. The malai is
    // Released (qcExempt, released as booked); the water is the Quarantine
    // draw the gate exists to refuse. 100 kg + 100 L in, 198 out, 2 lost.
    const malaiRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Malai' })
    await pickOption(malaiRow.getByRole('combobox', { name: /^Lot/ }), /100 kg on hand/)
    await malaiRow.getByLabel(/^Quantity \(kg\)/).fill('100')

    const waterRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Water' })
    await pickOption(waterRow.getByRole('combobox', { name: /^Lot/ }), /200 litre on hand/)
    await waterRow.getByLabel(/^Quantity \(litre\)/).fill('100')

    // The server's water stock, before the attempt — the refusal must leave
    // it untouched (a landed draw would take 100 L off it).
    const waterBefore = await itemNet(page, 'Tender Coconut Water')

    await page.getByLabel(/^Blend produced/).fill('198')
    await pickOption(page.getByLabel('Put away in'), /Cold Room A/i)
    await page.getByLabel(/^Lost to blending/).fill('2')
    await pickOption(page.getByLabel(/^Reason/), /spillage/i)

    await page.getByRole('button', { name: 'Post run & close' }).click()
    // Optimistically the run closes on screen… and then the commit is
    // refused: the push fails, the app flips to its offline vocabulary. This
    // toast is the refusal, seen from the operator's chair.
    // The offline banner lives twice on the page (nav rail + toast) — pin the
    // toast, the operator's transient notice of the refusal.
    await expect(page.locator('.toast').filter({ hasText: /Offline — changes are held/ })).toBeVisible({
      timeout: 45_000,
    })

    // The server's own truth: the water's net stock is untouched (a landed
    // draw would have taken 100 L off it), and the refusal is on the audit
    // trail (action rules.rejected, guard released_only).
    expect(await itemNet(page, 'Tender Coconut Water'), 'no draw landed').toBe(waterBefore)
    const refusals = await refusalAudits(page)
    expect(refusals.length, 'the refusal is audited').toBeGreaterThan(0)
    expect(refusals[0].action).toBe('rules.rejected')
    expect(refusals[0].details).toContain('released_only')
  })

  test('leg 6 — the lab RELEASES the water (the malai never could be — it skips QC)', async ({ page }) => {
    await page.goto('/quality?tab=entry')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Record/ }), /Tender Coconut Water/)
    const cards = page.locator('article.qc-review-card')
    const count = await cards.count()
    for (let i = 0; i < count; i++) {
      await pickOption(cards.nth(i).getByRole('combobox'), /^Pass$/)
    }
    await page.getByRole('button', { name: /^Release / }).click()
    await expect(page.getByText('QC updated: Released.')).toBeVisible()
  })

  test('leg 7 — pack the now-Released water: the packs carry the verdict', async ({ page }) => {
    await page.goto('/production?stage=pack')
    await dismissTour(page)

    await pickOption(page.getByLabel(/^Filling from/), /Tender Coconut Water/)
    await pickOption(page.getByRole('combobox', { name: /^Batch lot/ }), /200 L on hand/)
    await pickOption(page.getByRole('combobox', { name: /^Pack/ }), /5 L BiB/i)
    await page.getByLabel(/^Packs filled/).fill('5')

    await pickOption(page.getByLabel('Storage area'), /Cold Room A/i)
    await page.getByRole('button', { name: 'Post packing run' }).click()
    // The released bulk's packs land Released — the toast says so in its
    // own words, and they are what leg 9 dispatches.
    await expect(page.getByText(/— the packs carry the bulk/i)).toBeVisible()
  })

  test('leg 8 — the desk raises a Fernandez order for the BiBs', async ({ page }) => {
    await page.goto('/orders?tab=desk')
    await dismissTour(page)

    await page.getByRole('button', { name: '+ Raise an order' }).click()
    await pickOption(
      page.locator('.field').filter({ hasText: /^Customer/ }).getByRole('combobox'),
      /Fernandez Bogulkunta/,
    )
    await page.locator('.field').filter({ hasText: /^Ship by/ }).locator('input').fill('2026-10-17')

    await pickOption(page.getByRole('combobox', { name: 'Add drink' }), /Tender Coconut Water/)
    await pickOption(page.getByRole('combobox', { name: /Add pack for Tender/ }), /TCW 5L C-Box/)
    await page.getByPlaceholder('Units').first().fill('5')

    await page.getByRole('button', { name: 'Raise order', exact: true }).click()
    await expect(page.getByText('Order raised.')).toBeVisible()
  })

  test('leg 9 — dispatch sails through the new arm on Released packs', async ({ page }) => {
    await page.goto('/orders?tab=dispatch')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Order/ }), /Fernandez Bogulkunta/)
    await page.getByPlaceholder('Registration or transporter').fill('TS 07 DB 4321')

    const send = page.locator('button.btn-primary').filter({ hasText: /^Dispatch ORD/ })
    ledger.orderId = (/Dispatch (ORD-[\d-]+)/.exec((await send.textContent()) ?? '') ?? [])[1] ?? ''
    expect(ledger.orderId, 'the dispatch button names its order').toMatch(/ORD-\d+-\d+/)
    await send.click()
    // The lab's release moved the bulk AND the packs filled from it — the
    // packs are Released stock, the dispatch arm's pass path.
    await expect(page.getByText(/No open orders/i)).toBeVisible()
  })
})

/** The item's net stock on the server — every lot pooled, so a refused draw
 *  shows as a before/after difference (or the lack of one). */
async function itemNet(page: Page, item: string): Promise<number> {
  const body = await getJson<{
    state?: { ledger?: { item?: string; qtyIn?: number | string; qtyOut?: number | string }[] }
  }>(page.request, '/api/snapshot')
  return (body.state?.ledger ?? [])
    .filter((l) => String(l.item ?? '') === item)
    .reduce((sum, l) => sum + Number(l.qtyIn ?? 0) - Number(l.qtyOut ?? 0), 0)
}

/** The rules-rejection audit rows the gate engine files (newest first). */
async function refusalAudits(page: Page): Promise<{ action: string; details: string }[]> {
  const body = await getJson<{ state?: { audits?: { action?: string; details?: string }[] } }>(
    page.request,
    '/api/snapshot',
  )
  return (body.state?.audits ?? [])
    .filter((a) => a.action === 'rules.rejected')
    .map((a) => ({ action: String(a.action), details: String(a.details ?? '') }))
}
