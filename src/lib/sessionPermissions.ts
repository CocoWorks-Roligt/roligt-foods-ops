import { useSyncExternalStore } from 'react'

/**
 * The caller's live permission set, as one tiny store.
 *
 * AuthContext seeds it at boot (from /api/auth/session, or the dev role), and
 * AppContext refreshes it whenever a snapshot arrives carrying `permissions` —
 * so a role change someone else made lands here on the next poll, without this
 * device reloading. Gating reads it through useSessionPermissions(); nothing
 * else keeps its own copy.
 */

let current: string[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Replace the live set. A payload without permissions leaves the last known one. */
export function setSessionPermissions(next: string[] | undefined) {
  if (!next) return
  const sorted = [...next].sort()
  const unchanged =
    sorted.length === current.length && sorted.every((slug, i) => slug === current[i])
  if (unchanged) return
  current = sorted
  emit()
}

export function subscribeSessionPermissions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSessionPermissions(): string[] {
  return current
}

/** The live permission set, as reactive state. */
export function useSessionPermissions(): string[] {
  return useSyncExternalStore(subscribeSessionPermissions, getSessionPermissions)
}
