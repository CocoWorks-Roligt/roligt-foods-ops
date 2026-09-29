import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoLockedError } from './_lib/zoho.js'
import { authenticate, AuthError } from './_lib/auth.js'
import { readSnapshotCached } from './_lib/snapshot.js'
import { zoho } from './_lib/shared.js'
import { toWebRequest } from './_lib/vercel.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    // The 200 body carries the caller's permissions so a snapshot refresh also
    // propagates permission changes without a reload (AppContext feeds them on).
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    const snap = await readSnapshotCached(zoho)
    res.status(200).json({ state: snap.state, revision: snap.revision, permissions: caller.permissions })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof ZohoLockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — try again shortly.' })
      return
    }
    res.status(503).json({ error: (e as Error).message })
  }
}
