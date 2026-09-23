import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoLockedError } from './_lib/zoho.ts'
import { authenticate, AuthError } from './_lib/auth.ts'
import { readSnapshot } from './_lib/snapshot.ts'
import { zoho } from './_lib/shared.ts'
import { toWebRequest } from './_lib/vercel.ts'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    await authenticate(toWebRequest(req))
    const snap = await readSnapshot(zoho)
    res.status(200).json({ state: snap.state, revision: snap.revision })
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
