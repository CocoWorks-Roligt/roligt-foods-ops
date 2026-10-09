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
 * Budget: exactly two reads (the lead window from config, the register) plus
 * at most one write per due document and one audit row + revision bump — and
 * the audit only when something was actually sent, so a quiet day spends
 * nothing but the reads. Each send marks its document only AFTER the email
 * provider answered 2xx; a refusal or a crash leaves the marker unset and the
 * next run retries. A concurrent human edit that wins the version race on the
 * mark is swallowed on purpose — the email already went out, the edit is the
 * newer truth, and the marker rides the stale token only until tomorrow's run
 * re-evaluates the renewed row. Which store serves the reads and the marks is
 * the engine seam's business (complianceStore.ts), not this route's.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { store } from '../_lib/shared.js'
import { complianceStore, writeAdminAudit } from '../_lib/engine.js'
import { LockedError } from '../_lib/store.js'
import { markSentPatch } from '../_lib/compliance.js'
import { sendMail } from '../_lib/mailer.js'
import {
  isDue,
  reminderHtml,
  reminderSubject,
  todayKeyIST,
} from '../../src/lib/complianceRules.js'

/** Hash-then-compare: equal length by construction, no early exit on bytes. */
function bearerOk(header: string, secret: string): boolean {
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
  const received = createHash('sha256').update(header).digest()
  return timingSafeEqual(received, expected)
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
    const cs = complianceStore(store)
    const [leadDays, rows] = await Promise.all([cs.leadDays(), cs.list()])
    const today = todayKeyIST()
    const due = rows.filter(({ doc }) => isDue(doc, today, leadDays))

    let sent = 0
    let failed = 0
    for (const { doc, version } of due) {
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
      sent++ // the email went out — the marker is bookkeeping, never a reason to refire
      const landed = await cs.markSent(markSentPatch(doc), version)
      if (!landed) {
        console.warn('[compliance/remind] the marker lost a race with an edit for', doc.id, '— the next run re-evaluates the saved row')
      }
    }

    // the trail row is worth having, not worth failing the run over — the
    // markers are already landed and the mail server keeps its own delivery log
    if (sent > 0) {
      try {
        await writeAdminAudit(
          store,
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
      res.status(503).json({ error: 'The store is rate-limited — the next scheduled run retries.' })
      return
    }
    console.error('[compliance/remind]', e)
    res.status(500).json({ error: 'The reminder run failed — already-sent reminders are marked; the rest retry next run.' })
  }
}
