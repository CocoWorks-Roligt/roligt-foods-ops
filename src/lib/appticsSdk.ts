/**
 * The only file that knows Zoho Apptics' real API names. Everything above it
 * (src/lib/apptics.ts) speaks our narrow surface, so SDK changes land here.
 *
 * Integration is Zoho's documented init script, not the npm package: the SDK
 * auto-initializes while it loads by reading `window.appticssettings` and its
 * init reads `base_domain` unconditionally — so the settings it consumes must
 * already be complete (zsoid, projectID, identifier, base_domain, DC and a
 * server-minted token). Hand-staging a partial object crashes the SDK inside
 * its own eval and nothing is ever sent, which is exactly how this trial
 * shipped dead for a week. The init endpoint mints the full settings for our
 * app and appends the SDK from Zoho's CDN itself:
 *
 *   https://apptics.zoho.<dc>/sdk/web/v1/<zsoid>/<projectID>/init?aaID=<aaID>
 *
 * so the only values we carry are the public ids the console prints in the
 * snippet. (The npm package was also unusable as a module — no exports, IIFE
 * bound to `this` — and is gone from the build.)
 */

/** The only init hosts proven live: the IN portal answers for our org, and the
 *  .com portal is Zoho's default (it rejects an IN org with INVALID_PORTAL,
 *  which is how the DC routing was confirmed). */
const initHostFor = (dc?: string) => (dc === 'IN' ? 'apptics.zoho.in' : 'apptics.zoho.com')

/** The slice of window.apptics we use — verified against the SDK source (v1.0.2). */
interface AppticsApi {
  trackEvent(name: string, group?: string, properties?: Record<string, unknown>): void
  trackScreen(screen: string, properties?: Record<string, unknown>): void
  setUser(userId: string, groupId?: string, properties?: Record<string, unknown>): void
  /** Installs the window error + unhandledrejection handlers. Opt-in, not automatic. */
  enableGlobalErrorHandler(enabled: boolean): void
}

declare global {
  interface Window {
    apptics?: AppticsApi
  }
}

/**
 * Waits for the SDK the init script appends to define `window.apptics`. The
 * init tag's own load event only means the settings were staged; the SDK lands
 * a moment later, so boot is not done until its surface exists.
 */
function waitForApptics(timeoutMs: number): Promise<AppticsApi> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      if (window.apptics) return resolve(window.apptics)
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error('apptics sdk failed to load'))
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/**
 * Injects Zoho's init script and resolves once the SDK it pulls in is live,
 * with crash capture armed. The `aaID` is the app token the Apptics console
 * prints inside its snippet; zsoid and projectID are the ids in the same
 * snippet's URL; DC is the optional data-center code (IN for this org).
 */
export function bootAppticsSdk(
  token: string,
  zsoid: string,
  projectID: string,
  dc?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://${initHostFor(dc)}/sdk/web/v1/${zsoid}/${projectID}/init?aaID=${token}`
    script.crossOrigin = 'anonymous'
    script.async = true
    script.onload = () => {
      // Settings are staged and the SDK tag appended — finish when the SDK
      // itself has run. Crash capture stays a separate opt-in.
      void waitForApptics(10_000).then(
        (api) => {
          api.enableGlobalErrorHandler(true)
          resolve()
        },
        reject,
      )
    }
    script.onerror = () => reject(new Error('apptics sdk failed to load'))
    document.head.appendChild(script)
  })
}

export function sdkTrackEvent(name: string, properties?: Record<string, string | number | boolean>): void {
  window.apptics?.trackEvent(name, undefined, properties)
}

export function sdkTrackScreen(screen: string): void {
  window.apptics?.trackScreen(screen)
}

export function sdkSetUser(userId: string | null): void {
  if (userId) window.apptics?.setUser(userId)
}
