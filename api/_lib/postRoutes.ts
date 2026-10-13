/**
 * The B3 route adapters — the thin waist every dedicated endpoint shares:
 * authenticate, the POST contract (JSON content-type, parseable body, an
 * Idempotency-Key), then the service's verdict. Error mapping is one ladder
 * (answer/errorBody): DomainError → its status as an ApiError, auth/lock
 * shapes the api/ routes already answer with. Routes are always mounted; the
 * flag a service rides is judged inside the service (ARCHITECTURE §7).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate, AuthError, type Caller } from './auth.js'
import { LockedError } from './store.js'
import { d1 } from './shared.js'
import { toWebRequest } from './vercel.js'
import { errorBody } from './domain.js'
import { requireIdempotencyKey } from './idempotency.js'
import type { D1Client } from './d1.js'

/** What a POST route hands its service. */
export interface PostCall {
  d1: D1Client
  caller: Caller
  body: unknown
  key: string
}

/** The POST half of the shared adapter — the contract, then auth. */
export async function postAdapter(req: VercelRequest, res: VercelResponse): Promise<PostCall | null> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'This endpoint answers POST.' })
    return null
  }
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    res.status(415).json({ error: 'This request must be application/json.' })
    return null
  }
  let body: unknown
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    res.status(400).json({ error: 'Malformed request body.' })
    return null
  }
  try {
    const key = requireIdempotencyKey(req.headers)
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!d1) {
      res.status(503).json({ error: 'This endpoint needs the D1 store, which is not configured.' })
      return null
    }
    return { d1, caller, body, key }
  } catch (e) {
    answer(res, e)
    return null
  }
}

/** The shared error ladder — one answer shape across the B3 routes. */
export function answer(res: VercelResponse, e: unknown): void {
  if (e instanceof AuthError) {
    res.status(401).json({ error: e.message })
    return
  }
  if (e instanceof LockedError) {
    res.setHeader('Retry-After', String(e.retryAfterSec))
    res.status(503).json({ error: 'The store is rate-limited — nothing was written. Try again shortly.' })
    return
  }
  const { status, body } = errorBody(e)
  res.status(status).json(body)
}

/** What a GET route hands its service. */
export interface GetCall {
  d1: D1Client
  caller: Caller
}

/** The GET half — auth, then the store check. */
export async function getAdapter(req: VercelRequest, res: VercelResponse): Promise<GetCall | null> {
  try {
    const { caller, setCookies } = await authenticate(toWebRequest(req))
    if (setCookies) res.setHeader('Set-Cookie', setCookies)
    if (!d1) {
      res.status(503).json({ error: 'This endpoint needs the D1 store, which is not configured.' })
      return null
    }
    return { d1, caller }
  } catch (e) {
    answer(res, e)
    return null
  }
}
