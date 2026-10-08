/**
 * The Compliance page's download gate. The permission check happens here, in
 * front of the store; the path is guarded to this feature's own prefix so the
 * route can never be turned into an oracle for another feature's objects.
 * What the caller gets is a 302 to a short-lived presigned GET — the bytes
 * stream straight from R2, with an attachment disposition baked into the URL
 * so the browser saves the document instead of rendering it, and the URL is
 * worthless within minutes.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.js'
import { toWebRequest } from '../_lib/vercel.js'
import { presignR2Get, r2Configured } from '../_lib/r2.js'
import { COMPLIANCE_PATH_PREFIX } from '../../src/lib/complianceRules.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!caller.permissions.includes('page.compliance')) {
      res.status(403).json({ error: 'You do not have permission to open compliance documents.' })
      return
    }
    const path = typeof req.query?.path === 'string' ? req.query.path : ''
    if (!path.startsWith(COMPLIANCE_PATH_PREFIX) || path.includes('..')) {
      res.status(400).json({ error: 'Not a compliance attachment.' })
      return
    }
    if (!r2Configured()) {
      res.status(503).json({ error: 'Document storage is not configured (R2 env missing).' })
      return
    }
    const url = presignR2Get(path, { expiresInSec: 120 })
    res.setHeader('Location', url)
    res.setHeader('Cache-Control', 'private, no-cache')
    res.status(302).end()
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    console.error('[compliance/file]', e)
    res.status(500).json({ error: 'The file could not be opened.' })
  }
}
