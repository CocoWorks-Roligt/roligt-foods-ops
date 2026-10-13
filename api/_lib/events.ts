/**
 * The B4 live feed — GET /api/events' SSE stream (ARCHITECTURE §5). One
 * message shape (RevisionEvent, contracts v1.2) on three event names: hello
 * on connect, revision when the token changed (the client's refetch cue), bye
 * when this server ends the stream — EventSource reconnects and hello
 * re-syncs, so a missed bye costs one reconnect, never a wrong number. The
 * poll fallback for clients that cannot hold a stream stays GET /api/revision.
 *
 * Timing is injectable so tests drive real intervals instead of faked clocks.
 * The stream self-terminates inside the platform's function budget (maxLife
 * default 4 min < the 300 s cap) — a long-lived connection is the client's
 * reconnect chain, not one held function.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { RevisionEvent } from '../../src/lib/contracts.js'

export interface StreamOptions {
  /** How often the store's revision token is re-read. */
  pollMs?: number
  /** SSE comment cadence — keeps intermediaries from idling the connection. */
  heartbeatMs?: number
  /** When the stream says bye; must stay under the function's max duration. */
  maxLifeMs?: number
}

const DEFAULTS = { pollMs: 5_000, heartbeatMs: 15_000, maxLifeMs: 240_000 }

const encode = (name: string, payload: RevisionEvent): string =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`

const nowIso = () => new Date().toISOString()

export function revisionStream(
  req: VercelRequest,
  res: VercelResponse,
  readRevision: () => Promise<string>,
  opts: StreamOptions = {},
): void {
  const { pollMs, heartbeatMs, maxLifeMs } = { ...DEFAULTS, ...opts }

  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders()
  // The reconnect cadence EventSource falls back to (ms) — same as the poll.
  res.write('retry: 20000\n\n')

  let lastRevision: string | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let beatTimer: NodeJS.Timeout | null = null
  let lifeTimer: NodeJS.Timeout | null = null

  const stop = (): void => {
    for (const t of [pollTimer, beatTimer, lifeTimer]) if (t) clearTimeout(t)
    pollTimer = beatTimer = lifeTimer = null
  }
  const end = (): void => {
    stop()
    // The goodbye is best-effort: a closed socket ends the write silently.
    try {
      res.write(encode('bye', { revision: lastRevision ?? '0', at: nowIso() }))
      res.end()
    } catch {
      /* already gone */
    }
  }

  req.on('close', stop)
  res.on('close', stop)

  const poll = async (): Promise<void> => {
    try {
      const revision = await readRevision()
      if (lastRevision === null) {
        lastRevision = revision
        res.write(encode('hello', { revision, at: nowIso() }))
      } else if (revision !== lastRevision) {
        lastRevision = revision
        res.write(encode('revision', { revision, at: nowIso() }))
      }
    } catch {
      // A refused poll keeps the stream — the next tick retries; the client's
      // own poll fallback covers an outage this long.
    }
  }

  void poll()
  pollTimer = setInterval(() => void poll(), pollMs)
  beatTimer = setInterval(() => res.write(': ping\n\n'), heartbeatMs)
  lifeTimer = setTimeout(end, maxLifeMs)
}
