/**
 * GET /api/exports/:report?format=csv|xlsx|pdf&from=&to= — the export engine's
 * thin adapter (contracts §exports). Small answers stream the bytes with the
 * freshness stamped into response headers (the contracts' streamed-file rule);
 * large answers mint a job row and answer 202 with it.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, answer } from '../_lib/postRoutes.js'
import { exportFor } from '../_lib/exports.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await getAdapter(req, res)
  if (!call) return
  try {
    const q = (req.query ?? {}) as Record<string, unknown>
    const verdict = await exportFor(call.d1, call.caller, String(q.report ?? ''), q)
    if (verdict.kind === 'job') {
      res.status(verdict.status).json(verdict.job)
      return
    }
    res.setHeader('Content-Type', verdict.file.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${verdict.filename}"`)
    res.setHeader('X-Last-Updated', verdict.lastUpdated)
    res.setHeader('X-Stale-After', String(verdict.staleAfterSec))
    res.status(200).end(verdict.file.bytes)
  } catch (e) {
    answer(res, e)
  }
}
