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
 * The generated schema (baseSchema.ts) is pinned to one base: BASE_ID was baked in by
 * scripts/zoho/gen-base-schema.mjs from whatever .env pointed at *then*. A half-done
 * base flip — schema regenerated but .env not switched, or the reverse — would send
 * scratch table ids at production (or vice versa) with no error anywhere. So the
 * client is only constructed after assertBaseMatch agrees that .env and the generated
 * schema name the same base; a mismatch throws loudly at boot with both ids.
 */
import { ZohoClient } from './zoho.ts'
import { BASE_ID } from './baseSchema.ts'

/**
 * Throw when env names a different base than the generated schema was built for.
 * Empty values stay allowed: no ZOHO_BASE_ID (client falls back) and empty BASE_ID
 * (tests, pre-generation) are not a mismatch.
 */
export function assertBaseMatch(env: { ZOHO_BASE_ID?: string | undefined }, baseId: string = BASE_ID): void {
  const envBase = env.ZOHO_BASE_ID
  if (envBase && baseId && envBase !== baseId) {
    throw new Error(
      `generated schema is for base ${baseId} but ZOHO_BASE_ID is ${envBase} — regenerate or fix .env ` +
        `(scripts/zoho/gen-base-schema.mjs)`,
    )
  }
}

assertBaseMatch(process.env)

export const zoho = new ZohoClient()
