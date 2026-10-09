/**
 * The compliance register's D1 arm — plain documents rows, collection
 * 'compliance'.
 *
 * The register stood alone on Zoho because one more table in the sweep meant
 * one more read out of 26 a minute; D1 has no such budget, so the register is
 * just another collection — but still NOT a wire table: the client's state
 * never sees it, /api/compliance/* stays its only reader. Saves keep the
 * register's exact version discipline: the observed token's integer becomes
 * the guarded upsert's conflict condition, and the assert turns a lost race
 * into { saved: false } — the route's 409, the cron's swallow. A mark that
 * loses to a human edit is false, never an error.
 */
import { D1ApiError, type D1Client } from './d1.js'
import { COMPLIANCE } from './registry.js'
import { parseDocJson, sortComplianceRows, type ComplianceRow } from './compliance.js'
import { versionNumberOf, versionTokenOf } from './commitGates.js'
import { leadDaysFromConfig, planFromToken, type ComplianceStore, type StoredComplianceDoc } from './complianceStore.js'
import type { ComplianceDoc } from '../../src/lib/complianceRules.js'

interface Row {
  id?: unknown
  json?: unknown
  version?: unknown
}

const SQL_SELECT_ROWS = 'SELECT id, json, version FROM documents WHERE collection = ?'
const SQL_DELETE_ASSERT_HEAD = 'DELETE FROM _assert_changed'
const SQL_ASSERT = 'INSERT INTO _assert_changed VALUES (changes())'
const SQL_UPSERT_GUARDED = `INSERT INTO documents(collection, id, json, version, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at
  WHERE documents.version = ?`
const SQL_DELETE_ROW = 'DELETE FROM documents WHERE collection = ? AND id = ?'

/** The token a row's integer version composes — the client-visible grammar, no new source. */
const tokenOf = (id: string, version: unknown): string => versionTokenOf(id, Number(version) || 1)

/**
 * One guarded write: delete the assert head, upsert under the observed
 * version, assert the change — one atomic batch. A rival that moved the row
 * first trips the CHECK and surfaces as the provider's constraint error,
 * which is exactly the lost race both callers already know how to take.
 */
async function guardedWrite(d1: D1Client, doc: ComplianceDoc, observed: string): Promise<boolean> {
  const observedN = versionNumberOf(doc.id, observed) ?? 0
  try {
    await d1.batch([
      { sql: SQL_DELETE_ASSERT_HEAD },
      { sql: SQL_UPSERT_GUARDED, params: [COMPLIANCE, doc.id, JSON.stringify(doc), observedN + 1, new Date().toISOString(), observedN] },
      { sql: SQL_ASSERT },
    ])
    return true
  } catch (e) {
    if (e instanceof D1ApiError && /_assert_changed/i.test(e.message)) return false
    throw e
  }
}

export function d1ComplianceStore(d1: D1Client): ComplianceStore {
  return {
    async list(): Promise<ComplianceRow[]> {
      const rows = await d1.query<Row>(SQL_SELECT_ROWS, [COMPLIANCE])
      const out: ComplianceRow[] = []
      for (const r of rows) {
        const id = String(r.id ?? '')
        const doc = typeof r.json === 'string' ? parseDocJson(r.json) : null
        if (doc) out.push({ doc, version: tokenOf(id, r.version) })
      }
      return sortComplianceRows(out)
    },
    async fetch(id: string): Promise<StoredComplianceDoc | null> {
      const rows = await d1.query<Row>(`${SQL_SELECT_ROWS} AND id = ?`, [COMPLIANCE, id])
      const r = rows[0]
      if (!r) return null
      return { doc: typeof r.json === 'string' ? parseDocJson(r.json) : null, version: tokenOf(id, r.version), handle: String(r.id ?? '') }
    },
    async save(doc, observed) {
      const plan = planFromToken(doc.id, observed ?? '')
      if (!(await guardedWrite(d1, doc, observed ?? ''))) return { saved: false }
      return { saved: true, version: plan.next }
    },
    async remove(_id, handle) {
      // the register's deletes are admin actions against a row the caller just
      // read — an unconditional delete, and a rival's own delete in the window
      // is the outcome asked for, not a failure
      await d1.batch([{ sql: SQL_DELETE_ROW, params: [COMPLIANCE, handle] }])
    },
    async markSent(doc, observed) {
      return guardedWrite(d1, doc, observed)
    },
    async leadDays() {
      const rows = await d1.query<{ value?: unknown }>("SELECT value FROM meta WHERE setting = 'app_config'")
      return leadDaysFromConfig(typeof rows[0]?.value === 'string' ? rows[0].value : '{}')
    },
  }
}
