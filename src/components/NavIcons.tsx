/**
 * Minimal 24px stroke icons for the mobile shell. Inline so the app bar and bottom
 * nav paint with the first frame and stay usable offline.
 */
type IconProps = { className?: string }

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

export function DashboardIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

export function ProcurementIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 7h11v9H3z" />
      <path d="M14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18.5" r="1.8" />
      <circle cx="17" cy="18.5" r="1.8" />
    </svg>
  )
}

export function ProductionIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 20V9l5.5 3.5V9L14 12.5V9l7 4.5V20z" />
      <path d="M3 20h18" />
    </svg>
  )
}

export function QualityIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3 4.5 6v5.5c0 4.3 3 8.2 7.5 9.5 4.5-1.3 7.5-5.2 7.5-9.5V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </svg>
  )
}

export function FlaskIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M10 3v6L4.6 18.2A2 2 0 0 0 6.4 21h11.2a2 2 0 0 0 1.8-2.8L14 9V3" />
      <path d="M8.5 3h7" />
      <path d="M7.5 15h9" />
    </svg>
  )
}

export function ReportIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h7M9 16h7" />
    </svg>
  )
}

export function SlidersIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 3v18M12 3v18M19 3v18" />
      <circle cx="5" cy="9" r="2.2" />
      <circle cx="12" cy="15" r="2.2" />
      <circle cx="19" cy="7" r="2.2" />
    </svg>
  )
}

export function MenuIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  )
}

/** The bottom-nav stand-in for a page with no bespoke mark of its own. */
export function PageIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 4a1 1 0 0 1 1-1h7l6 6v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
      <path d="M13 3v6h6" />
    </svg>
  )
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}
