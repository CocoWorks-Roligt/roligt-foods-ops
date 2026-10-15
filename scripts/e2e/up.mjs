#!/usr/bin/env node
/**
 * Brings the E2E stack up and keeps it up — the Playwright webServer command.
 *
 *   prepare-db → d1-shim (:8111) → r2-shim (:8112) → dev-server (:3000, D1_API_BASE → shim)
 *
 * The R2_* env (dummy creds + R2_ENDPOINT → the r2-shim) is what lets the
 * delivery legs keep their bytes: the PWA's signature upload and the challan's
 * lazy PDF render both really store and fetch objects.
 *
 * The dev-server child env is built so the app runs its DESIGNED local shape:
 *   - D1_* points at the shim (dummy account/db/token — non-empty, never real),
 *   - WORKOS_CLIENT_ID / WORKOS_API_KEY / WORKOS_COOKIE_PASSWORD are set to
 *     EMPTY STRINGS: dev-server's .env loader only fills keys not already in
 *     process.env, so these block .env's real staging creds → workosConfigured()
 *     is false → ALLOW_DEV_SESSION=1 gives the browser a dev session (the Login
 *     page's role picker is the client half of that path).
 *
 * usage: node scripts/e2e/up.mjs [--port 3000] [--skip-prepare]
 * Readiness: GET /api/revision answers 200.
 */
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const port = Number(flag('--port', process.env.E2E_PORT || '3000'))
const shimPort = Number(flag('--shim-port', '8111'))
const r2Port = Number(flag('--r2-port', '8112'))
const dbPath = join(root, 'scripts/e2e/.tmp/e2e.sqlite')

if (!args.includes('--skip-prepare')) {
  execFileSync('node', ['scripts/e2e/prepare-db.mjs', '--db', dbPath], {
    cwd: root,
    stdio: 'inherit',
  })
}

const children = []
const die = () => {
  for (const c of children) c.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', die)
process.on('SIGTERM', die)

children.push(spawn('node', ['scripts/e2e/d1-shim.mjs', '--db', dbPath, '--port', String(shimPort)], { cwd: root, stdio: 'inherit' }))
children.push(spawn('node', ['scripts/e2e/r2-shim.mjs', '--port', String(r2Port)], { cwd: root, stdio: 'inherit' }))
children.push(
  spawn(
    'npx',
    ['tsx', 'scripts/dev-server.mjs', '--port', String(port)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        ALLOW_DEV_SESSION: '1',
        D1_API_BASE: `http://127.0.0.1:${shimPort}`,
        D1_ACCOUNT_ID: 'e2e-local',
        D1_DATABASE_ID: 'e2e-local',
        D1_API_TOKEN: 'e2e-local',
        // Dummy creds never leave the loopback — r2Configured() wants all four,
        // and R2_ENDPOINT bends every presigned URL onto the local shim.
        R2_ACCOUNT_ID: 'e2e-local',
        R2_BUCKET: 'e2e-attachments',
        R2_ACCESS_KEY_ID: 'e2e-local',
        R2_SECRET_ACCESS_KEY: 'e2e-local',
        R2_ENDPOINT: `http://127.0.0.1:${r2Port}`,
        WORKOS_CLIENT_ID: '',
        // A dummy key keeps api/_lib/workos.ts's eager `new WorkOS()` happy while
        // the empty clientId + cookie password keep workosConfigured() false.
        WORKOS_API_KEY: 'e2e-dummy-key',
        WORKOS_COOKIE_PASSWORD: '',
      },
    },
  ),
)

async function waitFor(url, label, timeoutMs = 30_000) {
  const began = Date.now()
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() - began > timeoutMs) throw new Error(`${label} never became ready at ${url}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

try {
  await waitFor(`http://127.0.0.1:${shimPort}/health`, 'd1-shim')
  await waitFor(`http://127.0.0.1:${r2Port}/health`, 'r2-shim')
  await waitFor(`http://127.0.0.1:${port}/api/revision`, 'dev-server')
  console.log(`E2E-READY http://localhost:${port}`)
} catch (e) {
  console.error(e.message)
  die()
}
