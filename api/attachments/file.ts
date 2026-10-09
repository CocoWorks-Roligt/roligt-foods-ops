/**
 * The download gate for record attachments. The key must be one of ours
 * (attachments/<qc|pod>/…) and the caller must hold the area's page — so the
 * route can never become an oracle for compliance/ or another area's objects.
 * What the caller gets is a 302 to a short-lived presigned GET; the bytes
 * stream straight from R2. The app fetches through the redirect and opens the
 * bytes itself (the signed URL carries an attachment disposition, which would
 * otherwise turn a click on a lab report into a download).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.js'
import { toWebRequest } from '../_lib/vercel.js'
import { presignR2Get, r2Configured } from '../_lib/r2.js'
import { attachmentPermissionFor } from '../../src/lib/attachmentRules.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    const path = typeof req.query?.path === 'string' ? req.query.path : ''
    const permission = attachmentPermissionFor(path)
    if (!permission) {
      res.status(400).json({ error: 'Not an attachment key.' })
      return
    }
    if (!caller.permissions.includes(permission)) {
      res.status(403).json({ error: 'You do not have permission to open this file.' })
      return
    }
    if (!r2Configured()) {
      res.status(503).json({ error: 'Attachment storage is not configured (R2 env missing).' })
      return
    }
    res.setHeader('Location', presignR2Get(path, { expiresInSec: 120 }))
    res.setHeader('Cache-Control', 'private, no-cache')
    res.status(302).end()
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    console.error('[attachments/file]', e)
    res.status(500).json({ error: 'The file could not be opened.' })
  }
}
