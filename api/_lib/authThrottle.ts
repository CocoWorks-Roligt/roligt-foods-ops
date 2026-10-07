/**
 * The per-IP auth throttle — an in-memory token bucket keyed by client IP.
 *
 * Every /api/auth/* request runs the sealed-session KDF on whatever cookie
 * values arrive (unseal is the expensive part by design — it is the seal's
 * whole strength), and start/callback mint WorkOS flows, so an unthrottled
 * flood is cheap for the attacker and warm-expensive for the instance. Keyed
 * by IP, not email: these routes run BEFORE there is a caller. Sustained
 * 30/min per IP, burst 60 — generous on purpose, because a plant's floor
 * devices can share one NAT address and an honest device hits /api/auth a
 * handful of times per session (the app's 20s polls go to /api/revision, not
 * here). A refused request answers 429 with Retry-After, the same shape the
 * commit and snapshot throttles carry.
 *
 * In-memory only, per warm instance, exactly like commitThrottle: a bucket
 * resetting on a cold start is a minute of grace, not a hole.
 */
const SUSTAINED_PER_MIN = 30
const BURST = 60
const REFILL_MS = 60_000 / SUSTAINED_PER_MIN

interface Bucket {
  tokens: number
  readAt: number
}

const buckets = new Map<string, Bucket>()

/** Test hook — every address starts clean, whatever earlier tests spent. */
export function __resetAuthThrottle(): void {
  buckets.clear()
}

/**
 * Admits one auth request for the address. Returns 0 when admitted; otherwise
 * the whole seconds until one token exists — the Retry-After — and nothing is
 * spent.
 */
export function admitAuth(ip: string, now: number = Date.now()): number {
  const bucket = buckets.get(ip) ?? { tokens: SUSTAINED_PER_MIN, readAt: now }
  bucket.tokens = Math.min(BURST, bucket.tokens + (now - bucket.readAt) / REFILL_MS)
  bucket.readAt = now
  buckets.set(ip, bucket)
  if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) * REFILL_MS) / 1000)
  bucket.tokens -= 1
  return 0
}

/** The address a request came from — the first hop of the platform's forwarded
 *  chain. Behind the platform proxy that header is the proxy's own; absent it
 *  (direct dev traffic) the bare socket has nothing to read, so every such
 *  caller shares one bucket — the conservative direction. */
export function clientIpOf(headers: Headers | Record<string, unknown>): string {
  const fwd = headers instanceof Headers ? headers.get('x-forwarded-for') : headers['x-forwarded-for']
  const first = Array.isArray(fwd) ? fwd[0] : fwd
  return String(first ?? '').split(',')[0]!.trim() || 'unknown'
}
