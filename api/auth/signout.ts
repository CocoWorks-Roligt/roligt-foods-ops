/**
 * POST /api/auth/signout — end the session at WorkOS (which hosts the logout
 * page and returns to a registered post-logout redirect: our origin root) and
 * clear the local session cookie. With no readable session the cookie is still
 * cleared and the browser lands on '/', where the SPA shows the login screen.
 *
 * POST-only: the session cookie is SameSite=Lax, which rides a top-level GET
 * navigation — so while this answered GETs, a link on any other site could end
 * the operator's session for them (logout CSRF). Lax never accompanies a
 * cross-site POST, and the SPA's sign-out navigates through a synthetic form
 * POST, so nothing honest is lost by refusing every other verb.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { admitAuth, clientIpOf } from '../_lib/authThrottle.js'
import { signOutUrl } from '../_lib/session.js'
import { toWebRequest } from '../_lib/vercel.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  const retryAfter = admitAuth(clientIpOf(req.headers))
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json({ error: 'Too many auth requests — try again shortly.' })
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ error: 'Sign-out is POST-only.' })
    return
  }
  try {
    const { logoutUrl, setCookies } = await signOutUrl(toWebRequest(req))
    res.setHeader('Location', logoutUrl ?? '/')
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies)
    res.status(302).end()
  } catch (e) {
    console.error('[auth/signout]', e)
    res.status(500).json({ error: 'Sign-out failed — try again.' })
  }
}
