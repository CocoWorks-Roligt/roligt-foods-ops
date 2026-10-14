import { test, expect, type Locator } from '@playwright/test'
import { failOnPageErrors, dismissTour } from './helpers'

/**
 * HEAVY Journey A — as far as it exists (through dispatch; signature/challan
 * legs are Phase 4). The plant's own data and forms, end to end:
 *
 *   coconut PO → staged receipt → grading → extraction (spoilage, close) →
 *   coconut-milk blend (close) → QC release → BIB pack → QC release →
 *   order → dispatch
 *
 * Legs share one module-scope ledger and one server/DB (workers=1, serial);
 * the DB itself is rebuilt fresh per Playwright run by scripts/e2e/up.mjs.
 * Deviations from the prompt's ideal journey, both forced by live data:
 *   - the milk recipe is E2E-seeded (the plant has no milk intermediate),
 *   - the BIB pack packs the extraction's coconut-water bulk (the plant's own
 *     FG-0001 5L BiB packs SF-0002), not the milk.
 */
test.describe.serial(() => {
  const ledger: Record<string, string> = {}
  const errors: string[] = []

  test.beforeEach(async ({ page }) => {
    failOnPageErrors(page, errors)
    await page.addInitScript(() => localStorage.setItem('roligt_tour_done_v1', '1'))
  })

  test.afterEach(async ({ page }, info) => {
    // A leg's writes must reach the server before its context closes. The
    // save is debounced, and the next leg boots a FRESH context — none of
    // this tab's localStorage — so an un-flushed save would simply vanish
    // between legs (leg 7's packs once did: posted, toasted, never
    // committed, and the order desk had nothing to sell). The app's own
    // contract is the mirror: dirty work sits in a per-tab spill key, and a
    // tab is saved only when no spill remains. The plant's commit budget
    // (8/min sustained) means a busy stretch queues behind the throttle for
    // a while — the poll lets that drain.
    if (info.failed) return
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
        { timeout: 90_000 },
      )
      .toBe(false)
  })

  test.afterAll(async () => {
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  /**
   * Picks the option whose visible text matches, in EITHER control the app
   * uses: a native <select> (the PO form) or the hand-rolled listbox
   * (components/Select — button + portaled role=option divs; keyboard-first,
   * so a click opens and an option click picks). Returns the picked text —
   * the journey reads ids back out of it.
   */
  async function pickOption(control: Locator, matcher: RegExp | string): Promise<string> {
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
    // A snapshot landing between click and dispatch can drop the click on a
    // node React has since replaced — the list never opens. If NOTHING is
    // open after a beat, click again (only then: a second click toggles an
    // open list shut).
    await option.waitFor({ state: 'visible', timeout: 3_000 }).catch(async () => {
      const anyOpen = await control.page().getByRole('option').first().isVisible().catch(() => false)
      if (!anyOpen) await control.click()
      await option.waitFor({ state: 'visible' })
    })
    // Read before the click — clicking picks and closes the list, unmounting
    // the option.
    const text = (await option.textContent()) ?? ''
    await option.click()
    return text
  }

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

    // Submitting selects the new order — its card opens with the legal moves.
    const card = page
      .locator('.card')
      .filter({ has: page.getByRole('button', { name: /Mark/ }) })
      .last()
    await expect(card).toBeVisible()
    ledger.po = await card.locator('h3').textContent() ?? ''
    await card.getByRole('button', { name: /Mark Sent/i }).click()
    await expect(card.getByRole('button', { name: /Mark Acknowledged/i })).toBeVisible()
    await card.getByRole('button', { name: /Mark Acknowledged/i }).click()
    // Wait for the STATE, not the word: the button itself reads "Mark
    // Acknowledged", so a text match passes before the patch lands — and leg 2
    // would then see the order still 'sent', which the receipt form refuses to
    // list (linkable = acknowledged/received). The acked card's legal moves are
    // Received/Cancelled — that is the tell.
    await expect(card.getByRole('button', { name: /Mark Acknowledged/i })).toBeHidden()
    await expect(card.getByRole('button', { name: /Mark Received/i })).toBeVisible()
  })

  test('leg 2 — receive the load staged (grade later), linked to the PO', async ({ page }) => {
    await page.goto('/procurement?tab=receive')
    await dismissTour(page)

    const orderSelect = page.getByLabel(/^Order/)
    await pickOption(orderSelect, /^PO-\d+ · Kanaka/)
    await page.getByRole('button', { name: 'Receive this' }).click()

    // The line seeds product/qty/rate; the coconut is RAW+graded → stage it.
    await page.getByText('Grade later — the lot is held until the Grading stage sorts it').click()
    await expect(page.getByText(/held in quarantine until it is graded/i)).toBeVisible()

    await page.getByLabel(/Total received/i).fill('500')
    // The area picker lists label + type ("Raw material area · Dry Store");
    // "ambient" is the location's zone, not part of the option text.
    await pickOption(page.getByLabel('Storage area'), /Raw material area/i)

    await page.getByRole('button', { name: 'Post receipt, held for grading' }).click()
    // The GRN books locally, the debounced push lands, then the link sweep files
    // it against the order — the note names both ends. (The toast alone expires.)
    await expect(page.getByText(/RFLOT\d+ linked to PO-\d+ \(received\)/i)).toBeVisible({
      timeout: 30_000,
    })
  })

  test('leg 3 — grade the staged lot', async ({ page }) => {
    await page.goto('/procurement?tab=grading')
    await dismissTour(page)

    // The scan box beside it also answers to "Lot number" — take the combobox.
    const lotSelect = page.getByRole('combobox', { name: /^Lot/ })
    await pickOption(lotSelect, /Tender Coconut/i)

    // Sort the whole 500: 300 A, 150 B, 40 C, 10 rejected.
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

    // Only one graded lot exists — pick the queue's only source option (the
    // scan box beside it also answers to "Lot number"), and press all 490.
    await pickOption(page.getByRole('combobox', { name: /^Lot/ }), /tender coconut/i)
    await page.getByLabel(/^Quantity \(piece\)/).fill('490')

    // Outputs prefill from the lot's own bulks (water main, malai by-product) —
    // the numbers are the operator's to confirm.
    await expect(page.getByLabel(/^Bulk/).first()).toBeVisible()
    await page.getByLabel(/^Quantity \(litre\)/).fill('200')
    await page.getByLabel(/^Quantity \(kg\)/).fill('100')
    await pickOption(page.getByLabel('Put away in'), /Cold Room A/i)

    // Mandatory spoilage at the press: 8 of the 490 pressable, with a reason.
    await page.getByLabel(/Spoiled at the press/i).fill('8')
    await pickOption(page.getByLabel(/^Reason/), /rotten/i)

    await page.getByRole('button', { name: 'Post pressing & close' }).click()
    // The run posts, the snapshot carries the version, the close files the
    // spoilage and stamps the mass balance. 60 s covers a slow poll tick.
    await expect(page.getByText(/closed — variance/i)).toBeVisible({ timeout: 60_000 })
  })

  test('leg 5 — blend the malai and water into coconut milk, closed', async ({ page }) => {
    await page.goto('/production?stage=blend')
    await dismissTour(page)

    // The E2E-seeded recipe (the plant has no milk intermediate — noted as a
    // journey deviation): 50% malai, 50% water, in that order.
    await pickOption(page.getByRole('combobox', { name: /^Blend recipe/ }), /Coconut Milk \(E2E\)/)

    // One draw row per component, laid out in the recipe's order. Each row's
    // grid is the one that shows the component it is for. The lot options read
    // "lot · qty uom on hand" — matching the qty pins the draw to leg 4's
    // batch, not whichever lot the list happens to offer first.
    const malaiRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Malai' })
    await pickOption(malaiRow.getByRole('combobox', { name: /^Lot/ }), /100 kg on hand/)
    await malaiRow.getByLabel(/^Quantity \(kg\)/).fill('100')

    const waterRow = page.locator('.form-grid').filter({ hasText: 'Tender Coconut Water' })
    await pickOption(waterRow.getByRole('combobox', { name: /^Lot/ }), /200 litre on hand/)
    // Half the water goes to the milk (the recipe is 50/50 malai:water); the
    // other half stays for leg 7's BiBs.
    await waterRow.getByLabel(/^Quantity \(litre\)/).fill('100')

    // The balance is unit-blind: In 200 (100 kg + 100 L) needs produced +
    // spoilage within 2% — 198 + 2 = 200, variance 0.
    await page.getByLabel(/^Blend produced/).fill('198')
    await pickOption(page.getByLabel('Put away in'), /Cold Room A/i)

    // Mandatory spoilage, in the blend's own vocabulary.
    await page.getByLabel(/^Lost to blending/).fill('2')
    await pickOption(page.getByLabel(/^Reason/), /spillage/i)

    await page.getByRole('button', { name: 'Post run & close' }).click()
    const closed = page.getByText(/closed — variance/i)
    await expect(closed).toBeVisible({ timeout: 60_000 })
    ledger.blendBatch = (/(\S+) closed/.exec(await closed.textContent()) ?? [])[1] ?? ''
    expect(ledger.blendBatch, 'the close toast names the batch').toMatch(/.+/)
  })

  test('leg 6 — the lab releases the coconut-water bulk', async ({ page }) => {
    await page.goto('/quality?tab=entry')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Record/ }), /Tender Coconut Water/)

    // Every test the product masters turns Pass — the needed ones decide the
    // release, the rest ride along.
    const cards = page.locator('article.qc-review-card')
    const count = await cards.count()
    for (let i = 0; i < count; i++) {
      await pickOption(cards.nth(i).getByRole('combobox'), /^Pass$/)
    }
    await page.getByRole('button', { name: /^Release / }).click()
    await expect(page.getByText('QC updated: Released.')).toBeVisible()
  })

  test('leg 7 — pack the released water into 5 L BiBs with control samples', async ({ page }) => {
    await page.goto('/production?stage=pack')
    await dismissTour(page)

    await pickOption(page.getByLabel(/^Filling from/), /Tender Coconut Water/)
    // The scan box beside the picker also answers to "Batch lot" — take the
    // combobox, as with every other lot pick.
    await pickOption(page.getByRole('combobox', { name: /^Batch lot/ }), /100 L on hand/)

    // 10 × 5 L of the 200 L bulk, straight into the cold room. The stage's
    // Selects fold their own display text into the label ("PackSelect pack"),
    // so labels match by PREFIX only — and /^Pack/ would also hit the "Packs
    // filled" field beside it. The combobox role names just the picker.
    await pickOption(page.getByRole('combobox', { name: /^Pack/ }), /5 L BiB/i)
    await page.getByLabel(/^Packs filled/).fill('10')

    await page.getByRole('button', { name: 'Keep control samples' }).click()
    await pickOption(page.getByLabel(/^Kept in/), /5 L BiB/i)
    await page.getByLabel(/^How many/).fill('2')
    await page.getByLabel(/^Collected by/).fill('E2E')

    await pickOption(page.getByLabel('Storage area'), /Cold Room A/i)
    await page.getByRole('button', { name: 'Post packing run' }).click()
    // The packs carry the bulk's own verdict — Released water, so they go
    // straight to dispatchable.
    await expect(page.getByText(/— the packs carry the bulk/i)).toBeVisible()
  })

  test('leg 8 — the desk raises a Fernandez order for the BiBs', async ({ page }) => {
    await page.goto('/orders?tab=desk')
    await dismissTour(page)

    await page.getByRole('button', { name: '+ Raise an order' }).click()
    // The order form's labels sit beside their controls, not around them —
    // address each through its field.
    await pickOption(
      page.locator('.field').filter({ hasText: /^Customer/ }).getByRole('combobox'),
      /Fernandez Bogulkunta/,
    )
    await page.locator('.field').filter({ hasText: /^Ship by/ }).locator('input').fill('2026-10-16')

    // The catalogue is two-deep: the drink (the bulk), then the pack format
    // under it. "TCW 5L C-Box" is FG-0001 — the very pack leg 7 filled.
    await pickOption(page.getByRole('combobox', { name: 'Add drink' }), /Tender Coconut Water/)
    await pickOption(page.getByRole('combobox', { name: /Add pack for Tender/ }), /TCW 5L C-Box/)
    await page.getByPlaceholder('Units').first().fill('8')

    await page.getByRole('button', { name: 'Raise order', exact: true }).click()
    await expect(page.getByText('Order raised.')).toBeVisible()
  })

  test('leg 9 — dispatch the order complete', async ({ page }) => {
    await page.goto('/orders?tab=dispatch')
    await dismissTour(page)

    await pickOption(page.getByRole('combobox', { name: /^Order/ }), /Fernandez Bogulkunta/)
    await page.getByPlaceholder('Registration or transporter').fill('AP 16 TV 1234')

    // The footer button names the order it will send. The section header
    // ("Dispatch ORD-… Fernandez Bogulkunta") answers to the same prefix —
    // take the primary action, not the fold it lives under.
    await page.locator('button.btn-primary').filter({ hasText: /^Dispatch ORD/ }).click()
    // The queue is drained — the only open order just went out.
    await expect(page.getByText(/No open orders/i)).toBeVisible()
  })

  test('leg 10 — the milk’s genealogy names what made it', async ({ page }) => {
    expect(ledger.blendBatch, 'leg 5 captured the batch id').toMatch(/.+/)
    await page.goto(`/batch/${ledger.blendBatch}`)
    await dismissTour(page)

    // Upstream the whole chain, in the page's own vocabulary — ids, not
    // names: the coconut's extraction batch, and the receipt it all began at.
    // Batch ids are BAT-YYYY-NNNN — the year and serial are separate digit
    // runs, so \d+ alone cannot span them (this cost an hour once: the regex
    // failed in plain Node too, once anyone thought to look).
    await expect(page.getByText(/Batch BAT-\d+-\d+ \(Extraction\)/)).toBeVisible()
    await expect(page.getByText(/Receipt RFTC-[\d-]+ — Kanaka Durga Rao/)).toBeVisible()
    // The blend's own draws are on the record too: the malai and the water.
    await expect(page.getByText(/Drew 100 Kg of SF-0003/)).toBeVisible()
    await expect(page.getByText(/Drew 100 Litre of SF-0002/)).toBeVisible()
  })
})
