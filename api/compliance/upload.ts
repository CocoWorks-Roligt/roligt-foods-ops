/**
 * The Compliance page's upload gate. The browser POSTs the file's NAME, TYPE
 * and SIZE here; this route checks the session and the caps, picks the object
 * key itself, and answers a presigned PUT URL for the private R2 bucket. The
 * browser then PUTs the bytes straight to Cloudflare — the API never carries
 * file traffic, so Vercel's ~4.5 MB request-body cap cannot bound a licence
 * scan, and the content type is signed into the URL, so R2 itself refuses an
 * upload claiming to be anything this route did not allow.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.js'
import { toWebRequest } from '../_lib/vercel.js'
import { presignR2Put, r2Configured } from '../_lib/r2.js'
import { COMPLIANCE_CONTENT_TYPES, COMPLIANCE_FILE_MAX_BYTES } from '../../src/lib/complianceRules.js'

type Body = {
  fileName?: string
  contentType?: string
  sizeInBytes?: number
}

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!caller.permissions.includes('page.compliance')) {
      res.status(403).json({ error: 'You do not have permission to manage compliance documents.' })
      return
    }
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'Requests must be application/json.' })
      return
    }
    if (!r2Configured()) {
      res.status(503).json({ error: 'Document storage is not configured (R2 env missing).' })
      return
    }
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body
    const fileName = String(body?.fileName ?? '').trim()
    const fileContentType = String(body?.contentType ?? '').toLowerCase()
    const sizeInBytes = Number(body?.sizeInBytes)
    if (!fileName || fileName.length > 120) {
      res.status(400).json({ error: 'A file name is required.' })
      return
    }
    if (!COMPLIANCE_CONTENT_TYPES.includes(fileContentType as (typeof COMPLIANCE_CONTENT_TYPES)[number])) {
      res.status(400).json({ error: 'Only PDF or image files are allowed.' })
      return
    }
    if (!Number.isFinite(sizeInBytes) || sizeInBytes < 1 || sizeInBytes > COMPLIANCE_FILE_MAX_BYTES) {
      res.status(400).json({ error: 'File must be under 12 MB.' })
      return
    }

    // the route names the object, never the client — the download route's
    // compliance/ prefix guard stays meaningful
    const path = `compliance/${Date.now().toString(36)}-${safeName(fileName)}`
    const url = presignR2Put(path, fileContentType, { expiresInSec: 300 })
    res.status(200).json({ path, url, method: 'PUT', headers: { 'content-type': fileContentType } })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    console.error('[compliance/upload]', e)
    res.status(400).json({ error: 'The upload could not be authorized.' })
  }
}
