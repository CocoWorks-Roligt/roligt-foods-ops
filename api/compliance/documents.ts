/**
 * The Compliance page's data surface (its tick carries this API).
 *
 * GET lists the register; POST performs one action — save or remove. Saves run
 * through the same version discipline as commits: the client sends the Version
 * token it last saw as baseVersion, the pre-flight read compares it with the
 * row's stored token, and a mismatch refuses with the commit route's 409
 * 'changed' shape; the write itself is conditional on that token (versionPlan
 * + CAS), so a row moved in the window between read and write refuses the same
 * way. Every mutation writes its audit row and bumps the revision exactly the
 * way admin actions do, so the change reaches every client's Audit page on its
 * next poll. The documents table is not a synced collection — this route is
 * its only reader, and the snapshot sweep never spends a read on it.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.js'
import { ZohoApiError, ZohoCasConflictError } from '../_lib/zoho.js'
import { LockedError } from '../_lib/store.js'
import { zoho } from '../_lib/shared.js'
import { writeAdminAudit } from '../_lib/engine.js'
import { admitCommit } from '../_lib/commitThrottle.js'
import { versionPlan } from '../_lib/commit.js'
import { toWebRequest } from '../_lib/vercel.js'
import { canonicalDoc, carryReminderState, docFromRow, docTable, normalizeDocPayload, rowValues, rowVersion, rowsToDocs } from '../_lib/compliance.js'

type Body = {
  action?: 'save' | 'remove'
  doc?: unknown
  id?: string
  /** The Version token the client last saw for this row — required to win an edit. */
  baseVersion?: string
}

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!caller.permissions.includes('page.compliance')) {
      res.status(403).json({ error: 'You do not have permission to manage compliance documents.' })
      return
    }
    const table = docTable()

    if (req.method === 'GET') {
      res.status(200).json({ docs: rowsToDocs(table, await zoho.fetchAll(table.id)) })
      return
    }

    // same CSRF second line as the commit route: a text/plain form-stitched
    // body never reaches the parser
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'Requests must be application/json.' })
      return
    }
    let body: Body
    try {
      body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body
    } catch {
      res.status(400).json({ error: 'Malformed request body.' })
      return
    }

    // the commit throttle, shared on purpose: a compliance save spends the same
    // pre-flight read + write + audit + revision bump a commit does
    const wait = admitCommit(caller.email)
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait))
      res.status(429).json({ error: 'Too many changes in a row — try again in a moment.' })
      return
    }

    if (body?.action === 'save') {
      const normalized = normalizeDocPayload(body.doc)
      if ('error' in normalized) {
        res.status(400).json({ error: normalized.error })
        return
      }
      const incoming = normalized.doc
      const [stored] = await zoho.fetchByKeyIn(table.id, table.appId, [incoming.id])
      const storedDoc = stored ? docFromRow(table, stored) : null
      const storedVersion = stored ? rowVersion(table, stored) : ''
      const baseVersion = typeof body.baseVersion === 'string' ? body.baseVersion : null
      // the client's own precondition: it edited what it last saw, or refuses
      if (baseVersion !== null && baseVersion !== storedVersion) {
        res.status(409).json({
          error: 'This document was saved by someone else first — reload and re-apply your change.',
          conflicts: [{ id: incoming.id, kind: 'changed' }],
        })
        return
      }
      const doc = carryReminderState(incoming, storedDoc)
      doc.updatedAt = new Date().toISOString()
      doc.updatedBy = caller.email
      // idempotent retry: the row is already exactly this — no write, no audit
      if (storedDoc && canonicalDoc(storedDoc) === canonicalDoc(doc)) {
        res.status(200).json({ ok: true, doc: storedDoc, version: storedVersion })
        return
      }
      const plan = versionPlan(table, doc.id, stored)
      try {
        await zoho.upsertByKey(table.id, table.appId, doc.id, rowValues(table, doc, plan.stamp), plan.cas ?? undefined)
      } catch (e) {
        if (e instanceof ZohoCasConflictError) {
          res.status(409).json({
            error: 'This document was saved by someone else first — reload and re-apply your change.',
            conflicts: [{ id: doc.id, kind: 'changed' }],
          })
          return
        }
        throw e
      }
      await writeAdminAudit(zoho, caller, 'compliance document saved', doc.title, `expires ${doc.expiresOn ?? '—'}`)
      res.status(200).json({ ok: true, doc, version: plan.stamp })
      return
    }

    if (body?.action === 'remove') {
      const id = String(body.id ?? '').trim()
      if (!id || !/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) {
        res.status(400).json({ error: 'A document id is required.' })
        return
      }
      const [stored] = await zoho.fetchByKeyIn(table.id, table.appId, [id])
      // already gone — the outcome the caller asked for
      if (!stored) {
        res.status(200).json({ ok: true })
        return
      }
      const baseVersion = typeof body.baseVersion === 'string' ? body.baseVersion : null
      if (baseVersion !== null && baseVersion !== rowVersion(table, stored)) {
        res.status(409).json({
          error: 'This document was saved by someone else first — reload and re-apply your change.',
          conflicts: [{ id, kind: 'changed' }],
        })
        return
      }
      const storedDoc = docFromRow(table, stored)
      try {
        await zoho.deleteRecord(table.id, stored.recordID)
      } catch (e) {
        // a refusal is not proof the row is gone — only a confirming read may
        // decide (the same tolerance the commit engine's removes carry)
        if (!(e instanceof ZohoApiError)) throw e
        const survivors = await zoho.fetchByKeyIn(table.id, table.appId, [id])
        if (survivors.length) throw e
        console.warn(`[compliance/documents] ${id} vanished before its delete landed — skipped`)
      }
      await writeAdminAudit(
        zoho,
        caller,
        'compliance document removed',
        storedDoc?.title ?? id,
        `was expiring ${storedDoc?.expiresOn ?? '—'}`,
      )
      res.status(200).json({ ok: true })
      return
    }

    res.status(400).json({ error: 'Unknown action.' })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof LockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — nothing was changed. Try again shortly.' })
      return
    }
    console.error('[compliance/documents]', e)
    res.status(500).json({ error: 'The compliance change failed on the server — check the list before retrying.' })
  }
}
