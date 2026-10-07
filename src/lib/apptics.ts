/**
 * Zoho Apptics facade — dev/staging trial. Production carries none of the env
 * vars below, so every export here is a no-op there and no SDK is ever fetched.
 * Call sites never guard: call and move on, exactly like WORKOS_CONFIGURED in
 * src/lib/authMode.ts.
 *
 * The SDK module is imported DYNAMICALLY inside initApptics, never statically:
 * APPTICS_CONFIGURED folds to `false` in a production build, which folds the
 * one dynamic import out of the graph entirely — a static import would drag
 * appticsSdk.ts (and its `apptics.zoho.*` init hosts) into every production
 * chunk no matter what the flag says. scripts/assert-no-apptics.mjs fails the
 * build if those markers ever reach dist/ again (the audit's S3-13).
 */
/** The loaded SDK module — null until a configured boot resolved it. */
type AppticsSdk = typeof import('./appticsSdk')

/**
 * Present = staging trial wiring is live. Absent = everything here is inert.
 * All three ids come from the console snippet — a partial set would only build
 * a broken init URL, so it counts as unconfigured.
 */
export const APPTICS_CONFIGURED = Boolean(
  import.meta.env.VITE_APPTICS_APP_TOKEN &&
    import.meta.env.VITE_APPTICS_ZSOID &&
    import.meta.env.VITE_APPTICS_PROJECT_ID,
)

/** The event vocabulary — a union so a typo at a call site is a compile error. */
export type AppticsEventName =
  | 'db_commit'
  | 'db_throttled'
  | 'session_expired'
  | 'connectivity'
  | 'render_error'

let started = false
let ready = false
/** The SDK module once booted — track* helpers call through it, so the only
 *  static trace of Apptics left in an unconfigured bundle is this file. */
let sdk: AppticsSdk | null = null
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
  void import('./appticsSdk')
    .then((m) => {
      sdk = m
      return m.bootAppticsSdk(
        import.meta.env.VITE_APPTICS_APP_TOKEN!,
        import.meta.env.VITE_APPTICS_ZSOID!,
        import.meta.env.VITE_APPTICS_PROJECT_ID!,
        import.meta.env.VITE_APPTICS_DC,
      )
    })
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
  whenReady(() => sdk?.sdkTrackScreen(path))
}

export function trackEvent(name: AppticsEventName, properties?: Record<string, string | number | boolean>): void {
  whenReady(() => sdk?.sdkTrackEvent(name, properties))
}

/** Attributes the session to the operator's email; null on the login screen. */
export function setAppticsUser(email: string | null): void {
  whenReady(() => sdk?.sdkSetUser(email))
}
