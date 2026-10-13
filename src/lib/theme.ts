/**
 * The light/dark switch (overhaul §6: light and dark mode).
 *
 * The theme is a token swap, not a second stylesheet: [data-theme='dark'] on
 * <html> re-points every token the app already reads (src/index.css), so any
 * surface that uses tokens follows for free. The choice is per-device — a
 * plant tablet mounted by a cold room and a manager's phone may want different
 * rooms' lighting — so it lives in localStorage, never in the database.
 *
 * 'system' follows the OS, including a live change of the OS preference while
 * the app is open; the matchMedia listener is installed once, on first touch.
 */
export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'roligt_theme'
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

const media = () =>
  typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

export const resolvedTheme = (choice: ThemeChoice): 'light' | 'dark' =>
  choice === 'system' ? (media()?.matches ? 'dark' : 'light') : choice

export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // private mode / storage disabled — the OS preference stands
  }
  return 'system'
}

/** Paints the choice onto the document. Safe to call on every boot and change. */
export function applyTheme(choice: ThemeChoice) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolvedTheme(choice)
}

let listenerInstalled = false

/** Installs the OS-preference follower exactly once; idempotent by design. */
function followSystem() {
  if (listenerInstalled) return
  const mq = media()
  if (!mq || typeof mq.addEventListener !== 'function') return
  listenerInstalled = true
  mq.addEventListener('change', () => {
    // Only re-paint when the device actually follows the system.
    if (readTheme() === 'system') applyTheme('system')
  })
}

export function writeTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // storage refused — the theme still applies for this session
  }
  followSystem()
  applyTheme(choice)
}

/** Boot: paint the stored (or OS) theme before anything renders. */
export function initTheme() {
  followSystem()
  applyTheme(readTheme())
}

/** The next choice in the toggle's cycle. */
export function nextTheme(current: ThemeChoice): ThemeChoice {
  const i = THEME_CHOICES.indexOf(current)
  return THEME_CHOICES[(i + 1) % THEME_CHOICES.length]!
}
