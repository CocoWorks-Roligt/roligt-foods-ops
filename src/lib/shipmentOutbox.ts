/**
 * The delivery PWA's offline outbox (SHIPMENT S2).
 *
 * Attachment bytes already have their own device outbox (attachmentQueue.ts,
 * IndexedDB); this one is for the API intents — a `started` event posted in a
 * basement, a whole submit taken at a door with no bars. Each intent carries
 * the Idempotency-Key it was BORN with: the key is minted once, at enqueue,
 * so a retry hours later replays as the same intent on the server instead of
 * starting the trip twice or minting two challans.
 *
 * localStorage, not IndexedDB: the payloads are small JSON, the quota is
 * never in play, and a private-browsing refusal degrades to "no queue" —
 * the same honest fallow the attachment outbox has. Every read is wrapped:
 * a corrupt or absent store reads as an empty queue, never a crash.
 */

/** One queued API intent. The kind names the shipper; the body is the wire shape. */
export interface OutboxIntent {
  id: string
  kind: 'event' | 'submit'
  shipmentId: string
  /** The Idempotency-Key this intent was born with — minted once, never re-minted. */
  key: string
  body: Record<string, unknown>
  queuedAt: number
  attempts: number
  lastError?: string
}

const STORE_KEY = 'delivery-outbox-v1'

function read(): OutboxIntent[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as OutboxIntent[]) : []
  } catch {
    return []
  }
}

function write(items: readonly OutboxIntent[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items))
  } catch {
    // The device refuses to keep the queue (private browsing, quota) — the
    // calls that enqueued go straight through instead, as they always could.
  }
}

export function outboxAll(): readonly OutboxIntent[] {
  return read()
}

export function outboxFor(shipmentId: string): readonly OutboxIntent[] {
  return read().filter((i) => i.shipmentId === shipmentId)
}

/** Park an intent. The id is the caller's (kind + shipmentId is unique per
 *  screen: one submit per trip, one started per trip) so a double-tap adds
 *  nothing — the second enqueue is a no-op returning the standing intent. */
export function enqueueOutbox(intent: Omit<OutboxIntent, 'queuedAt' | 'attempts'>): OutboxIntent {
  const standing = read()
  const existing = standing.find((i) => i.id === intent.id)
  if (existing) return existing
  const full: OutboxIntent = { ...intent, queuedAt: Date.now(), attempts: 0 }
  write([...standing, full])
  return full
}

export function noteOutboxError(id: string, error: string): void {
  write(read().map((i) => (i.id === id ? { ...i, attempts: i.attempts + 1, lastError: error } : i)))
}

export function removeOutbox(id: string): void {
  write(read().filter((i) => i.id !== id))
}

/** True when the intent is the server's to keep as-is — a replay or a
 *  validation refusal never retries (the same body would refuse again). */
export function isFinalRefusal(error: string): boolean {
  return /already|replay|different request body|cannot|not on this trip|not_out/i.test(error)
}

/**
 * Ship everything, oldest first. `ship` returns true when the intent landed
 * (it is removed); false when it should stay. A throw stays too. The queue is
 * re-read between intents, so a screen adding work mid-flush is not lost.
 */
export async function flushOutbox(
  ship: (intent: OutboxIntent) => Promise<boolean>,
): Promise<{ shipped: number; remaining: number }> {
  let shipped = 0
  for (;;) {
    const next = read().sort((a, b) => a.queuedAt - b.queuedAt)[0]
    if (!next) break
    let landed: boolean
    try {
      landed = await ship(next)
    } catch (e) {
      noteOutboxError(next.id, e instanceof Error ? e.message : 'Could not send.')
      break
    }
    if (!landed) break
    removeOutbox(next.id)
    shipped++
  }
  return { shipped, remaining: read().length }
}
