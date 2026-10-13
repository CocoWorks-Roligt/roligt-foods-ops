/**
 * POST /api/transformations/close — run close under the B2 guards (contracts
 * §5). The route is the thin adapter; api/_lib/closeRun.ts owns the verdict
 * and the single atomic write.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { postAdapter, answer } from '../_lib/postRoutes.js'
import { closeTransformation } from '../_lib/closeRun.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await postAdapter(req, res)
  if (!call) return
  try {
    const out = await closeTransformation(call.d1, call.caller, call.body, call.key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    answer(res, e)
  }
}
