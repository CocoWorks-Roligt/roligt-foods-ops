import type { VercelRequest, VercelResponse } from '@vercel/node'
import { LockedError } from './_lib/store.js'
import { authenticate, AuthError } from './_lib/auth.js'
import { commitChanges, Conflict, Forbidden, Malformed, validateChanges } from './_lib/engine.js'
import { RulesRejected } from './_lib/rulesGate.js'
import { admitCommit } from './_lib/commitThrottle.js'
import { store } from './_lib/shared.js'
import { toWebRequest } from './_lib/vercel.js'
import type { StateChanges } from '../src/lib/sync.js'

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    // CSRF, second line: the session cookie's SameSite=Lax is the first, and a
    // legacy WebView that ignores it can stitch valid JSON through a
    // text/plain form (Vercel hands text/plain through as a string body, which
    // the parse below would happily take). An HTML form can only send
    // urlencoded, multipart or text/plain; a cross-origin fetch that does send
    // application/json triggers a preflight this origin never grants — so
    // requiring the content-type closes the vector.
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'Commit payloads must be application/json.' })
      return
    }
    let body: { changes?: StateChanges }
    try {
      body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { changes?: StateChanges }
    } catch {
      res.status(400).json({ error: 'Malformed commit payload.' })
      return
    }
    if (!body?.changes?.tables) {
      res.status(400).json({ error: 'Malformed commit payload.' })
      return
    }
    const invalid = validateChanges(body.changes)
    if (invalid) {
      res.status(400).json({ error: invalid })
      return
    }
    // The store's write budget is not one device's to drain: a tight retry loop on
    // one tab could spend it whatever the server did. Refused before any read,
    // with the same Retry-After shape the 503 carries — the work stays on the
    // device and the next poll retries it.
    const retryAfterSec = admitCommit(caller.email)
    if (retryAfterSec > 0) {
      res.setHeader('Retry-After', String(retryAfterSec))
      res.status(429).json({ error: 'Too many commits from this account — the change is still saved on this device and will retry.' })
      return
    }
    const { token: revision, versions } = await commitChanges(store, caller, body.changes)
    // A D1 write is its own invalidation: the revision token the commit minted
    // feeds the read memos inside the same atomic batch (noteD1Revision), so
    // there is no cache to evict here — a no-op commit never moved the token
    // and needs nothing either.
    //
    // The written rows' CAS versions ride along so the saving client can stamp
    // its own copy — see CommitResult.
    res.status(200).json({ revision, ...(versions ? { versions } : {}) })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof Malformed) {
      res.status(400).json({ error: e.message })
      return
    }
    if (e instanceof Forbidden) {
      res.status(403).json({ error: e.message, table: e.table })
      return
    }
    if (e instanceof Conflict) {
      // Refused whole, before any write: the rows the caller based their work
      // on have moved. The client adopts the winning versions by these names.
      res.status(409).json({ error: e.message, conflicts: e.conflicts })
      return
    }
    if (e instanceof RulesRejected) {
      // A flag-gated rule refused the commit (the audit row is already filed
      // by the engine); the ApiError shape carries the stable code the UI
      // branches on (contracts §5 — a GuardKey, or 'lot_not_released').
      res.status(422).json({ error: e.message, code: e.code })
      return
    }
    if (e instanceof LockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'The store is rate-limited — the change is saved on this device and will retry.' })
      return
    }
    // The detail is ours, not the caller's — D1ApiError carries slices of the
    // raw upstream response. Logged server-side.
    console.error('[commit]', e)
    res.status(500).json({ error: 'The save failed on the server — it is still saved on this device and will retry.' })
  }
}
