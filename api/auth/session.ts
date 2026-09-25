/**
 * GET /api/auth/session — who the cookie says is signed in, for the SPA's one
 * boot fetch: { user: { email }, permissions } or 401. Unconfigured, the route
 * answers the dev session when ALLOW_DEV_SESSION=1 allows it (the same x-dev-role
 * header the picker sends) and 503 otherwise — an honest deploy-mismatch signal
 * rather than a login that can never succeed.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError, devCaller, devSessionAllowed } from '../_lib/auth.ts'
import { workosConfigured } from '../_lib/session.ts'
import { toWebRequest } from '../_lib/vercel.ts'

export default async function (req: VercelRequest, res: VercelResponse) {
  if (!workosConfigured()) {
    if (devSessionAllowed()) {
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
