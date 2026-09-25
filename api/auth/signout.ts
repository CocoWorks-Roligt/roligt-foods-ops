/**
 * GET /api/auth/signout — end the session at WorkOS (which hosts the logout
 * page and returns to a registered post-logout redirect: our origin root) and
 * clear the local session cookie. With no readable session the cookie is still
 * cleared and the browser lands on '/', where the SPA shows the login screen.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { signOutUrl } from '../_lib/session.ts'
import { toWebRequest } from '../_lib/vercel.ts'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { logoutUrl, setCookies } = await signOutUrl(toWebRequest(req))
    res.setHeader('Location', logoutUrl ?? '/')
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies)
    res.status(302).end()
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}
