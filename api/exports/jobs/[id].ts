/**
 * GET /api/exports/jobs/:id — poll a large export. The first poll does the
 * compute (nothing idles between polls, serverless-honest); ready answers
 * carry the presigned, expiring downloadUrl.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, answer } from '../../_lib/postRoutes.js'
import { getExportJob } from '../../_lib/exports.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await getAdapter(req, res)
  if (!call) return
  try {
    const q = (req.query ?? {}) as Record<string, unknown>
    res.status(200).json(await getExportJob(call.d1, call.caller, String(q.id ?? '')))
  } catch (e) {
    answer(res, e)
  }
}
