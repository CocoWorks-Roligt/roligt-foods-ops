/**
 * GET /api/auth/callback — the WorkOS redirect target. The authorization code
 * is exchanged server-side (the client secret never reaches the browser), the
 * session is sealed into the httpOnly cookie, and the user lands back on the
 * path that was sealed into the state at sign-in — re-validated site-relative
 * on the way out, since it is a redirect target. A failed exchange clears the
 * verifier cookie, logs the cause, and lands the browser back on the login
 * page: the only caller of this route is a redirect a human is riding, and the
 * common refusal (the ten-minute PKCE cookie outliving a slow password reset)
 * is cured by the sign-in click that waits there.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { admitAuth, clientIpOf } from '../_lib/authThrottle.js'
import { clearVerifierCookies, handleAuthCallback, workosConfigured } from '../_lib/session.js'
import { siteRelative, toWebRequest } from '../_lib/vercel.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  const retryAfter = admitAuth(clientIpOf(req.headers))
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json({ error: 'Too many auth requests — try again shortly.' })
    return
  }
  if (!workosConfigured()) {
    res.status(503).json({ error: 'Auth is not configured on the server.' })
    return
  }
  const query = new URL(req.url ?? '/', 'http://internal')
  const code = query.searchParams.get('code')
  const state = query.searchParams.get('state') ?? undefined
  const clearVerifier = async () => {
    if (!state) return
    try {
      const cookies = await clearVerifierCookies(toWebRequest(req), state)
      if (cookies.length) res.setHeader('Set-Cookie', cookies)
    } catch {
      // cleanup must never mask the original failure
    }
  }
  if (!code) {
    await clearVerifier()
    res.status(400).json({ error: 'Missing authorization code.' })
    return
  }
  try {
    const { returnPathname, setCookies } = await handleAuthCallback(toWebRequest(req), { code, state })
    res.setHeader('Location', siteRelative(returnPathname))
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies)
    res.status(302).end()
  } catch (e) {
    await clearVerifier()
    console.error(`auth callback refused: ${(e as Error).message}`)
    res.setHeader('Location', '/')
    res.status(302).end()
  }
}
