/**
 * The store seam — one error shape, so the routes never learn how the store
 * answered. The app's whole error ladder for "the store is temporarily
 * unavailable" is LockedError's shape (a retryAfterSec that becomes 503 +
 * Retry-After, the one header the offline client honors).
 *
 * D1 is the only store since the Zoho engine's deletion (2026-10-16); which
 * deployment has it is an environment fact (the three D1_* keys). The shared
 * instance and the selector live in shared.ts, which owns client construction.
 */
import type { D1Client } from './d1.js'

/** The store is busy/throttled — retry after this many seconds (503 + Retry-After). */
export class LockedError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterSec = 60, message = 'The store is rate-limited — try again shortly.') {
    super(message)
    this.retryAfterSec = retryAfterSec
  }
}

export type Store = D1Client

/** True when this deployment has the D1 store configured. The gated endpoints'
 *  503 (postRoutes) reads this; the core routes refuse through requireStore
 *  (engine.ts) when it is false. Not named useD1 — the `use` prefix reads as a
 *  React hook to the react-hooks lint rule, and this predicate has nothing to
 *  do with hooks. */
export function d1Enabled(): boolean {
  return Boolean(process.env.D1_DATABASE_ID && process.env.D1_API_TOKEN && process.env.D1_ACCOUNT_ID)
}
