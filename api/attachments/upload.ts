/**
 * The upload gate for record attachments — QC lab reports and dispatch
 * proof-of-delivery photos. The browser POSTs the object key, the file's name,
 * type and size; this route checks the session, the key and the caps, and
 * answers a presigned PUT URL for the private R2 bucket. The bytes then go
 * straight from the browser to Cloudflare — the API never carries file traffic.
 *
 * Unlike /api/compliance/upload, the CLIENT names the object here, on purpose:
 * the QC row or dispatch has to carry its key while the device is offline, so
 * the key is minted on the device (src/lib/attachmentRules.ts) and arrives
 * already stored in a record. What keeps that safe is the grammar — the key
 * must be attachments/<qc|pod>/<one safe segment> — and the area's page
 * permission, so the gate can never be pointed at compliance/ or another
 * area's objects. The key is checked before the permission because the
 * permission is derived from it.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../_lib/auth.js'
import { toWebRequest } from '../_lib/vercel.js'
import { presignR2Put, r2Configured } from '../_lib/r2.js'
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_FILE_MAX_BYTES,
  attachmentPermissionFor,
} from '../../src/lib/attachmentRules.js'

type Body = {
  path?: string
  fileName?: string
  contentType?: string
  sizeInBytes?: number
}

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'Requests must be application/json.' })
      return
    }
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body
    const path = String(body?.path ?? '')
    const permission = attachmentPermissionFor(path)
    if (!permission) {
      res.status(400).json({ error: 'Not an attachment key.' })
      return
    }
    if (!caller.permissions.includes(permission)) {
      res.status(403).json({ error: 'You do not have permission to attach files here.' })
      return
    }
    if (!r2Configured()) {
      res.status(503).json({ error: 'Attachment storage is not configured (R2 env missing).' })
      return
    }
    const fileName = String(body?.fileName ?? '').trim()
    const contentType = String(body?.contentType ?? '').toLowerCase()
    const sizeInBytes = Number(body?.sizeInBytes)
    if (!fileName || fileName.length > 120) {
      res.status(400).json({ error: 'A file name is required.' })
      return
    }
    if (!ATTACHMENT_CONTENT_TYPES.includes(contentType as (typeof ATTACHMENT_CONTENT_TYPES)[number])) {
      res.status(400).json({ error: 'Only PDF or image files are allowed.' })
      return
    }
    if (!Number.isFinite(sizeInBytes) || sizeInBytes < 1 || sizeInBytes > ATTACHMENT_FILE_MAX_BYTES) {
      res.status(400).json({ error: 'File must be under 12 MB.' })
      return
    }

    const url = presignR2Put(path, contentType, { expiresInSec: 300 })
    res.status(200).json({ path, url, method: 'PUT', headers: { 'content-type': contentType } })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    console.error('[attachments/upload]', e)
    res.status(400).json({ error: 'The upload could not be authorized.' })
  }
}
