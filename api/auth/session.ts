/**
 * GET /api/auth/session — who the cookie says is signed in, for the SPA's one
 * boot fetch: { user: { email }, permissions } or 401. Unconfigured, the route
 * answers the dev session when ALLOW_DEV_SESSION=1 allows it AND the request's
 * host is a dev host (loopback or ALLOW_DEV_HOSTS — the same gate
 * authenticate() applies) and 503 otherwise — an honest deploy-mismatch signal
 * rather than a login that can never succeed.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError, devCaller, devHostAllowed, devSessionAllowed } from '../_lib/auth.js'
import { workosConfigured } from '../_lib/session.js'
import { toWebRequest } from '../_lib/vercel.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  if (!workosConfigured()) {
    // the same host gate authenticate() applies — the flag licenses the
    // process, never a plant domain
    const forwarded = req.headers['x-forwarded-host'] ?? req.headers['host']
    const host = Array.isArray(forwarded) ? forwarded[0] : forwarded
    if (devSessionAllowed() && devHostAllowed(host)) {
      const caller = devCaller(req.headers['x-dev-role'])
      res.status(200).json({ user: { email: caller.email }, permissions: caller.permissions, dev: true })
      return
    }
    res.status(503).json({ error: 'Auth is not configured on the server.' })
    return
  }
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    res.status(200).json({ user: { email: caller.email }, permissions: caller.permissions })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    res.status(401).json({ error: 'Sign in first.' })
  }
}
