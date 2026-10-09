/**
 * The compliance register's store seam — the narrow surface its two routes
 * (documents.ts, remind.ts) need, behind one dispatch in engine.ts.
 *
 * The Zoho arm wraps the EXACT calls the routes made before the seam existed —
 * same methods, same arguments, same order — so the route contract and the
 * tests that pin it (world.upserts, world.deletes) stand untouched. The D1
 * arm (d1Compliance.ts) serves the register as plain documents rows under
 * collection 'compliance': the 26-read constraint that kept this table
 * standalone was Zoho's, and it dies with that engine.
 *
 * The version grammar is shared, not reimplemented: versionPlan needs a
 * ZohoRecord to look at, but all it ever reads from it is the Version token —
 * so planFromToken takes the token string alone and reproduces versionPlan's
 * decision exactly (a parsable "<id>:<n>" CAS-guards on itself and stamps n+1;
 * anything else is a lazy first stamp with no guard). No extra read, no second
 * source of the grammar.
 */
import { T } from './baseSchema.js'
import type { ZohoClient } from './zoho.js'
import { ZohoApiError, ZohoCasConflictError } from './zoho.js'
import { docFromRow, docTable, rowValues, rowVersion, rowsToDocs, type ComplianceRow } from './compliance.js'
import { versionNumberOf, versionTokenOf } from './commitGates.js'
import { DEFAULT_COMPLIANCE_LEAD_DAYS, type ComplianceDoc } from '../../src/lib/complianceRules.js'

/** versionPlan's decision from the token alone — same grammar, no record read. */
export function planFromToken(appId: string, storedToken: string): { expected: string | null; next: string } {
  const n = versionNumberOf(appId, storedToken)
  return n !== null ? { expected: storedToken, next: versionTokenOf(appId, n + 1) } : { expected: null, next: versionTokenOf(appId, 1) }
}

/** One register row as its reader needs it: the doc (null = unparsable payload), the
 *  client-visible "<id>:<n>" token, and the engine's own row handle (Zoho's
 *  recordID; the business id on D1) — never serialized, only handed back. */
export interface StoredComplianceDoc {
  doc: ComplianceDoc | null
  version: string
  handle: string
}

export interface ComplianceStore {
  /** The register, soonest expiry first (rowsToDocs order). */
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

/**
 * The Zoho arm — the routes' own calls, verbatim. The delete's confirming-read
 * tolerance and the mark's CAS swallow moved in here with them: they are
 * engine semantics (what a refusal means), not route logic.
 */
export function zohoComplianceStore(zoho: ZohoClient): ComplianceStore {
  const table = docTable()
  const casFor = (plan: { expected: string | null }) => {
    const versionFieldId = table.fields['Version'] ?? ''
    return plan.expected !== null && versionFieldId ? { versionFieldId, expected: plan.expected } : undefined
  }
  return {
    async list() {
      return rowsToDocs(table, await zoho.fetchAll(table.id))
    },
    async fetch(id) {
      const [row] = await zoho.fetchByKeyIn(table.id, table.appId, [id])
      if (!row) return null
      return { doc: docFromRow(table, row), version: rowVersion(table, row), handle: row.recordID }
    },
    async save(doc, observed) {
      const plan = planFromToken(doc.id, observed ?? '')
      try {
        await zoho.upsertByKey(table.id, table.appId, doc.id, rowValues(table, doc, plan.next), casFor(plan))
      } catch (e) {
        if (e instanceof ZohoCasConflictError) return { saved: false }
        throw e
      }
      return { saved: true, version: plan.next }
    },
    async remove(id, handle) {
      try {
        await zoho.deleteRecord(table.id, handle)
      } catch (e) {
        // a refusal is not proof the row is gone — only a confirming read may decide
        if (!(e instanceof ZohoApiError)) throw e
        const survivors = await zoho.fetchByKeyIn(table.id, table.appId, [id])
        if (survivors.length) throw e
        console.warn(`[compliance] ${id} vanished before its delete landed — skipped`)
      }
    },
    async markSent(doc, observed) {
      const plan = planFromToken(doc.id, observed)
      try {
        await zoho.upsertByKey(table.id, table.appId, doc.id, rowValues(table, doc, plan.next), casFor(plan))
        return true
      } catch (e) {
        if (e instanceof ZohoCasConflictError) return false
        throw e
      }
    },
    async leadDays() {
      return readLeadDaysZoho(zoho)
    },
  }
}

/** The lead window from the Config table's app_config row — default when unset or malformed. */
async function readLeadDaysZoho(zoho: ZohoClient): Promise<number> {
  const cfg = T['Config']
  const rows = await zoho.fetchAll(cfg.id)
  const row = rows.find((r) => r.data[cfg.fields['Setting']] === 'app_config')
  if (!row) return DEFAULT_COMPLIANCE_LEAD_DAYS
  return leadDaysFromConfig(String(row.data[cfg.fields['Value']] ?? '{}'))
}

/** The lead window's guard, shared by both engines: 0..365, default otherwise. */
export function leadDaysFromConfig(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { complianceLeadDays?: unknown }
    const n = Number(parsed.complianceLeadDays)
    return Number.isFinite(n) && n >= 0 && n <= 365 ? Math.floor(n) : DEFAULT_COMPLIANCE_LEAD_DAYS
  } catch {
    return DEFAULT_COMPLIANCE_LEAD_DAYS
  }
}
