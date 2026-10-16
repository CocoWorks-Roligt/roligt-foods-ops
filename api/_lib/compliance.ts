/**
 * The register behind the Compliance page — licenses, permits and certificates
 * with expiry reminders.
 *
 * The rows live as plain documents rows under collection 'compliance' (not a
 * synced collection, never a wire table): /api/compliance/* is the only reader
 * and it fetches on demand. Writes carry the same "<id>:<n>" Version token the
 * commit engine uses — the grammar is shared (commitGates.ts), so a compliance
 * save conflicts the same way a commit does when another device moved the row
 * first. The file bytes live in R2; the doc carries the object key.
 */
import { validateComplianceDoc, type ComplianceDoc } from '../../src/lib/complianceRules.js'

export interface ComplianceRow {
  doc: ComplianceDoc
  /** The row's current Version token — the baseVersion a save must carry to prove it saw the latest. */
  version: string
}

/**
 * A stored document string → the doc, or null. A hand-staged or unparsable
 * payload is never a conflict, just not a document.
 */
export function parseDocJson(raw: string): ComplianceDoc | null {
  try {
    const parsed = JSON.parse(raw) as ComplianceDoc
    return parsed && typeof parsed.id === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Soonest expiry first, undated documents after those, expired before upcoming. */
export function sortComplianceRows<T extends ComplianceRow>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    const ak = a.doc.expiresOn ?? '9999-12-31'
    const bk = b.doc.expiresOn ?? '9999-12-31'
    return ak === bk ? a.doc.title.localeCompare(b.doc.title) : ak < bk ? -1 : 1
  })
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
  // the id rides into SQL parameters and version tokens — refuse anything the
  // key path cannot carry
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
