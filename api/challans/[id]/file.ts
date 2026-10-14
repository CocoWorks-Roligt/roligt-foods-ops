/**
 * GET /api/challans/:id/file — the download gate for a challan PDF: board
 * holders, or the agent whose challan it is. Answers a 302 to a short-lived
 * presigned GET (attachments/file.ts's pattern); the service renders and
 * uploads the PDF first when the object is missing — the lazy render.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError } from '../../_lib/auth.js'
import { toWebRequest } from '../../_lib/vercel.js'
import { d1 } from '../../_lib/shared.js'
import { errorBody } from '../../_lib/domain.js'
import { challanFileUrl } from '../../_lib/challans.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!d1) {
      res.status(503).json({ error: 'This endpoint needs the D1 store, which is not configured.' })
      return
    }
    const id = String(req.query?.id ?? '')
    const url = await challanFileUrl(d1, caller, id)
    res.setHeader('Location', url)
    res.setHeader('Cache-Control', 'private, no-cache')
    res.status(302).end()
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    const { status, body: error } = errorBody(e)
    res.status(status).json(error)
  }
}
