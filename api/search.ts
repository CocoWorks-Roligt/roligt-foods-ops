/**
 * GET /api/search — the Ctrl/Cmd+K global search (contracts §5).
 * ?q= — grouped top hits per kind, page-withheld collections not searched.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, answer } from './_lib/postRoutes.js'
import { searchFor } from './_lib/traceSearch.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await getAdapter(req, res)
  if (!call) return
  try {
    const q = (req.query ?? {}) as Record<string, unknown>
    const out = await searchFor(call.d1, call.caller, q)
    res.status(200).json(out)
  } catch (e) {
    answer(res, e)
  }
}
