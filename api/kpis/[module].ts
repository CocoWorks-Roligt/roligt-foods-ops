/**
 * GET /api/kpis/:module — the one aggregation layer (ARCHITECTURE §6,
 * contracts §KPI). ?from/&to= (ISO days) window, default trailing six months.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, answer } from '../_lib/postRoutes.js'
import { kpisFor } from '../_lib/kpis.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await getAdapter(req, res)
  if (!call) return
  try {
    const q = (req.query ?? {}) as Record<string, unknown>
    const out = await kpisFor(call.d1, call.caller, String(q.module ?? ''), q)
    res.status(200).json(out)
  } catch (e) {
    answer(res, e)
  }
}
