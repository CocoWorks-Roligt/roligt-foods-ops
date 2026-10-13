/**
 * GET /api/genealogy — the traceability walk (contracts §5, ARCHITECTURE §4).
 * ?seed=LOT:…|RUN:…|ORD:…&dir=forward|backward&depth=N (default 5, max 12).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, answer } from './_lib/postRoutes.js'
import { genealogyOf } from './_lib/traceSearch.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await getAdapter(req, res)
  if (!call) return
  try {
    const q = (req.query ?? {}) as Record<string, unknown>
    const out = await genealogyOf(call.d1, call.caller, q)
    res.status(200).json(out)
  } catch (e) {
    answer(res, e)
  }
}
