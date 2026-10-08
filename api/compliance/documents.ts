/**
 * The Compliance page's data surface (its tick carries this API).
 *
 * GET lists the register; POST performs one action — save or remove. Saves run
 * through the same version discipline as commits: the client sends the Version
 * token it last saw as baseVersion, the pre-flight read compares it with the
 * row's stored token, and a mismatch refuses with the commit route's 409
 * 'changed' shape; the write itself is conditional on that token, so a row
 * moved in the window between read and write refuses the same way. Every
 * mutation writes its audit row and bumps the revision exactly the way admin
 * actions do, so the change reaches every client's Audit page on its next
 * poll. The register is not a synced collection — this route is its only
 * reader, and the snapshot sweep never spends a read on it; which store serves
 * it is the engine seam's business (complianceStore.ts), not this route's.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.js'
import { LockedError } from '../_lib/store.js'
import { store } from '../_lib/shared.js'
import { complianceStore, writeAdminAudit } from '../_lib/engine.js'
import { admitCommit } from '../_lib/commitThrottle.js'
import { toWebRequest } from '../_lib/vercel.js'
import { canonicalDoc, carryReminderState, normalizeDocPayload } from '../_lib/compliance.js'

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
    const cs = complianceStore(store)

    if (req.method === 'GET') {
      res.status(200).json({ docs: await cs.list() })
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
      const stored = await cs.fetch(incoming.id)
      const storedDoc = stored?.doc ?? null
      const storedVersion = stored?.version ?? ''
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
      const outcome = await cs.save(doc, stored ? storedVersion : null)
      if (!outcome.saved) {
        res.status(409).json({
          error: 'This document was saved by someone else first — reload and re-apply your change.',
          conflicts: [{ id: doc.id, kind: 'changed' }],
        })
        return
      }
      await writeAdminAudit(store, caller, 'compliance document saved', doc.title, `expires ${doc.expiresOn ?? '—'}`)
      res.status(200).json({ ok: true, doc, version: outcome.version })
      return
    }

    if (body?.action === 'remove') {
      const id = String(body.id ?? '').trim()
      if (!id || !/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) {
        res.status(400).json({ error: 'A document id is required.' })
        return
      }
      const stored = await cs.fetch(id)
      // already gone — the outcome the caller asked for
      if (!stored) {
        res.status(200).json({ ok: true })
        return
      }
      const baseVersion = typeof body.baseVersion === 'string' ? body.baseVersion : null
      if (baseVersion !== null && baseVersion !== stored.version) {
        res.status(409).json({
          error: 'This document was saved by someone else first — reload and re-apply your change.',
          conflicts: [{ id, kind: 'changed' }],
        })
        return
      }
      await cs.remove(id, stored.handle)
      await writeAdminAudit(
        store,
        caller,
        'compliance document removed',
        stored.doc?.title ?? id,
        `was expiring ${stored.doc?.expiresOn ?? '—'}`,
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
      res.status(503).json({ error: 'The store is rate-limited — nothing was changed. Try again shortly.' })
      return
    }
    console.error('[compliance/documents]', e)
    res.status(500).json({ error: 'The compliance change failed on the server — check the list before retrying.' })
  }
}
