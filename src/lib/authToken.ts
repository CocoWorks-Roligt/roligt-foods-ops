/**
 * Hand-off between the auth layer and dbApi: who can mint the Bearer token the
 * BFF sees, and what to do when the BFF rejects it.
 *
 * The token is held as a *provider*, not a string: Kinde access tokens are
 * short-lived and the SDK refreshes them internally, so latching the value at
 * sign-in would send a stale token on every call after the first expiry.
 * `force` asks the provider for a freshly refreshed token — the 401 retry in
 * dbApi uses it before deciding a session is really dead.
 */

export type TokenProvider = (force?: boolean) => Promise<string | null>

let provider: TokenProvider = async () => null // dev fallback: no token, BFF dev session
let onUnauthorized: (() => void) | null = null

export function setAuthTokenProvider(next: TokenProvider): void {
  provider = next
}

export function currentAuthToken(force = false): Promise<string | null> {
  return provider(force)
}

/**
 * Registered by AuthContext. dbApi fires it when the BFF still refuses the
 * token after a forced refresh — the session is gone, so back to the login
 * screen (this device's unsaved work is preserved by the local mirror).
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

export function notifyUnauthorized(): void {
  onUnauthorized?.()
}
