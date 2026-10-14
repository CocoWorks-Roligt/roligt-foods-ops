import { defineConfig, devices } from '@playwright/test'

/**
 * HEAVY E2E — the real built SPA (dist/, `npm run build:e2e`) served by the
 * local harness (scripts/e2e/up.mjs: prod-like D1 dump + phase-2 backfill +
        * pipeline/shell_nav flags ON, d1-shim standing in for Cloudflare, dev
 * sessions instead of WorkOS). The journey never touches a remote DB.
 *
 *   npm run build:e2e && npx playwright test            # from repo root
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: '.artifacts/results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // one journey, one plant, one story — order is the point
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e/up.mjs',
    url: 'http://localhost:3000/api/revision',
    // Never: a run must always rebuild the DB (up.mjs prepares it fresh) and
    // boot its own harness. Reusing a stray server silently ran the journey
    // against whatever state the last debug session left in it.
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
})
