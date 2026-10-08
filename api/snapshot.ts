import type { VercelRequest, VercelResponse } from '@vercel/node'
import { LockedError } from './_lib/store.js'
import { authenticate, AuthError } from './_lib/auth.js'
import { admitSnapshot } from './_lib/snapshotThrottle.js'
import { projectSnapshot } from './_lib/snapshot.js'
import { readSnapshotCached } from './_lib/engine.js'
import { store } from './_lib/shared.js'
import { toWebRequest } from './_lib/vercel.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    // The 200 body carries the caller's permissions so a snapshot refresh also
    // propagates permission changes without a reload (AppContext feeds them on).
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    // The read-side twin of the commit throttle: a snapshot spend is shared
    // plant budget (a warm miss is a criteria read, a moved revision a full
    // sweep), so it is refused per caller BEFORE any read is spent, with the
    // same Retry-After shape the commit throttle and the Zoho lock carry.
    const retryAfterSec = admitSnapshot(caller.email)
    if (retryAfterSec > 0) {
      res.setHeader('Retry-After', String(retryAfterSec))
      res.status(429).json({ error: 'Too many snapshot reads from this account — try again shortly.' })
      return
    }
    const snap = await readSnapshotCached(store)
    // Read-side authorization (the audit's S2-6): the substrate is assembled
    // once per revision and shared by every caller, so the projection to THIS
    // caller's pages happens here, per request — the tables they may not see
    // are dropped and named in `withheld`, which the client honors by leaving
    // its own mirror copies of those tables untouched (sync.ts restoreWithheld).
    const { state, revision, withheld } = projectSnapshot(snap, caller.permissions)
    res.status(200).json({ state, revision, permissions: caller.permissions, withheld })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof LockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — try again shortly.' })
      return
    }
    // Generic to the caller, detailed in the server log — upstream error text
    // names bases, tables and internals.
    console.error('[snapshot]', e)
    res.status(503).json({ error: 'The snapshot could not be read — try again shortly.' })
  }
}
