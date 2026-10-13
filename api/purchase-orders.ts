/**
 * /api/purchase-orders — POST creates (Idempotency-Key), GET lists. The thin
 * adapters; api/_lib/purchaseOrders.ts owns the verdicts.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, postAdapter, answer } from './_lib/postRoutes.js'
import { createPurchaseOrder, listPurchaseOrders } from './_lib/purchaseOrders.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET') {
    const call = await getAdapter(req, res)
    if (!call) return
    try {
      res.status(200).json(await listPurchaseOrders(call.d1, call.caller))
    } catch (e) {
      answer(res, e)
    }
    return
  }
  const call = await postAdapter(req, res)
  if (!call) return
  try {
    const out = await createPurchaseOrder(call.d1, call.caller, call.body, call.key)
    if (out.replay) res.setHeader('Idempotency-Replayed', 'true')
    res.status(out.status).json(out.body)
  } catch (e) {
    answer(res, e)
  }
}
