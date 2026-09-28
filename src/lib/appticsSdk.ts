/**
 * The only file that knows Zoho Apptics' real API names. Everything above it
 * (src/lib/apptics.ts) speaks our narrow surface, so SDK changes land here.
 *
 * The npm package cannot be imported as a module: it has no exports at all and
 * its IIFE binds `this` (a classic-script tag, where `this` is window, is the
 * documented integration). So we vendored nothing into git — the build/dev
 * pipeline (vite.config.ts) serves the package's script from /vendor/apptics.js
 * and this adapter injects it at runtime, after staging the
 * `window.appticssettings._defaultoptions` the script reads while loading.
 */

/** Where the vite pipeline serves the SDK script (build: emitted asset; dev: middleware). */
const APPTICS_SDK_URL = '/vendor/apptics.js'

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
    /** Must exist before the script loads — the SDK auto-initializes from it. */
    appticssettings?: { _defaultoptions: Record<string, unknown> }
  }
}

/**
 * Stages the settings, injects the SDK script, and turns on crash capture once
 * it has run. The `aaID` is the app token the Apptics console prints inside its
 * snippet; DC is the optional data-center code the same snippet shows (IN, EU…).
 */
export function bootAppticsSdk(token: string, dc?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    window.appticssettings = {
      _defaultoptions: { aaID: token, ...(dc ? { DC: dc } : {}) },
    }
    const script = document.createElement('script')
    script.src = APPTICS_SDK_URL
    script.async = true
    script.onload = () => {
      // Crash capture is a separate opt-in — without this the global handlers
      // the SDK registers stay dormant.
      window.apptics?.enableGlobalErrorHandler(true)
      resolve()
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
