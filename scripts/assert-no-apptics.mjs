#!/usr/bin/env node
/**
 * Build assertion (the audit's S3-13): an UNCONFIGURED build may not carry the
 * Apptics SDK's bytes.
 *
 * The staging trial is env-gated (APPTICS_CONFIGURED folds to false when the
 * VITE_APPTICS_* vars are absent), but a static import of the SDK module
 * dragged its `apptics.zoho.*` init hosts — and the trial's ids — into the
 * bundle anyway: the flag gated the calls, not the bytes. src/lib/apptics.ts
 * now dynamic-imports the SDK inside initApptics so an unconfigured build folds
 * the import out of the graph entirely; this script fails the build if the
 * markers ever come back in a build that was never configured.
 *
 * A build IS configured when any source Vite reads supplies VITE_APPTICS_* —
 * process.env or a .env* file — so a staging build carries the SDK by design
 * and passes with a note. ASSERT_APPTICS_ALLOWED=1 forces the pass regardless
 * (CI plumbing that hides the env from this script).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const cwd = process.cwd()
const dist = join(cwd, 'dist')
const MARKERS = [
  ['apptics.zoho host', /apptics\.zoho\./],
  ['appticssettings global', /appticssettings/i],
]
const VAR_RE = /^\s*VITE_APPTICS_[A-Z_]+\s*=\s*(\S+)/

/** Where the vars could come from, named for the note — Vite's own load order
 *  (process.env beats the files) is irrelevant here: any ONE source configuring
 *  the trial makes the build a configured one. */
function configuredFrom() {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VITE_APPTICS_') && v) return `process.env.${k}`
  }
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const path = join(cwd, name)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = VAR_RE.exec(line)
      if (m && m[1] !== undefined && !m[1].startsWith('#')) return name
    }
  }
  return null
}

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else files.push(path)
  }
}
try {
  walk(dist)
} catch (e) {
  console.error(`[assert-no-apptics] cannot read ${relative(cwd, dist)} — run vite build first (${e.message})`)
  process.exit(1)
}

const offenders = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue // unreadable as text — nothing a URL marker could hide in
  }
  for (const [label, re] of MARKERS) {
    if (re.test(text)) offenders.push(`${relative(cwd, file)} — ${label}`)
  }
}

const source = configuredFrom()
if (offenders.length && (source || process.env.ASSERT_APPTICS_ALLOWED === '1')) {
  console.log(`[assert-no-apptics] SDK present by configuration (${source ?? 'ASSERT_APPTICS_ALLOWED=1'}) — nothing to assert`)
  process.exit(0)
}
if (offenders.length) {
  console.error('[assert-no-apptics] Apptics markers in a build that was never configured:')
  for (const offender of offenders) console.error(`  ${offender}`)
  console.error('The SDK must stay behind the dynamic import in src/lib/apptics.ts so an unconfigured build folds it out.')
  process.exit(1)
}
console.log(`[assert-no-apptics] clean — no Apptics marker in ${files.length} dist files`)
