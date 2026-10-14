import { test, expect } from '@playwright/test'
import { failOnPageErrors } from './helpers'

/**
 * Boot — the harness's own smoke, and W16's onboarding contract: a fresh
 * device gets the tour offer the moment the pipeline flag reaches an operator,
 * and the shell is the process-order nav with live badges (shell_nav ON).
 * The dev session means there is no Login: a fresh browser is already Admin.
 */
test('fresh boot: tour offers itself; shell is the process nav with badges', async ({ page }) => {
  const errors: string[] = []
  failOnPageErrors(page, errors)

  await page.goto('/')

  // First-run tour (device-local) offers itself on a fresh context.
  const tour = page.locator('.tour-card[role="dialog"]').first()
  await expect(tour).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tour).toBeHidden()

  // '/' redirects by role with the pipeline flag on — Admin lands on the board.
  await expect(page.locator('[data-tour="pipeline-board"]')).toBeVisible()

  // The process-order sidebar carries live counts (dump data: 7 control samples).
  const nav = page.getByRole('complementary', { name: 'Main navigation' })
  await expect(nav).toBeVisible()
  await expect(nav.getByRole('button', { name: /Control Samples/ })).toContainText('7')
  await expect(nav.getByRole('button', { name: 'Pipeline' })).toBeVisible()

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
})
