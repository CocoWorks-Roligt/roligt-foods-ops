/**
 * Compliance documents — the pure rules behind the Compliance page and its
 * reminder cron. Isomorphic on purpose (compiled by the client build and the
 * api's nodenext build alike): the page and /api/compliance/* must agree on
 * what a document is, when one is due, and what the reminder says — so the
 * rules live here once, with no imports and no platform globals.
 *
 * Storage shape: the document rows live in the standalone Zoho "Compliance
 * Documents" table (NOT a synced collection — the snapshot sweep must stay
 * exactly 26 reads), the file bytes in a private Vercel Blob store, the
 * object key carried in the doc. Dates are plant-style date keys (YYYY-MM-DD)
 * and all day math is calendar arithmetic on those keys, never timezone math.
 */

export const DEFAULT_COMPLIANCE_LEAD_DAYS = 30

/** Mirrors the interim device store (src/lib/uploads.ts) so both paths admit the same files. */
export const COMPLIANCE_FILE_MAX_BYTES = 12 * 1024 * 1024
export const COMPLIANCE_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
] as const

/** The Blob path prefix this feature owns — /api/compliance/file serves nothing else. */
export const COMPLIANCE_PATH_PREFIX = 'compliance/'

export const COMPLIANCE_DOC_TYPES = [
  'license',
  'permit',
  'certificate',
  'registration',
  'insurance',
  'other',
] as const

export interface ComplianceFile {
  fileName: string
  /** Blob pathname under compliance/ — what the download link is minted from. */
  path: string
  uploadedAt: string
}

export interface ComplianceDoc {
  id: string
  title: string
  docType: string
  authority?: string
  identifier?: string
  /** Date keys, YYYY-MM-DD. */
  issuedOn?: string
  expiresOn?: string
  notes?: string
  /**
   * Who the single reminder email goes to. Required the moment expiresOn is set —
   * a document with a deadline always has somewhere to send its warning.
   */
  remindEmails: string[]
  file?: ComplianceFile
  /**
   * The expiresOn a reminder has already fired for. Renewal changes expiresOn,
   * the marker no longer equals it, and that mismatch IS the re-arm — no state
   * to reset by hand.
   */
  reminderSentFor?: string
  reminderSentAt?: string
  /** Server-stamped on every save. */
  updatedAt?: string
  updatedBy?: string
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Strict YYYY-MM-DD that is also a real calendar date (not 2026-02-31). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  // a rolled-over key (2026-02-31 → Mar 3) comes back with the wrong components
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
}

/**
 * Whole days from `from` to `to` (positive when `to` is later), on the calendar
 * and in no timezone — both keys were local days when they were typed in.
 * NaN when either key is not a date key; callers gate on isDateKey first.
 */
export function daysBetween(from: string, to: string): number {
  if (!isDateKey(from) || !isDateKey(to)) return NaN
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** Today as a date key in the plant's timezone (IST, fixed +05:30 — no DST to chase). */
export function todayKeyIST(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10)
}

/** Parse a free-typed recipient list: comma/semicolon/newline separated. */
export function parseEmails(input: string): string[] {
  const seen = new Set<string>()
  for (const raw of input.split(/[,;\n]/)) {
    const email = raw.trim().toLowerCase()
    if (email && EMAIL.test(email)) seen.add(email)
  }
  return [...seen]
}

/**
 * Everything both the form and the route check before a save. Returns the
 * first problem as a sentence, or null when the doc is sound.
 */
export function validateComplianceDoc(doc: ComplianceDoc): string | null {
  if (!doc.id || typeof doc.id !== 'string') return 'The document has no id.'
  if (!doc.title?.trim()) return 'Give the document a title.'
  if (doc.title.length > 120) return 'Keep the title within 120 characters.'
  if (typeof doc.docType !== 'string' || !doc.docType.trim() || doc.docType.length > 40) {
    return 'Pick a document type.'
  }
  if (doc.authority !== undefined && doc.authority.length > 120) return 'Keep the issuing authority within 120 characters.'
  if (doc.identifier !== undefined && doc.identifier.length > 120) return 'Keep the document number within 120 characters.'
  if (doc.issuedOn !== undefined && doc.issuedOn !== '' && !isDateKey(doc.issuedOn)) return 'Issued on must be a date (YYYY-MM-DD).'
  if (doc.expiresOn !== undefined && doc.expiresOn !== '' && !isDateKey(doc.expiresOn)) return 'Expiry date must be a date (YYYY-MM-DD).'
  if (
    doc.issuedOn && doc.expiresOn && isDateKey(doc.issuedOn) && isDateKey(doc.expiresOn) &&
    daysBetween(doc.issuedOn, doc.expiresOn) < 0
  ) {
    return 'Expiry date cannot be before the issue date.'
  }
  if (doc.expiresOn && (!Array.isArray(doc.remindEmails) || doc.remindEmails.length === 0)) {
    return 'A document with an expiry date needs at least one reminder email.'
  }
  if (!Array.isArray(doc.remindEmails)) return 'Reminder emails are missing.'
  if (doc.remindEmails.length > 8) return 'Keep the reminder list within 8 addresses.'
  for (const email of doc.remindEmails) {
    if (typeof email !== 'string' || !EMAIL.test(email)) return `"${String(email)}" is not an email address.`
  }
  if (doc.notes !== undefined && doc.notes.length > 2000) return 'Keep the notes within 2000 characters.'
  if (doc.file) {
    if (!doc.file.fileName?.trim() || doc.file.fileName.length > 120) return 'The file name is missing or too long.'
    if (!doc.file.path?.startsWith(COMPLIANCE_PATH_PREFIX) || doc.file.path.includes('..')) {
      return 'The file reference is not a compliance attachment.'
    }
  }
  return null
}

/**
 * A document is due for its reminder when it expires within the lead window
 * (a past expiry that was never reminded still counts — it gets its one
 * catch-up email, worded as expired), someone is listening, and the reminder
 * for THIS expiry has not already gone out.
 */
export function isDue(doc: ComplianceDoc, todayKey: string, leadDays: number): boolean {
  if (!doc.expiresOn || !isDateKey(doc.expiresOn)) return false
  if (!doc.remindEmails?.length) return false
  if (doc.reminderSentFor === doc.expiresOn) return false
  return daysBetween(todayKey, doc.expiresOn) <= leadDays
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

export function reminderSubject(doc: ComplianceDoc): string {
  const expired = daysBetween(todayKeyIST(), doc.expiresOn ?? '') < 0
  return `${expired ? 'Expired' : 'Expiring soon'}: ${doc.title} (${doc.expiresOn})`
}

/** The single reminder email. Small, plain, everything escaped — titles are free text. */
export function reminderHtml(doc: ComplianceDoc): string {
  const left = daysBetween(todayKeyIST(), doc.expiresOn ?? '')
  const when = left < 0 ? `expired ${-left} day${-left === 1 ? '' : 's'} ago` : `expires in ${left} day${left === 1 ? '' : 's'}`
  const rows: [string, string | undefined][] = [
    ['Document', doc.title],
    ['Type', doc.docType],
    ['Issuing authority', doc.authority],
    ['Document number', doc.identifier],
    ['Expiry date', doc.expiresOn],
  ]
  const body = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#555">${k}</td><td style="padding:2px 0"><strong>${escapeHtml(String(v))}</strong></td></tr>`)
    .join('')
  return (
    `<p>This document ${escapeHtml(when)}.</p>` +
    `<table style="border-collapse:collapse;font-size:14px">${body}</table>` +
    `<p style="margin-top:16px">Renew it, then update the record on the <a href="/">Compliance page</a> so the next expiry is watched.</p>`
  )
}
