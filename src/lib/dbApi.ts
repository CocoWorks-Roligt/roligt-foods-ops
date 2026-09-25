/**
 * Reading and writing the plant — Zoho Tables edition.
 *
 * Everything the Supabase version did through its SDK now goes over three BFF
 * endpoints; the shapes are unchanged (`fetchDb` returns the same DbSnapshot,
 * `saveDb` the same SaveResult), so AppContext, the offline queue and the diff
 * engine keep working untouched. The BFF holds the Zoho credentials; the
 * browser holds no tokens at all — the httpOnly session cookie is the whole
 * credential, refreshed server-side by the BFF on any data request.
 */
import { diffState, type StateChanges } from './sync'
import type { AppState } from '../types'
import { notifyUnauthorized } from './authEvents'
import { WORKOS_CONFIGURED, getDevRole } from './authMode'

/** The BFF refused the session cookie — it is gone. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Your session expired — sign in again.')
  }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin', // the session cookie is the credential
    headers: {
      'content-type': 'application/json',
      // Unconfigured dev harness: the picker's role is the only signal the BFF
      // gets about who is "signed in" (it answers with matching permissions).
      ...(WORKOS_CONFIGURED ? {} : { 'x-dev-role': getDevRole() }),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) {
    // Refresh happens server-side; a 401 that survived it means the session is
    // really dead — no client-side retry exists or is needed.
    notifyUnauthorized() // AuthContext clears the session → login screen
    throw new UnauthorizedError()
  }
  if (res.status === 503) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60
    throw new ThrottledError(retryAfter)
  }
  return res
}

export class ThrottledError extends Error {
  readonly retryAfterSec: number
  constructor(retryAfterSec: number) {
    super('The server is busy — your change is saved on this device and will retry.')
    this.retryAfterSec = retryAfterSec
  }
}

export async function fetchRevision(): Promise<number> {
  const res = await api('/api/revision')
  if (!res.ok) throw new Error(`Failed to read revision: ${await res.text()}`)
  const j = (await res.json()) as { revision: number }
  return Number(j.revision) || 0
}

export interface DbSnapshot {
  state: Partial<AppState> | null
  revision: number
  /** The caller's permissions per the BFF — AppContext feeds them to the gating. */
  permissions?: string[]
}

export async function fetchDb(): Promise<DbSnapshot> {
  const res = await api('/api/snapshot')
  if (!res.ok) throw new Error(`Failed to read the plant: ${await res.text()}`)
  return (await res.json()) as DbSnapshot
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'forbidden'; message: string }
  | { ok: false; reason: 'unauthorized'; message: string }
  | { ok: false; reason: 'error'; message: string }

export async function saveDb(next: AppState, prev: AppState | null): Promise<SaveResult> {
  const changes: StateChanges = diffState(prev, next)
  let res!: Response
  try {
    if (changes.empty) {
      const revision = await fetchRevision()
      return { ok: true, revision }
    }
    res = await api('/api/commit', {
      method: 'POST',
      body: JSON.stringify({ changes }),
    })
  } catch (e) {
    // A dead session is not an outage: the work stays held on this device and
    // is pushed after signing in again. Reporting it as offline would promise a
    // reconnect that never comes.
    if (e instanceof UnauthorizedError) {
      return { ok: false, reason: 'unauthorized', message: e.message }
    }
    throw e
  }
  if (res.ok) {
    const j = (await res.json()) as { revision: number }
    return { ok: true, revision: Number(j.revision) || 0 }
  }
  if (res.status === 403) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; table?: string }
    return {
      ok: false,
      reason: 'forbidden',
      message: j.error ?? `You do not have permission to change ${(j.table ?? 'this data').replace(/_/g, ' ')}.`,
    }
  }
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return { ok: false, reason: 'error', message: j.error ?? `commit failed (HTTP ${res.status})` }
}
