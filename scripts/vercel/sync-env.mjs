#!/usr/bin/env node
/**
 * Mirrors the checkout's env into a Vercel environment — one command instead of a
 * morning of `vercel env add` by hand, with the plant's rules baked in: only the
 * BFF's own keys ever sync, the local-harness flags and the Supabase keys never do,
 * Apptics stays out of Production, and Production itself takes a typed
 * `--production production` and refuses to run half-configured.
 *
 * usage: node scripts/vercel/sync-env.mjs <development|preview|production>
 *          [--dry-run] [--from <file>] [--replace] [--production production]
 * Source is .env + .env.local (local wins) or --from <file> when the production
 * values shouldn't disturb local dev. Existing vars are skipped unless --replace.
 * Values travel via stdin and are never printed.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const REPLACE = argv.includes('--replace')
const fromIdx = argv.indexOf('--from')
const FROM = fromIdx >= 0 ? argv[fromIdx + 1] : null
const hatchIdx = argv.indexOf('--production')
const HATCH = hatchIdx >= 0 ? argv[hatchIdx + 1] : null
const TARGET = argv.find((a) => ['development', 'preview', 'production'].includes(a))
if (!TARGET) {
  console.error('usage: node scripts/vercel/sync-env.mjs <development|preview|production> [--dry-run] [--from <file>] [--replace] [--production production]')
  process.exit(1)
}
if (TARGET === 'production' && HATCH !== 'production') {
  console.error('REFUSING: target is the Production environment — re-run with --production production to confirm')
  process.exit(1)
}

// the BFF's own keys, and only ever these
const BFF_KEYS = [
  'ZOHO_BASE_ID', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_DC',
  'WORKOS_API_HOSTNAME', 'WORKOS_CLIENT_ID', 'WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD', 'WORKOS_ORG_ID',
]
const OPTIONAL_KEYS = ['WORKOS_REDIRECT_URI', 'VITE_WORKOS_CLIENT_ID']
const APPTICS_KEYS = ['VITE_APPTICS_PROJECT_ID', 'VITE_APPTICS_ZSOID', 'VITE_APPTICS_APP_TOKEN', 'VITE_APPTICS_DC']
// never leave this checkout, whatever the source file says
const REFUSED_KEYS = ['ALLOW_DEV_SESSION', 'ALLOW_DEV_HOSTS']
const REFUSED_PATTERN = /^VITE_SUPABASE_/

const readEnv = (f) =>
  Object.fromEntries(
    readFileSync(f, 'utf8').split('\n')
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
const src = {}
if (FROM) {
  if (!existsSync(FROM)) { console.error(`--from file not found: ${FROM}`); process.exit(1) }
  Object.assign(src, readEnv(FROM))
} else {
  for (const f of ['.env', '.env.local']) if (existsSync(join(ROOT, f))) Object.assign(src, readEnv(join(ROOT, f)))
}

const names = [...BFF_KEYS, ...OPTIONAL_KEYS, ...(TARGET === 'production' ? [] : APPTICS_KEYS)]
for (const k of REFUSED_KEYS) if (src[k]) console.log(`  ! ${k} present in source — REFUSED, it never leaves this checkout`)
for (const k of Object.keys(src)) if (REFUSED_PATTERN.test(k)) console.log(`  ! ${k} present in source — REFUSED (Supabase retirement is manual)`)

// Production refuses to run half-configured: every WORKOS_ key the BFF needs must be
// present and nonempty in the source, whatever it is set from.
if (TARGET === 'production') {
  const missing = BFF_KEYS.filter((k) => k.startsWith('WORKOS_') && !src[k])
  if (missing.length) {
    console.error(`REFUSING: Production would end up half-configured — missing from source: ${missing.join(', ')}`)
    process.exit(1)
  }
}

// what the environment already carries: pull to a throwaway file and read the key
// names (secret values come back masked; only the names matter here)
const pullF = join(tmpdir(), `roligt-sync-env-${TARGET}-${Date.now()}.env`)
try {
  execFileSync('vercel', ['env', 'pull', pullF, `--environment=${TARGET}`], { cwd: ROOT, stdio: 'pipe' })
} catch (e) {
  console.error('vercel env pull failed: ' + String(e.message).split('\n')[0])
  process.exit(1)
}
const existing = new Set(
  readFileSync(pullF, 'utf8').split('\n')
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => l.slice(0, l.indexOf('=')).trim()),
)
rmSync(pullF, { force: true })

console.log(`sync-env → ${TARGET}${DRY ? ' (dry run — nothing will be written)' : ''}${FROM ? ` from ${FROM}` : ' from .env + .env.local'}`)
// run one vercel command; failures print the CLI's own message, never the value
const vercel = (args, input) => {
  try {
    execFileSync('vercel', args, { cwd: ROOT, ...(input !== undefined ? { input, stdio: 'pipe' } : { stdio: 'pipe' }) })
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '')
    const msg = out.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || String(e.message).split('\n')[0]
    console.error(`! vercel ${args.join(' ')} failed: ${msg}`)
    process.exit(1)
  }
}

let acted = 0
for (const name of names) {
  const value = src[name]
  if (!value) { console.log(`  · ${name} not set in source — skipped`); continue }
  // the CLI has opinions per name: *TOKEN must be Config, and VITE_* exposes the
  // value to the browser so Secret is refused for it — both land as Config
  const type = /TOKEN$/.test(name) || name.startsWith('VITE_') ? 'config' : 'secret'
  if (existing.has(name)) {
    if (!REPLACE) { console.log(`  = ${name} already set — skipped (--replace to overwrite)`); continue }
    if (DRY) { console.log(`  ~ ${name} would be replaced (${type})`); acted++; continue }
    vercel(['env', 'rm', name, TARGET, '-y'])
    vercel(['env', 'add', name, TARGET, '--type', type], value + '\n')
    console.log(`  ~ ${name} replaced (${type})`)
  } else {
    if (DRY) { console.log(`  + ${name} would be added (${type})`); acted++; continue }
    vercel(['env', 'add', name, TARGET, '--type', type], value + '\n')
    console.log(`  + ${name} added (${type})`)
  }
  acted++
}
if (!DRY && acted > 0) {
  console.log('reminder: env binds per-deployment — existing deployments keep their old env until redeployed (vercel redeploy <url>)')
}
