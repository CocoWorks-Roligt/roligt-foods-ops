/**
 * The one event the data layer can raise about auth: the BFF refused the
 * session cookie. Registered by AuthContext; dbApi fires it on a 401 — the
 * session is dead, so back to the login screen (this device's unsaved work is
 * preserved by the local mirror). The browser holds no tokens, so this is the
 * whole auth surface the data layer needs.
 */

let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

export function notifyUnauthorized(): void {
  onUnauthorized?.()
}
