import { test, expect, type Page } from '@playwright/test'
import { failOnPageErrors, dismissTour, getJson, pickOption, settleMirror } from './helpers'

/**
 * HEAVY Journey D (Phase 6) — the QC hard gate, end to end, under
 * E2E_FLAGS=qc_gate_v2 (this spec SKIPS itself in a default-flags run: its
 * leg-7 refusal only exists with the gate on, and its pass legs must prove the
 * gate lets honest work through — so it runs as its own playwright invocation
 * on the fresh DB the flags env builds):
 *
 *   coconut PO → staged receipt → grading → extraction (close) →
 *   QC REJECTS the malai (its lot lands Quarantine) →
 *   QC RELEASES the water →
 *   a blend drawing the quarantined malai is REFUSED BY THE SERVER —
 *     the client's own rules still allow it (classic DRAWABLE), the commit
 *     422s with lot_not_released, and the refused write is left stuck-dirty on
 *     the device (the offline retry loop cannot tell a refusal from an
 *     outage — a ROLLOUT gate recorded in QA_REPORT) →
 *   packing the RELEASED water passes the same gate →
 *   order → dispatch (the new dispatch arm's pass path) → No open orders
 *
 * The gate's other refusal arms (a Packing/Dispatch draw of non-Released
 * stock) are pinned by rulesGate.test.ts — the plant's own flow cannot stage
 * them in a UI journey: packs inherit their bulk's verdict, so a rejected
 * bulk's packs are already unpoolable client-side, and the server arms are the
 * authority for hand-built writes.
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

  test('leg 5 — the lab REJECTS the malai (its lot lands Quarantine)', async ({ page }) => {
    await page.goto('/quality?tab=entry')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Record/ }), /Tender Coconut Malai/)

    // A Fail on any test rejects it — fail them all, in the bench's own words.
    const cards = page.locator('article.qc-review-card')
    const count = await cards.count()
    for (let i = 0; i < count; i++) {
      await pickOption(cards.nth(i).getByRole('combobox'), /^Fail$/)
    }
    await page.getByRole('button', { name: /^Reject / }).click()
    await expect(page.getByText('QC updated: Rejected.')).toBeVisible()
  })

  test('leg 6 — the lab RELEASES the water', async ({ page }) => {
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

  test('leg 7 — the blend drawing the quarantined malai is refused BY THE SERVER', async ({ page }) => {
    settleExempt = true // the refused write never settles — that is the finding
    await page.goto('/production?stage=blend')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Blend recipe/ }), /Coconut Milk \(E2E\)/)

    // The classic client still allows a Quarantine draw (DRAWABLE) — the
    // journey's whole point is that the SERVER says no. Journey-a leg 5's
    // numbers: 100 kg malai + 100 L water in, 198 out, 2 lost.
    const malaiRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Malai' })
    await pickOption(malaiRow.getByRole('combobox', { name: /^Lot/ }), /100 kg on hand/)
    await malaiRow.getByLabel(/^Quantity \(kg\)/).fill('100')

    const waterRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Water' })
    await pickOption(waterRow.getByRole('combobox', { name: /^Lot/ }), /200 litre on hand/)
    await waterRow.getByLabel(/^Quantity \(litre\)/).fill('100')

    await page.getByLabel(/^Blend produced/).fill('198')
    await pickOption(page.getByLabel('Put away in'), /Cold Room A/i)
    await page.getByLabel(/^Lost to blending/).fill('2')
    await pickOption(page.getByLabel(/^Reason/), /spillage/i)

    await page.getByRole('button', { name: 'Post run & close' }).click()
    // Optimistically the run closes on screen… and then the commit is
    // refused: the push fails, the app flips to its offline vocabulary. This
    // toast is the refusal, seen from the operator's chair.
    await expect(page.getByText(/Offline — changes are held on this device/)).toBeVisible({
      timeout: 45_000,
    })

    // The server's own truth, read straight off the snapshot: no blend ever
    // landed — zero Melange Consume draws — and the refusal is on the audit
    // trail (action rules.rejected, filed by the engine that refused).
    const { blends, refusals } = await serverTruth(page)
    expect(blends, 'no blend draw landed').toBe(0)
    expect(refusals.length, 'the refusal is audited').toBeGreaterThan(0)
    expect(refusals[0].action).toBe('rules.rejected')
    expect(refusals[0].details).toContain('released_only')
  })

  test('leg 8 — packing the RELEASED water passes the same gate', async ({ page }) => {
    await page.goto('/production?stage=pack')
    await dismissTour(page)

    await pickOption(page.getByLabel(/^Filling from/), /Tender Coconut Water/)
    await pickOption(page.getByRole('combobox', { name: /^Batch lot/ }), /200 L on hand/)
    await pickOption(page.getByRole('combobox', { name: /^Pack/ }), /5 L BiB/i)
    await page.getByLabel(/^Packs filled/).fill('5')

    await pickOption(page.getByLabel('Storage area'), /Cold Room A/i)
    await page.getByRole('button', { name: 'Post packing run' }).click()
    await expect(page.getByText(/— the packs carry the bulk/i)).toBeVisible()
  })

  test('leg 9 — the desk raises a Fernandez order for the BiBs', async ({ page }) => {
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

  test('leg 10 — dispatch sails through the new dispatch arm', async ({ page }) => {
    await page.goto('/orders?tab=dispatch')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Order/ }), /Fernandez Bogulkunta/)
    await page.getByPlaceholder('Registration or transporter').fill('TS 07 DB 4321')

    const send = page.locator('button.btn-primary').filter({ hasText: /^Dispatch ORD/ })
    ledger.orderId = (/Dispatch (ORD-[\d-]+)/.exec((await send.textContent()) ?? '') ?? [])[1] ?? ''
    expect(ledger.orderId, 'the dispatch button names its order').toMatch(/ORD-\d+-\d+/)
    await send.click()
    // The packs are Released stock — the dispatch arm's pass path — so the
    // queue drains exactly as it does with the flag off.
    await expect(page.getByText(/No open orders/i)).toBeVisible()
  })
})

/** The server's answer for the refusal leg: how many blend draws landed, and
 *  the rules-rejection audit rows the engine filed. */
async function serverTruth(page: Page): Promise<{
  blends: number
  refusals: { action: string; details: string }[]
}> {
  const body = await getJson<{
    state?: {
      ledger?: { type?: string }[]
      audits?: { action?: string; details?: string }[]
    }
  }>(page.request, '/api/snapshot')
  const ledger = body.state?.ledger ?? []
  return {
    blends: ledger.filter((l) => l.type === 'Melange Consume').length,
    refusals: (body.state?.audits ?? [])
      .filter((a) => a.action === 'rules.rejected')
      .map((a) => ({ action: String(a.action), details: String(a.details ?? '') })),
  }
}
