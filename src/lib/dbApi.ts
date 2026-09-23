/**
 * Reading and writing the plant — Zoho Tables edition.
 *
 * Everything the Supabase version did through its SDK now goes over three BFF
 * endpoints; the shapes are unchanged (`fetchDb` returns the same DbSnapshot,
 * `saveDb` the same SaveResult), so AppContext, the offline queue and the diff
 * engine keep working untouched. The BFF holds the Zoho credentials; the browser
 * only ever holds the caller's own session token.
 */
import { diffState, type StateChanges } from './sync'
import { COLLECTIONS } from './tables'
import type { AppState } from '../types'
import { getAuthToken } from './authToken'

async function api(path: string, init?: RequestInit): Promise<Response> {
  const token = getAuthToken()
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
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
}

export async function fetchDb(): Promise<DbSnapshot> {
  const res = await api('/api/snapshot')
  if (!res.ok) throw new Error(`Failed to read the plant: ${await res.text()}`)
  return (await res.json()) as DbSnapshot
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'forbidden'; message: string }
  | { ok: false; reason: 'error'; message: string }

export async function saveDb(next: AppState, prev: AppState | null): Promise<SaveResult> {
  const changes: StateChanges = diffState(prev, next)
  if (changes.empty) return { ok: true, revision: await fetchRevision() }
  const res = await api('/api/commit', {
    method: 'POST',
    body: JSON.stringify({ changes }),
  })
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

/** Kept for the admin-only early check the domains use. */
export const writableByOperator = (table: string) =>
  !COLLECTIONS.find((c) => c.table === table)?.adminOnly
