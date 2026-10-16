/**
 * The per-caller commit throttle — an in-memory token bucket keyed by email.
 *
 * Commits serialize through the engine queue (engine.ts) and each spends the
 * store's attention on a preflight read and an atomic batch, so one
 * misbehaving device must not be able to starve the queue for everyone: a
 * tight retry loop on one tab would spend it whatever the server did with the
 * individual requests. Sustained 8 commits/min per caller, burst 16. A fresh
 * process starts a caller at one sustained minute's worth — the full burst is
 * earned by idleness, never granted cold — and a refused commit answers 429
 * with Retry-After, the same shape the store lock's 503 already carries, so
 * the device's work stays local and the next poll retries it.
 *
 * In-memory only, per warm instance: serverless instances come and go, and a bucket
 * resetting on a cold start is one minute of grace, not a hole — the engine queue's
 * serialization remains the hard wall, and this exists so no single device is the
 * one who keeps it full. Dev sessions share one email; they share one origin too.
 */
const SUSTAINED_PER_MIN = 8
const BURST = 16
const REFILL_MS = 60_000 / SUSTAINED_PER_MIN // one token every 7.5 s

interface Bucket {
  tokens: number
  readAt: number
}

const buckets = new Map<string, Bucket>()

/** Test hook — every caller starts clean, whatever earlier tests spent. */
export function __resetCommitThrottle(): void {
  buckets.clear()
}

/**
 * Admits one commit for the caller. Returns 0 when admitted; otherwise the whole
 * seconds until one token exists — the Retry-After — and nothing is spent.
 */
export function admitCommit(email: string, now: number = Date.now()): number {
  const bucket = buckets.get(email) ?? { tokens: SUSTAINED_PER_MIN, readAt: now }
  bucket.tokens = Math.min(BURST, bucket.tokens + (now - bucket.readAt) / REFILL_MS)
  bucket.readAt = now
  buckets.set(email, bucket)
  if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) * REFILL_MS) / 1000)
  bucket.tokens -= 1
  return 0
}
