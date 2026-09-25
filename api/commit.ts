import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoLockedError } from './_lib/zoho.ts'
import { authenticate, AuthError } from './_lib/auth.ts'
import { commitChanges, Forbidden } from './_lib/commit.ts'
import { invalidateSnapshotCache } from './_lib/snapshot.ts'
import { zoho } from './_lib/shared.ts'
import { toWebRequest } from './_lib/vercel.ts'
import type { StateChanges } from '../src/lib/sync.ts'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { changes?: StateChanges }
    if (!body?.changes?.tables) {
      res.status(400).json({ error: 'Malformed commit payload.' })
      return
    }
    const revision = await commitChanges(zoho, caller, body.changes)
    // This process has now changed the base with its own hands — anything it
    // cached about the old plant is spent, even though the revision moved too.
    invalidateSnapshotCache()
    res.status(200).json({ revision })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof Forbidden) {
      res.status(403).json({ error: e.message, table: e.table })
      return
    }
    if (e instanceof ZohoLockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — the change is saved on this device and will retry.' })
      return
    }
    res.status(500).json({ error: (e as Error).message })
  }
}
