/**
 * Zoho Apptics facade — dev/staging trial. Production builds emit no SDK script
 * (vite.config.ts keys that on this same token) and the env var is absent there,
 * so every export below is a no-op in production. Call sites never guard: call
 * and move on, exactly like WORKOS_CONFIGURED in src/lib/authMode.ts.
 */
import { bootAppticsSdk, sdkSetUser, sdkTrackEvent, sdkTrackScreen } from './appticsSdk'

/** Present = staging trial wiring is live. Absent = everything here is inert. */
export const APPTICS_CONFIGURED = Boolean(import.meta.env.VITE_APPTICS_APP_TOKEN)

/** The event vocabulary — a union so a typo at a call site is a compile error. */
export type AppticsEventName = 'db_commit' | 'db_throttled' | 'session_expired' | 'connectivity'

let started = false
let ready = false
/** Events fired while the script is still loading; flushed on boot. */
let pending: Array<() => void> = []

function whenReady(call: () => void): void {
  if (!APPTICS_CONFIGURED) return
  if (ready) call()
  // A hung script must not turn the buffer into a leak — the trial can lose
  // tail events far more cheaply than the app can lose memory.
  else if (pending.length < 200) pending.push(call)
}

/**
 * Starts the SDK (crash capture included). Safe to call anywhere, any number of
 * times; only the first call in a configured build does anything.
 */
export function initApptics(): void {
  if (!APPTICS_CONFIGURED || started) return
  started = true
  void bootAppticsSdk(import.meta.env.VITE_APPTICS_APP_TOKEN!, import.meta.env.VITE_APPTICS_DC)
    .then(() => {
      ready = true
      const queue = pending
      pending = []
      queue.forEach((call) => call())
    })
    .catch(() => {
      // The script could not load. Apptics is observability, not a dependency:
      // drop the buffer and stay silent for the session.
      pending = []
    })
}

/** One screen event per route change — the pathname is the screen identity. */
export function trackPageView(path: string): void {
  whenReady(() => sdkTrackScreen(path))
}

export function trackEvent(name: AppticsEventName, properties?: Record<string, string | number | boolean>): void {
  whenReady(() => sdkTrackEvent(name, properties))
}

/** Attributes the session to the operator's email; null on the login screen. */
export function setAppticsUser(email: string | null): void {
  whenReady(() => sdkSetUser(email))
}
