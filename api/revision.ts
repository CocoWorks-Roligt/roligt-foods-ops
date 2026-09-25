import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoLockedError } from './_lib/zoho.ts'
import { authenticate, AuthError } from './_lib/auth.ts'
import { readRevision } from './_lib/snapshot.ts'
import { zoho } from './_lib/shared.ts'
import { toWebRequest } from './_lib/vercel.ts'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    // The poll is the most common refresh trigger — its response must carry the
    // re-sealed session cookie even though the caller itself is discarded.
    const { setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    const revision = await readRevision(zoho)
    res.status(200).json({ revision })
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
