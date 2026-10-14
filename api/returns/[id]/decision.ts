/**
 * POST /api/returns/:id/decision — QC's verdict on a return: coldroom,
 * quarantine or writeoff. Same contract as the submit route: the POST waist
 * opened up for the :id.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../../_lib/auth.js'
import { LockedError } from '../../_lib/store.js'
import { d1 } from '../../_lib/shared.js'
import { toWebRequest } from '../../_lib/vercel.js'
import { errorBody } from '../../_lib/domain.js'
import { requireIdempotencyKey } from '../../_lib/idempotency.js'
import { decideReturn } from '../../_lib/returns.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'This endpoint answers POST.' })
    return
  }
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    res.status(415).json({ error: 'This request must be application/json.' })
    return
  }
  let body: unknown
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    res.status(400).json({ error: 'Malformed request body.' })
    return
  }
  try {
    const key = requireIdempotencyKey(req.headers)
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!d1) {
      res.status(503).json({ error: 'This endpoint needs the D1 store, which is not configured.' })
      return
    }
    const id = String(req.query?.id ?? '')
    const out = await decideReturn(d1, caller, id, body, key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof LockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'The store is rate-limited — nothing was written. Try again shortly.' })
      return
    }
    const { status, body: error } = errorBody(e)
    res.status(status).json(error)
  }
}
