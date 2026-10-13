import { useEffect, useRef } from 'react'

/**
 * The live feed client (contracts v1.2, ARCHITECTURE §5): one EventSource on
 * /api/events for the whole tab. `hello` seeds the token, `revision` means
 * "the token changed — refetch whatever you hold", `bye` ends the stream and
 * EventSource reconnects on its own (hello re-syncs). When the stream cannot
 * hold (old gateway, offline-tab throttling), the existing /api/revision poll
 * takes over as the fallback — the two never run at once.
 *
 * One connection per tab, however many things listen: the EventSource is a
 * module-level singleton with a subscriber set (browsers cap EventSources per
 * domain near six, and a dashboard of KPI cards must not spend them all). A
 * listener that mounts after the last revision simply fetches on mount — its
 * first read is already current.
 */
type RevisionListener = (token: string) => void

const listeners = new Set<RevisionListener>()
let started = false

function ensureFeed(): void {
  if (started || typeof window === 'undefined') return
  started = true

  let last = ''
  let fallback: ReturnType<typeof setInterval> | null = null

  const armFallback = () => {
    if (fallback) return
    fallback = setInterval(async () => {
      try {
        const res = await fetch('/api/revision')
        if (!res.ok) return
        const { revision } = (await res.json()) as { revision?: string }
        if (typeof revision === 'string' && revision && revision !== last) {
          last = revision
          for (const l of listeners) l(revision)
        }
      } catch {
        // offline — the next tick tries again
      }
    }, 20_000)
  }
  const disarmFallback = () => {
    if (fallback) clearInterval(fallback)
    fallback = null
  }

  let source: EventSource | null = null
  try {
    source = new EventSource('/api/events')
  } catch {
    armFallback()
    return
  }

  source.addEventListener('hello', (e) => {
    last = (e as MessageEvent<string>).data
  })
  source.addEventListener('revision', (e) => {
    const token = (e as MessageEvent<string>).data
    if (token && token !== last) {
      last = token
      for (const l of listeners) l(token)
    }
  })
  source.addEventListener('bye', () => {
    // The server signed off (4-minute stream life); EventSource reconnects.
  })
  source.onopen = disarmFallback
  source.onerror = armFallback
}

export function useRevisionFeed(onRevision: RevisionListener) {
  const cb = useRef(onRevision)
  cb.current = onRevision

  useEffect(() => {
    const listener: RevisionListener = (token) => cb.current(token)
    listeners.add(listener)
    ensureFeed()
    return () => {
      listeners.delete(listener)
    }
  }, [])
}
