/**
 * The compliance reminder cron — the repo's first scheduled job.
 *
 * vercel.json fires this daily (09:00 IST); Vercel attaches
 * "Authorization: Bearer <CRON_SECRET>" to every cron invocation when the env
 * var is set, and the timing-safe compare below is the whole auth story — no
 * session, no operator, one shared secret. A manual hit with the same header
 * (curl, the post-deploy smoke) is indistinguishable and safe: the run is
 * idempotent per document, because a sent reminder marks the expiry it fired
 * for and that mark is what "due" checks.
 *
 * Budget: exactly two reads (Config for the lead window, the documents table)
 * plus at most one write per due document and one audit row + revision bump —
 * and the audit only when something was actually sent, so a quiet day spends
 * nothing but the reads. Each send marks its document only AFTER the email
 * provider answered 2xx; a refusal or a crash leaves the marker unset and the
 * next run retries. A concurrent human edit that wins the CAS on the mark is
 * swallowed on purpose — the email already went out, the edit is the newer
 * truth, and the marker rides the stale token only until tomorrow's run
 * re-evaluates the renewed row.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { zoho } from '../_lib/shared.js'
import { T } from '../_lib/baseSchema.js'
import { writeAdminAudit } from '../_lib/engine.js'
import { versionPlan } from '../_lib/commit.js'
import { ZohoCasConflictError } from '../_lib/zoho.js'
import { LockedError } from '../_lib/store.js'
import { docFromRow, docTable, markSentPatch, rowValues } from '../_lib/compliance.js'
import { sendMail } from '../_lib/mailer.js'
import {
  DEFAULT_COMPLIANCE_LEAD_DAYS,
  isDue,
  reminderHtml,
  reminderSubject,
  todayKeyIST,
  type ComplianceDoc,
} from '../../src/lib/complianceRules.js'

/** Hash-then-compare: equal length by construction, no early exit on bytes. */
function bearerOk(header: string, secret: string): boolean {
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
  const received = createHash('sha256').update(header).digest()
  return timingSafeEqual(received, expected)
}

/** The lead window from the Config table's app_config row — default when unset or malformed. */
async function readLeadDays(): Promise<number> {
  const cfg = T['Config']
  const rows = await zoho.fetchAll(cfg.id)
  const row = rows.find((r) => r.data[cfg.fields['Setting']] === 'app_config')
  if (!row) return DEFAULT_COMPLIANCE_LEAD_DAYS
  try {
    const parsed = JSON.parse(String(row.data[cfg.fields['Value']] ?? '{}')) as { complianceLeadDays?: unknown }
    const n = Number(parsed.complianceLeadDays)
    return Number.isFinite(n) && n >= 0 && n <= 365 ? Math.floor(n) : DEFAULT_COMPLIANCE_LEAD_DAYS
  } catch {
    return DEFAULT_COMPLIANCE_LEAD_DAYS
  }
}

export default async function (req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[compliance/remind] CRON_SECRET is not set — the cron route refuses to run open.')
    res.status(500).json({ error: 'The reminder job is not configured.' })
    return
  }
  if (!bearerOk(String(req.headers?.authorization ?? ''), secret)) {
    res.status(401).json({ error: 'Unauthorized.' })
    return
  }
  try {
    const table = docTable()
    const [leadDays, rows] = await Promise.all([readLeadDays(), zoho.fetchAll(table.id)])
    const today = todayKeyIST()
    const due: { doc: ComplianceDoc; record: (typeof rows)[number] }[] = []
    for (const record of rows) {
      const doc = docFromRow(table, record)
      if (doc && isDue(doc, today, leadDays)) due.push({ doc, record })
    }

    let sent = 0
    let failed = 0
    for (const { doc, record } of due) {
      try {
        await sendMail({
          to: doc.remindEmails,
          subject: reminderSubject(doc),
          html: reminderHtml(doc),
          replyTo: process.env.MAIL_REPLY_TO,
        })
      } catch (e) {
        failed++
        console.error('[compliance/remind] reminder failed for', doc.id, e)
        continue // unmarked — the next run retries this document
      }
      const plan = versionPlan(table, doc.id, record)
      try {
        await zoho.upsertByKey(table.id, table.appId, doc.id, rowValues(table, markSentPatch(doc), plan.stamp), plan.cas ?? undefined)
        sent++
      } catch (e) {
        if (e instanceof ZohoCasConflictError) {
          sent++
          console.warn('[compliance/remind] the marker lost a race with an edit for', doc.id, '— the next run re-evaluates the saved row')
          continue
        }
        throw e
      }
    }

    // the trail row is worth having, not worth failing the run over — the
    // markers are already landed and the mail server keeps its own delivery log
    if (sent > 0) {
      try {
        await writeAdminAudit(
          zoho,
          { email: 'compliance-reminders', permissions: [] },
          'compliance reminders sent',
          `${sent} of ${due.length} due`,
          due.map(({ doc }) => doc.title).join(', ').slice(0, 500),
        )
      } catch (e) {
        console.warn('[compliance/remind] the audit row failed to land:', e)
      }
    }
    res.status(200).json({ ok: true, due: due.length, sent, failed })
  } catch (e) {
    if (e instanceof LockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — the next scheduled run retries.' })
      return
    }
    console.error('[compliance/remind]', e)
    res.status(500).json({ error: 'The reminder run failed — already-sent reminders are marked; the rest retry next run.' })
  }
}
