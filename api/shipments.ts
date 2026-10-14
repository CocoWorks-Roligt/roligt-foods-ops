/**
 * /api/shipments — POST creates a trip (Idempotency-Key), GET lists. The thin
 * adapters; api/_lib/shipments.ts owns the verdicts. An agent's GET answers
 * their own trips only (RBAC.md §a).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, postAdapter, answer } from './_lib/postRoutes.js'
import { createShipment, listShipments } from './_lib/shipments.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET') {
    const call = await getAdapter(req, res)
    if (!call) return
    try {
      res.status(200).json(await listShipments(call.d1, call.caller))
    } catch (e) {
      answer(res, e)
    }
    return
  }
  const call = await postAdapter(req, res)
  if (!call) return
  try {
    const out = await createShipment(call.d1, call.caller, call.body, call.key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    answer(res, e)
  }
}
