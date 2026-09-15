/**
 * Chrome/Edge fire this before showing their own install UI. It is not in lib.dom,
 * so we describe the bits we use.
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt: () => Promise<void>
}

/** True once the app is running from the home screen rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari never fires beforeinstallprompt and reports the mode here instead.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** iOS has no install API — the user must go through the Share sheet. */
export function isIos(): boolean {
  if (typeof window === 'undefined') return false
  const ua = window.navigator.userAgent
  return /iphone|ipad|ipod/i.test(ua) || (/Mac/.test(ua) && 'ontouchend' in document)
}
