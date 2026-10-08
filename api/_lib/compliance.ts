/**
 * The standalone register behind the Compliance page — licenses, permits and
 * certificates with expiry reminders.
 *
 * The rows live in the Zoho "Compliance Documents" table, which is NOT a synced
 * collection and NOT in TABLE_FOR: the snapshot sweep must stay exactly 26
 * reads, so /api/compliance/* is the only reader and it fetches on demand (the
 * shape the planned Books integration documented first). Writes carry the same
 * "<AppID>:<n>" Version token the commit engine uses — versionPlan is shared,
 * not reimplemented — so a compliance save conflicts the same way a commit
 * does when another device moved the row first.
 *
 * The doc itself is the Data JSON payload; Title and Expires On exist as plain
 * text columns for reading the table by eye in the Zoho UI. Never add an
 * attachment column to this table — a string there makes Zoho silently drop
 * every field after it in the same upsert (see mappers.ts). The file bytes
 * live in the private Vercel Blob store; the doc carries the object key.
 */
import { T, type TableRef } from './baseSchema.js'
import type { ZohoRecord } from './zoho.js'
import { columnsByFieldId } from './commit.js'
import { validateComplianceDoc, type ComplianceDoc } from '../../src/lib/complianceRules.js'

export function docTable(): TableRef {
  const table = T['Compliance Documents']
  if (!table) {
    throw new Error(
      'The Compliance Documents table is missing from this base\'s schema — run scripts/zoho/topup.mjs for the base, commit the regenerated api/_lib/baseSchema.ts, and redeploy.',
    )
  }
  return table
}

export interface ComplianceRow {
  doc: ComplianceDoc
  /** The row's current Version token — the baseVersion a save must carry to prove it saw the latest. */
  version: string
}

/** The doc inside a row, or null for a hand-staged row with no parsable Data JSON. */
export function docFromRow(table: TableRef, row: ZohoRecord): ComplianceDoc | null {
  if (!table.dataJson) return null
  const raw = row.data[table.dataJson]
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw) as ComplianceDoc
    return parsed && typeof parsed.id === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function rowVersion(table: TableRef, row: ZohoRecord): string {
  const versionFieldId = table.fields['Version'] ?? ''
  return versionFieldId ? String(row.data[versionFieldId] ?? '') : ''
}

export function rowsToDocs(table: TableRef, rows: ZohoRecord[]): ComplianceRow[] {
  const out: ComplianceRow[] = []
  for (const row of rows) {
    const doc = docFromRow(table, row)
    if (doc) out.push({ doc, version: rowVersion(table, row) })
  }
  // soonest expiry first, undated documents after those, expired before upcoming
  out.sort((a, b) => {
    const ak = a.doc.expiresOn ?? '9999-12-31'
    const bk = b.doc.expiresOn ?? '9999-12-31'
    return ak === bk ? a.doc.title.localeCompare(b.doc.title) : ak < bk ? -1 : 1
  })
  return out
}

/**
 * The canonical doc from an untrusted payload: known fields only, in a fixed
 * order, lengths capped. Reminder state (reminderSentFor/At) is deliberately
 * NOT taken from the wire — the cron owns it, and a save carries the stored
 * row's markers forward instead (carryReminderState).
 */
export function normalizeDocPayload(payload: unknown): { doc: ComplianceDoc } | { error: string } {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const text = (v: unknown, max: number): string | undefined => {
    if (typeof v !== 'string') return undefined
    const s = v.trim()
    return s ? s.slice(0, max) : undefined
  }
  const doc: ComplianceDoc = {
    id: text(p.id, 64) ?? '',
    title: text(p.title, 120) ?? '',
    docType: text(p.docType, 40) ?? '',
    authority: text(p.authority, 120),
    identifier: text(p.identifier, 120),
    issuedOn: text(p.issuedOn, 10),
    expiresOn: text(p.expiresOn, 10),
    notes: text(p.notes, 2000),
    remindEmails: Array.isArray(p.remindEmails)
      ? [...new Set(p.remindEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
      : [],
  }
  const f = p.file as Record<string, unknown> | undefined
  if (f && typeof f === 'object') {
    doc.file = { fileName: text(f.fileName, 120) ?? '', path: text(f.path, 300) ?? '', uploadedAt: text(f.uploadedAt, 40) ?? '' }
  }
  // the id is a Zoho criteria value — refuse anything the key path cannot carry
  if (doc.id && !/^[A-Za-z0-9_.:-]{1,64}$/.test(doc.id)) return { error: 'That document id is not one this app minted.' }
  const problem = validateComplianceDoc(doc)
  return problem ? { error: problem } : { doc }
}

/** A doc through the canonicalizer — the shape two docs must both be in to compare. */
export function canonicalDoc(doc: ComplianceDoc): string {
  const normalized = normalizeDocPayload(doc)
  return 'doc' in normalized ? JSON.stringify(normalized.doc) : JSON.stringify(doc)
}

/** The stored row's reminder markers ride a save forward — renewal still re-arms (the marker stops matching). */
export function carryReminderState(next: ComplianceDoc, stored: ComplianceDoc | null): ComplianceDoc {
  if (!stored) return next
  return { ...next, reminderSentFor: stored.reminderSentFor, reminderSentAt: stored.reminderSentAt }
}

/** The patch the cron writes after a reminder goes out. */
export function markSentPatch(doc: ComplianceDoc): ComplianceDoc {
  return { ...doc, reminderSentFor: doc.expiresOn, reminderSentAt: new Date().toISOString() }
}

/** The Zoho write shape: App ID + Data JSON + the two eye-readable columns + the Version stamp. */
export function rowValues(table: TableRef, doc: ComplianceDoc, stamp: string): Record<string, unknown> {
  const values: Record<string, unknown> = {
    [table.appId]: doc.id,
    ...(table.dataJson ? { [table.dataJson]: JSON.stringify(doc) } : {}),
    ...columnsByFieldId(table, { Title: doc.title, 'Expires On': doc.expiresOn ?? '' }),
  }
  const versionFieldId = table.fields['Version'] ?? ''
  if (stamp && versionFieldId) values[versionFieldId] = stamp
  return values
}
