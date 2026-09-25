/**
 * GET /api/auth/start — the sign-in door. Everything the SPA needs to begin a
 * login is a link here: it answers a 302 to the hosted AuthKit page (themed
 * with our branding from the WorkOS dashboard) with the PKCE verifier cookie
 * set. The organization id is passed so sessions carry role claims from the
 * one "Roligt Foods" organization, and ?return= is validated site-relative so
 * a crafted link can never become an open redirect.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createSignInUrl, workosConfigured } from '../_lib/session.ts'
import { siteRelative, toWebRequest } from '../_lib/vercel.ts'

export default async function (req: VercelRequest, res: VercelResponse) {
  if (!workosConfigured()) {
    res
      .status(503)
      .json({ error: 'Auth is not configured on the server (WORKOS_CLIENT_ID / WORKOS_API_KEY / WORKOS_COOKIE_PASSWORD).' })
    return
  }
  try {
    const query = new URL(req.url ?? '/', 'http://internal')
    const { url, setCookies } = await createSignInUrl(toWebRequest(req), {
      returnPathname: siteRelative(query.searchParams.get('return')),
      ...(process.env.WORKOS_ORG_ID ? { organizationId: process.env.WORKOS_ORG_ID } : {}),
    })
    res.setHeader('Location', url)
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies)
    res.status(302).end()
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}
