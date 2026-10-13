/**
 * POST /api/grading — staged grading (pipeline flag; contracts §5). The route
 * is the thin adapter; api/_lib/gradingPost.ts owns the verdict and the single
 * atomic write.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { postAdapter, answer } from './_lib/postRoutes.js'
import { stagedGrading } from './_lib/gradingPost.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await postAdapter(req, res)
  if (!call) return
  try {
    const out = await stagedGrading(call.d1, call.caller, call.body, call.key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    answer(res, e)
  }
}
