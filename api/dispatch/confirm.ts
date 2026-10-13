/**
 * POST /api/dispatch/confirm — the atomic pouch+carton transaction (contracts
 * §5, §3.3-9). The route is the thin adapter; api/_lib/dispatchConfirm.ts owns
 * the FEFO pick, the carton plan and the single atomic write.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { postAdapter, answer } from '../_lib/postRoutes.js'
import { confirmDispatch } from '../_lib/dispatchConfirm.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await postAdapter(req, res)
  if (!call) return
  try {
    const out = await confirmDispatch(call.d1, call.caller, call.body, call.key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    answer(res, e)
  }
}
