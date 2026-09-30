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
 *
 * Dirty work is written to a PER-TAB spill key, not the shared one: a clean tab's
 * periodic mirror-write would otherwise overwrite a dirty tab's envelope wholesale,
 * and the shared key can only say one thing. The shared key is written by clean tabs
 * only; a tab that saves successfully promotes its state to it and spends its spill.
 */

import type { AppState } from '../types'

export const APP_KEY = 'roligt_foods_ops_v1'
/** Dirty spills live at `APP_KEY + ':t:' + <tabUid>` — one per tab with unsaved work. */
const SPILL_PREFIX = APP_KEY + ':t:'
/** This tab's uid, held in sessionStorage: stable across reloads, private to the tab. */
const TAB_KEY = 'roligt_foods_ops_tab'

export function tabUid(): string {
  try {
    const held = sessionStorage.getItem(TAB_KEY)
    if (held) return held
    const uid = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem(TAB_KEY, uid)
    return uid
  } catch {
    // sessionStorage refused (a locked-down browser). Everything shares one
    // spill key — the writes are likely refusing anyway, and the work is not
    // made worse by the fallback.
    return 'tab'
  }
}

/**
 * Audits grow forever and the server is their record, so the mirror keeps the most
 * recent of them — a long-lived device's envelope was eating its own quota on rows
 * that are authoritative elsewhere. Applies to base as well as state: the base only
 * feeds the diff, and audits are insert-only, so a capped base changes no push.
 */
const AUDIT_CAP = 3000

function capAudits(rows: AppState['audits'] | undefined): AppState['audits'] | undefined {
  if (!rows || rows.length <= AUDIT_CAP) return rows
  // Slice the most recent CAP while keeping the array's own order: find the
  // cutoff time, keep everything at or past it (a tie at the boundary keeps a
  // few extra — "~3000 recent", never fewer than promised).
  const cutoff = [...rows]
    .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
    [AUDIT_CAP - 1]
  const floor = String(cutoff?.time ?? '')
  return rows.filter((r) => String(r.time ?? '') >= floor)
}

export interface LocalCopy {
  state: AppState
  /** True while this copy holds changes the database has not accepted. */
  dirty: boolean
  /** The database revision this copy was last known to match. Absent on copies
   *  written before it was recorded. Startup trusts it only on a clean copy: a
   *  dirty one is ahead of the server by definition, and its revision is the
   *  floor the unsaved work sits on, not a statement of freshness. */
  revision?: number | string
  /**
   * The last state the database was known to hold when this copy went dirty —
   * the base a reconnect diffs against. Without it the push cannot tell "this
   * device deleted a row" from "this device never saw the row", and diffing
   * against anything fresher deletes whatever colleagues posted in between.
   * Present only while dirty; dropped on a quota failure before the state
   * itself is (a copy without one falls back to the null-base push, which
   * upserts everything and removes nothing).
   */
  base?: AppState | null
  savedAt: string
}

/** One parsed envelope, spill or shared. */
interface ParsedCopy {
  state: AppState
  dirty: boolean
  revision?: number | string
  base?: AppState
  savedAt: string
}

function parseEnvelope(raw: string | null): ParsedCopy | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LocalCopy> & { counters?: unknown }
    // A copy written before this file existed was the bare state, with no envelope.
    if (parsed && !('state' in parsed) && 'counters' in parsed) {
      return { state: parsed as unknown as AppState, dirty: true, savedAt: '' }
    }
    if (!parsed?.state) return null
    return {
      state: parsed.state as AppState,
      dirty: parsed.dirty !== false,
      revision:
        typeof parsed.revision === 'number' || typeof parsed.revision === 'string' ? parsed.revision : undefined,
      base:
        parsed.base && typeof parsed.base === 'object' && 'counters' in parsed.base
          ? (parsed.base as AppState)
          : undefined,
      savedAt: parsed.savedAt || '',
    }
  } catch {
    // Corrupt. Not worth failing over.
    return null
  }
}

/** Every dirty spill on this device, oldest write first — the fold order. */
function readSpills(): ParsedCopy[] {
  const spills: ParsedCopy[] = []
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(SPILL_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      const parsed = parseEnvelope(localStorage.getItem(k))
      if (parsed && parsed.dirty) spills.push(parsed)
    }
  } catch {
    // A browser with storage switched off has no spills to read.
  }
  return spills.sort((a, b) => a.savedAt.localeCompare(b.savedAt))
}

/** Rows upserted by id over the floor — the same direction the null-base push errs in. */
function foldRows<T extends Record<string, unknown>>(floor: T[] | undefined, over: T[]): T[] {
  if (!floor || floor.length === 0) return over
  const byId = new Map(floor.map((r) => [String(r.id ?? ''), r]))
  for (const r of over) byId.set(String(r.id ?? ''), r)
  return [...byId.values()]
}

/** `over` merged into `floor`: keyed collections upsert row-by-row, everything
 *  else (config, counters, periods) takes `over`'s value wholesale. */
function foldState(floor: AppState | null, over: AppState): AppState {
  const out: Record<string, unknown> = { ...(floor as unknown as Record<string, unknown> ?? {}) }
  for (const [key, value] of Object.entries(over as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      out[key] = value
      continue
    }
    // Only collections whose rows carry ids fold; anything else replaces.
    const foldable = value.every((r) => typeof (r as { id?: unknown })?.id === 'string')
    out[key] = foldable ? foldRows(out[key] as Record<string, unknown>[] | undefined, value as Record<string, unknown>[]) : value
  }
  return out as unknown as AppState
}

export function readLocal(): LocalCopy | null {
  const shared = parseEnvelope(tryGet(APP_KEY))
  const spills = readSpills()
  // A dirty copy under the shared key predates spills (or its tab could not get
  // one) — it is unsaved work all the same, so it folds in as the oldest spill.
  if (shared?.dirty) spills.unshift(shared)
  if (!spills.length) return shared ? { ...shared, base: shared.base ?? undefined } : null

  // Fold oldest-first so the newest spill's version of a row wins. The clean
  // shared copy deliberately does NOT join the fold: it is a view of the server,
  // and folding a server view back in would resurrect every row a spill deleted.
  // Deletions two spills make of each other's rows do not survive the fold —
  // the same side the null-base push errs on, upsert rather than remove.
  let state: AppState | null = null
  let base: AppState | null | undefined
  let revision: number | string | undefined
  for (const spill of spills) {
    state = foldState(state, spill.state)
    // One spill without a recorded base degrades the whole merge to the
    // null-base push — it knows nothing about the server, so nothing may be
    // diffed against what the others remember.
    base = base === null ? null : spill.base ? foldState(base ?? null, spill.base) : null
    revision ??= spill.revision
  }
  return { state: state!, dirty: true, revision, base, savedAt: spills[spills.length - 1]!.savedAt }
}

function tryGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function tryPut(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * Writes the mirror. Returns whether the copy actually landed — a full quota or
 * a private window used to swallow the failure here, leaving every "held on this
 * device" promise above it a lie the caller had no way to check.
 */
export function writeLocal(copy: Omit<LocalCopy, 'savedAt'>): boolean {
  const savedAt = new Date().toISOString()
  const state = { ...copy.state, audits: capAudits(copy.state.audits) }
  const base = copy.base ? { ...copy.base, audits: capAudits(copy.base.audits) } : copy.base
  if (copy.dirty) {
    // Dirty work goes to this tab's spill and nowhere else — overwriting the
    // shared key is exactly the two-tab clobber the spill exists to prevent.
    const key = SPILL_PREFIX + tabUid()
    const envelope = JSON.stringify({ ...copy, state, base, savedAt })
    if (tryPut(key, envelope)) return true
    // The base roughly doubles the mirror's footprint while dirty. Losing it is
    // the right thing to lose first: the copy degrades to the null-base push
    // (everything upserted, nothing removed) instead of losing the work itself.
    return tryPut(key, JSON.stringify({ ...copy, state, base: undefined, savedAt }))
  }
  // A clean write is the promotion: the shared copy is replaced with what the
  // database now holds, and this tab's spill — saved, or never spent — goes.
  const ok = tryPut(APP_KEY, JSON.stringify({ ...copy, state, base: undefined, savedAt }))
  tryRemove(SPILL_PREFIX + tabUid())
  return ok
}

function tryRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* see writeLocal */
  }
}

export function clearLocal(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k === APP_KEY || (k && k.startsWith(SPILL_PREFIX))) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    /* see writeLocal */
  }
}
