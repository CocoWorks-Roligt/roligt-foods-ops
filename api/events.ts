/**
 * GET /api/events — the SSE live feed (ARCHITECTURE §5, contracts v1.2).
 * Any signed-in caller; the revision token is read from the D1 store the
 * rest of the B-endpoints share. The poll fallback is GET /api/revision.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdapter } from './_lib/postRoutes.js'
import { revisionStream } from './_lib/events.js'

export const maxDuration = 300

export default async function (req: VercelRequest, res: VercelResponse): Promise<void> {
  const call = await getAdapter(req, res)
  if (!call) return
  revisionStream(req, res, async () => {
    const rows = await call.d1.query<{ value: string }>(
      `SELECT value FROM meta WHERE setting = 'app_revision'`,
    )
    return rows[0]?.value ?? '0'
  })
}
