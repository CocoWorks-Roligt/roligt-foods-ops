/**
 * The per-caller snapshot throttle — an in-memory token bucket keyed by email,
 * the read-side twin of commitThrottle.
 *
 * A snapshot read is the other thing a tight client loop can spend the plant's
 * one shared Zoho read budget on (26/min): every warm miss is a criteria read,
 * every moved revision a full sweep, so a broken or crafted retry loop against
 * /api/snapshot burns what the whole floor shares. The honest client cannot
 * trip it — boot is two calls, the 20s poll is one revision read plus a
 * snapshot only when the revision moved, ~3/min on the busiest plant — so
 * sustained 6/min with a burst of 12 (a reload and its redirect inside one
 * minute) is headroom everywhere except a loop. A fresh process starts a caller
 * at one sustained minute's worth — the full burst is earned by idleness, never
 * granted cold — and a refusal answers 429 with Retry-After, which the poll's
 * catch swallows and boot retries on its own; nothing is lost, only delayed.
 *
 * In-memory only, per warm instance — the same accepted interim as the Zoho
 * budget and the commit throttle beside it (the audit's S2-5 note): instances
 * fan out, so this caps ONE device against ONE instance, not the fleet. The
 * shared-budget work that finishes that is the audit's Phase 4.
 */
const SUSTAINED_PER_MIN = 6
const BURST = 12
const REFILL_MS = 60_000 / SUSTAINED_PER_MIN // one token every 10 s

interface Bucket {
  tokens: number
  readAt: number
}

const buckets = new Map<string, Bucket>()

/** Test hook — every caller starts clean, whatever earlier tests spent. */
export function __resetSnapshotThrottle(): void {
  buckets.clear()
}

/**
 * Admits one snapshot read for the caller. Returns 0 when admitted; otherwise
 * the whole seconds until one token exists — the Retry-After — and nothing is
 * spent.
 */
export function admitSnapshot(email: string, now: number = Date.now()): number {
  const bucket = buckets.get(email) ?? { tokens: SUSTAINED_PER_MIN, readAt: now }
  bucket.tokens = Math.min(BURST, bucket.tokens + (now - bucket.readAt) / REFILL_MS)
  bucket.readAt = now
  buckets.set(email, bucket)
  if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) * REFILL_MS) / 1000)
  bucket.tokens -= 1
  return 0
}
