/**
 * One ZohoClient for the whole BFF.
 *
 * The client's read/write budgets guard an API limit that is global per key, not per
 * request — a per-handler instance would give each request its own fresh 26/17 and
 * three concurrent requests would blow straight past the real ceiling. Every handler
 * (and commit's link-map reads) goes through this single instance so the budget is
 * spent once, plant-wide. Tests keep injecting their own fakes through
 * `commitChanges`'s parameters; this instance is for the handlers only.
 *
 * The generated schema (baseSchema.ts) carries every synced base — one SCHEMAS entry
 * per scripts/zoho/topup-state.<base8>.json — and T resolves the active one from
 * ZOHO_BASE_ID at import (DEFAULT_BASE_ID when unset). A base nobody synced still has
 * to fail loudly rather than quietly serve another base's table ids, so the client is
 * only constructed after assertBaseMatch agrees that ZOHO_BASE_ID, when set, names a
 * base the schemas actually carry; an unknown base throws at boot naming what to run.
 */
import { ZohoClient } from './zoho.js'
import { SCHEMAS } from './baseSchema.js'

/**
 * Throw when env names a base the generated schemas don't carry. Unset stays allowed:
 * no ZOHO_BASE_ID means the client and T both fall back to DEFAULT_BASE_ID, the base
 * this checkout was generated against.
 */
export function assertBaseMatch(
  env: { ZOHO_BASE_ID?: string | undefined },
  known: string[] = Object.keys(SCHEMAS),
): void {
  const envBase = env.ZOHO_BASE_ID
  if (envBase && !known.includes(envBase)) {
    throw new Error(
      `ZOHO_BASE_ID ${envBase} has no generated schema (have: ${known.join(', ')}) — sync the base first ` +
        `(node scripts/zoho/topup.mjs ${envBase}), then fix .env`,
    )
  }
}

assertBaseMatch(process.env)

// 45s of budget wait, not 60: the platform kills a function at its maxDuration
// (60s, vercel.json), and a call that would sleep past ~45s of waiting cannot
// also do its work inside what remains. Failing into ZohoLockedError hands the
// caller a 503 + Retry-After the client already knows how to retry — the honest
// outcome, where sleeping to the minute's end was a death sentence for a
// half-applied commit.
export const zoho = new ZohoClient({ maxWaitMs: 45_000 })
