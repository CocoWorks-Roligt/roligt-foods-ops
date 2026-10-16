/**
 * The compliance register's store surface — the narrow contract its two routes
 * (documents.ts, remind.ts) need, behind one dispatch in engine.ts. The D1 arm
 * (d1Compliance.ts) serves the register as plain documents rows under
 * collection 'compliance'.
 *
 * The version grammar is shared, not reimplemented: the "<id>:<n>" token a
 * save carries composes through versionNumberOf/versionTokenOf (commitGates.ts)
 * — a parsable token CAS-guards on itself and stamps n+1; anything else is a
 * lazy first stamp with no guard. No extra read, no second source of the
 * grammar.
 */
import { versionNumberOf, versionTokenOf } from './commitGates.js'
import { DEFAULT_COMPLIANCE_LEAD_DAYS, type ComplianceDoc } from '../../src/lib/complianceRules.js'
import type { ComplianceRow } from './compliance.js'

/** versionPlan's decision from the token alone — same grammar, no record read. */
export function planFromToken(appId: string, storedToken: string): { expected: string | null; next: string } {
  const n = versionNumberOf(appId, storedToken)
  return n !== null ? { expected: storedToken, next: versionTokenOf(appId, n + 1) } : { expected: null, next: versionTokenOf(appId, 1) }
}

/** One register row as its reader needs it: the doc (null = unparsable payload), the
 *  client-visible "<id>:<n>" token, and the engine's own row handle (the business
 *  id on D1) — never serialized, only handed back. */
export interface StoredComplianceDoc {
  doc: ComplianceDoc | null
  version: string
  handle: string
}

export interface ComplianceStore {
  /** The register, soonest expiry first (sortComplianceRows order). */
  list(): Promise<ComplianceRow[]>
  /** One row by id — null when no row exists. */
  fetch(id: string): Promise<StoredComplianceDoc | null>
  /**
   * A save carrying the token it observed (null = the caller saw no row): a
   * rival write that landed in between answers { saved: false } — the route's
   * 409, the cron's swallow.
   */
  save(doc: ComplianceDoc, observed: string | null): Promise<{ saved: true; version: string } | { saved: false }>
  /** Remove a row by its handle — a rival's own delete in the window is the
   *  outcome the caller asked for, not a failure. */
  remove(id: string, handle: string): Promise<void>
  /** The cron's marker write — false when a human edit won the race (the email
   *  still went out; the edit is the newer truth). */
  markSent(doc: ComplianceDoc, observed: string): Promise<boolean>
  /** The reminder lead window, from the stored app_config. */
  leadDays(): Promise<number>
}

/** The lead window's guard, shared by the route and the cron: 0..365, default otherwise. */
export function leadDaysFromConfig(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { complianceLeadDays?: unknown }
    const n = Number(parsed.complianceLeadDays)
    return Number.isFinite(n) && n >= 0 && n <= 365 ? Math.floor(n) : DEFAULT_COMPLIANCE_LEAD_DAYS
  } catch {
    return DEFAULT_COMPLIANCE_LEAD_DAYS
  }
}
