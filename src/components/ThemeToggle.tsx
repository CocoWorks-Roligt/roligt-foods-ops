import { useState } from 'react'
import { nextTheme, readTheme, resolvedTheme, writeTheme, type ThemeChoice } from '../lib/theme.ts'

/**
 * One button, three stops: System → Light → Dark. It says what it does and
 * does what it says — the label names the CURRENT resolved appearance, so a
 * device on System reads "System (dark)" and the next tap pins what the room
 * actually looks like. Touch-target sized (the shared .icon-btn), never a
 * bare glyph.
 */
const LABELS: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme())
  const resolved = resolvedTheme(choice)

  const flip = () => {
    const next = nextTheme(choice)
    writeTheme(next)
    setChoice(next)
  }

  const label = `Theme: ${LABELS[choice]}${choice === 'system' ? ` (${resolved})` : ''}`

  return (
    <button type="button" className={className} onClick={flip} aria-label={label} title={label}>
      {/* Sun/moon marks from the app's own stroke language: 16px, currentColor. */}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {resolved === 'dark' ? (
          <path
            d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        ) : (
          <>
            <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </button>
  )
}
