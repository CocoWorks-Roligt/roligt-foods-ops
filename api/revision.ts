import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoLockedError } from './_lib/zoho.js'
import { authenticate, AuthError } from './_lib/auth.js'
import { readRevisionMemoized } from './_lib/snapshot.js'
import { zoho } from './_lib/shared.js'
import { toWebRequest } from './_lib/vercel.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    // The poll is the most common refresh trigger — its response must carry the
    // re-sealed session cookie even though the caller itself is discarded.
    const { setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    // Memoized + single-flighted: every client polls every 20s, and polls that
    // land within a few seconds of each other share one Zoho read instead of
    // each spending budget the sweep and commit paths need.
    const revision = await readRevisionMemoized(zoho)
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
    console.error('[revision]', e)
    res.status(503).json({ error: 'The revision could not be read — try again shortly.' })
  }
}
