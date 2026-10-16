import { test, expect } from '@playwright/test'
import { failOnPageErrors, dismissTour, pickOption, settleMirror } from './helpers'

/**
 * HEAVY Journey B (Phase 6) — the no-grading, no-extraction chain, entirely on
 * the plant's own masters:
 *
 *   ready-extract intake (Cold Brew Concentrate, received as-is) →
 *   Cold Brew blend (the plant's own MLG-0003 recipe, closed) →
 *   QC release → GLASS-bottle pack (FG-0017, 1 L) → order → dispatch →
 *   boarded onto a trip (which the offline spec then delivers)
 *
 * The prompt's ideal journey names "tea extract"; the plant's one bought-in
 * extract that a real recipe draws is the cold brew concentrate (SF-0009, 3%
 * of MLG-0003) — same shape, live data. One E2E seed wires it receivable
 * (PP-E2E-CB, prepare-db): the purchase catalog lists farm produce and
 * packaging only, so no ready extract was receivable before.
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

  test('leg 1 — receive the bought-in concentrate as-is (no grading, no extraction)', async ({ page }) => {
    await page.goto('/procurement?tab=receive')
    await dismissTour(page)

    // A direct delivery — no PO against a concentrate. The route note IS the
    // journey's claim: READY_EXTRACT goes to inventory as-is.
    await pickOption(page.getByLabel('Product received'), /Cold Brew Concentrate/)
    await expect(page.getByText('Goes into inventory as-is — no grading, no extraction.')).toBeVisible()

    await pickOption(page.getByLabel('Approved supplier'), /Naivo Coffee/)
    await page.getByLabel(/Total received/i).fill('5')
    await page.getByLabel(/^Rate/).fill('260')
    await pickOption(page.getByLabel('Storage area'), /Cold Room A/i)

    await page.getByRole('button', { name: 'Post receipt' }).click()
    // The posted toast (ReceiptTab's own copy); a bare /received/i match only
    // finds the receive tab's standing intro paragraph, which stays hidden.
    await expect(page.getByText(/Receipt posted into /)).toBeVisible({ timeout: 30_000 })
  })

  test('leg 2 — blend the plant’s Cold Brew recipe, closed', async ({ page }) => {
    await page.goto('/production?stage=blend')
    await dismissTour(page)

    // The recipe option carries its shares ("Cold Brew Coffee · 97% / 3%") —
    // an anchored-exact name match never finds it.
    await pickOption(page.getByRole('combobox', { name: /^Blend recipe/ }), /^Cold Brew Coffee ·/)

    // Recipe order: water 97%, concentrate 3%. The water lot is journey A's
    // pressing, pinned by what is LEFT of it — the lot list also carries
    // dump-era water lots, and a bare /litre on hand/ picks the first of them
    // (BAT-2026-0001, all but spent), which the draw check then refuses. The
    // press made 200 L; A's milk took 100, its 10 BiBs took 50, and their two
    // control samples — drawn from the same tank (posting.ts) — took 10 → 40.
    const waterRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Water' })
    await pickOption(waterRow.getByRole('combobox', { name: /^Lot/ }), /40 litre on hand/)
    await waterRow.getByLabel(/^Quantity \(litre\)/).fill('29.1')

    // The concentrate row, the recipe grid and the recipe pick all share the
    // words "Cold Brew Coffee" — only a draw row carries a Lot combobox.
    const cbRow = page
      .locator('.form-grid')
      .filter({ hasText: 'Cold Brew Coffee' })
      .filter({ has: page.getByRole('combobox', { name: /^Lot/ }) })
    await pickOption(cbRow.getByRole('combobox', { name: /^Lot/ }), /5 litre on hand/)
    await cbRow.getByLabel(/^Quantity \(litre\)/).fill('0.9')

    // In 30, produced 29 + spoilage 1 — variance 0.
    await page.getByLabel(/^Blend produced/).fill('29')
    await pickOption(page.getByLabel('Put away in'), /Cold Room A/i)
    await page.getByLabel(/^Lost to blending/).fill('1')
    await pickOption(page.getByLabel(/^Reason/), /spillage/i)

    await page.getByRole('button', { name: 'Post run & close' }).click()
    await expect(page.getByText(/closed — variance/i)).toBeVisible({ timeout: 60_000 })
  })

  test('leg 3 — the lab releases the cold brew bulk', async ({ page }) => {
    await page.goto('/quality?tab=entry')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Record/ }), /Cold Brew/)
    const cards = page.locator('article.qc-review-card')
    const count = await cards.count()
    for (let i = 0; i < count; i++) {
      await pickOption(cards.nth(i).getByRole('combobox'), /^Pass$/)
    }
    await page.getByRole('button', { name: /^Release / }).click()
    await expect(page.getByText('QC updated: Released.')).toBeVisible()
  })

  test('leg 4 — pack the released bulk into 1 L glass bottles', async ({ page }) => {
    await page.goto('/production?stage=pack')
    await dismissTour(page)

    // The drink's own name, plain — the legacy "(bulk)" suffix is stripped at
    // load (migrate.ts), so every surface the journey touches reads "Cold
    // Brew Coffee": this picker ("Cold Brew Coffee · N batches"), the QC page,
    // and the orders desk's drink list.
    await pickOption(page.getByLabel(/^Filling from/), /^Cold Brew Coffee/)
    // The blend's own arithmetic: 29 posted, 1 kept back as blending spoilage
    // (its own ledger line) → 28 L. Pinned so the dump-era 0.1 L lot can't win.
    await pickOption(page.getByRole('combobox', { name: /^Batch lot/ }), /28 L on hand/)

    await pickOption(page.getByRole('combobox', { name: /^Pack/ }), /1 L Glass Bottle/)
    // 23 of the 28 L — journey C takes the last 5 L as two 2.5 L BiBs.
    await page.getByLabel(/^Packs filled/).fill('23')

    await pickOption(page.getByLabel('Storage area'), /Cold Room A/i)
    await page.getByRole('button', { name: 'Post packing run' }).click()
    await expect(page.getByText(/— the packs carry the bulk/i)).toBeVisible()
  })

  test('leg 5 — the desk raises a glass-bottle order', async ({ page }) => {
    await page.goto('/orders?tab=desk')
    await dismissTour(page)

    await page.getByRole('button', { name: '+ Raise an order' }).click()
    await pickOption(
      page.locator('.field').filter({ hasText: /^Customer/ }).getByRole('combobox'),
      /Naga Chaitanya/,
    )
    await page.locator('.field').filter({ hasText: /^Ship by/ }).locator('input').fill('2026-10-17')

    // The drink list holds both cold brews — the bought-in concentrate and
    // the blend — but the drink the desk groups under is the blend's bulk,
    // "Cold Brew Coffee" once the legacy "(bulk)" suffix is stripped.
    await pickOption(page.getByRole('combobox', { name: 'Add drink' }), /^Cold Brew Coffee/)
    // Desk pack options read "{product name} · {type}" — the product's own
    // name, not the pack label the pack stage shows.
    await pickOption(page.getByRole('combobox', { name: /Add pack for Cold/ }), /Glass Bottle - 1L CBC/)
    await page.getByPlaceholder('Units').first().fill('8')

    await page.getByRole('button', { name: 'Raise order', exact: true }).click()
    await expect(page.getByText('Order raised.')).toBeVisible()
  })

  test('leg 6 — dispatch the glass order complete', async ({ page }) => {
    await page.goto('/orders?tab=dispatch')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Order/ }), /Naga Chaitanya/)
    await page.getByPlaceholder('Registration or transporter').fill('TS 09 AA 1234')

    const send = page.locator('button.btn-primary').filter({ hasText: /^Dispatch ORD/ })
    ledger.orderId = (/Dispatch (ORD-[\d-]+)/.exec((await send.textContent()) ?? '') ?? [])[1] ?? ''
    expect(ledger.orderId, 'the dispatch button names its order').toMatch(/ORD-\d+-\d+/)
    await send.click()
    await expect(page.getByText(/No open orders/i)).toBeVisible()
  })

  test('leg 7 — the board boards the glass onto its own trip', async ({ page }) => {
    await page.goto('/shipments')
    await dismissTour(page)

    await page.getByRole('button', { name: 'New trip' }).click()
    const modal = page.locator('.modal-box')
    expect(ledger.orderId, 'leg 6 captured the order id').toMatch(/ORD-\d+/)
    await pickOption(modal.getByLabel(/^Order/), new RegExp(ledger.orderId))
    const rowsToBoard = modal.locator('label.check-row')
    await expect(rowsToBoard.first()).toBeVisible()
    for (let i = 0; i < await rowsToBoard.count(); i++) await rowsToBoard.nth(i).click()
    await modal.getByLabel(/^Agent \(email\)/).fill('dev@roligt.local')

    await modal.getByRole('button', { name: 'Create trip' }).click()
    await expect(modal).toBeHidden()

    const row = page.locator('tr', { hasText: 'Naga Chaitanya' })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('TS 09 AA 1234')
    await expect(row).toContainText('Created')
  })
})
