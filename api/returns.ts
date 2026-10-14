/**
 * /api/returns — POST records one return (the agent whose trip it was, the
 * board, or the dispatch desk). The thin adapter; api/_lib/returns.ts owns
 * the verdicts.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { postAdapter, answer } from './_lib/postRoutes.js'
import { createReturn } from './_lib/returns.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await postAdapter(req, res)
  if (!call) return
  try {
    const out = await createReturn(call.d1, call.caller, call.body, call.key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    answer(res, e)
  }
}
