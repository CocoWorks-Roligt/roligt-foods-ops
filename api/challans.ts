/**
 * /api/challans — GET lists the register. The thin adapter; api/_lib/challans.ts
 * owns the verdicts. An agent's GET answers their own challans only.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter, answer } from './_lib/postRoutes.js'
import { listChallans } from './_lib/challans.js'

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'This endpoint answers GET.' })
    return
  }
  const call = await getAdapter(req, res)
  if (!call) return
  try {
    res.status(200).json(await listChallans(call.d1, call.caller))
  } catch (e) {
    answer(res, e)
  }
}
