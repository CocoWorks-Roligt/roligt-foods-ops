/**
 * The copy on this device.
 *
 * The app ships as an installable PWA with an offline indicator, but nothing was ever
 * written to this device: `localStorage` was read once at startup and then deleted.
 * So an operator posting receipts in a cold room with no signal got one toast — and
 * only one, the flag that raised it latched — while every posting evaporated on the
 * next refresh. That is the exact shift a PWA exists for.
 *
 * Now every change is written here first and the database is the thing that catches
 * up. What is stored alongside the state is the version it was built on and whether
 * it has reached the server yet, which is what lets the next startup tell "work this
 * device did that never got out" apart from "a stale copy someone else has moved past".
 */

import type { AppState } from '../types'

export const APP_KEY = 'roligt_foods_ops_v1'

export interface LocalCopy {
  state: AppState
  /** True while this copy holds changes the database has not accepted. */
  dirty: boolean
  savedAt: string
}

export function readLocal(): LocalCopy | null {
  try {
    const raw = localStorage.getItem(APP_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LocalCopy> & { counters?: unknown }
    // A copy written before this file existed was the bare state, with no envelope.
    if (parsed && !('state' in parsed) && 'counters' in parsed) {
      return { state: parsed as unknown as AppState, dirty: true, savedAt: '' }
    }
    if (!parsed?.state) return null
    return {
      state: parsed.state as AppState,
      dirty: parsed.dirty !== false,
      savedAt: parsed.savedAt || '',
    }
  } catch {
    // Corrupt, or a browser with storage switched off. Neither is worth failing over.
    return null
  }
}

export function writeLocal(copy: Omit<LocalCopy, 'savedAt'>): void {
  try {
    localStorage.setItem(APP_KEY, JSON.stringify({ ...copy, savedAt: new Date().toISOString() }))
  } catch {
    // Private windows and a full quota both throw here. Losing the local copy is bad
    // but not worth taking the app down for — the server copy is still the record.
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(APP_KEY)
  } catch {
    /* see writeLocal */
  }
}
