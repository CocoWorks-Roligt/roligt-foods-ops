/**
 * The store seam — one error shape and one switch, so the routes never learn
 * which engine answered.
 *
 * The app's whole error ladder for "the store is temporarily unavailable" is
 * ZohoLockedError's shape (a retryAfterSec that becomes 503 + Retry-After, the
 * one header the offline client honors). D1 gets the same parent class, and
 * ZohoLockedError becomes a subclass — every existing `instanceof` catch keeps
 * working during the transition once it catches the parent.
 *
 * Which engine serves is an environment fact (D1_DATABASE_ID present ⇒ D1);
 * the shared instances and the selector live in shared.ts, which owns every
 * client construction (this module must stay import-light for both engines).
 */
import type { ZohoClient } from './zoho.js'
import type { D1Client } from './d1.js'

/** The store is busy/throttled — retry after this many seconds (503 + Retry-After). */
export class LockedError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterSec = 60, message = 'The store is rate-limited — try again shortly.') {
    super(message)
    this.retryAfterSec = retryAfterSec
  }
}

export type Store = ZohoClient | D1Client

/** True when the D1 engine serves this deployment (the cutover switch). Not
 *  named useD1 — the `use` prefix reads as a React hook to the react-hooks
 *  lint rule, and this predicate has nothing to do with hooks. */
export function d1Enabled(): boolean {
  return Boolean(process.env.D1_DATABASE_ID && process.env.D1_API_TOKEN && process.env.D1_ACCOUNT_ID)
}
