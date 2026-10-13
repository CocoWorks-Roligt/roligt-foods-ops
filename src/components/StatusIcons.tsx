/**
 * The palette glyphs (GLOSSARY status palette): one 12×12 stroke mark per
 * status family, drawn in currentColor so the badge's own ink colours them.
 * Components only — the name→glyph resolution lives beside its reader
 * (StatusBadge), so this file stays a plain component module.
 */
const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export const Clock = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="4.6" {...S} />
    <path d="M6 3.6V6l1.7 1" {...S} />
  </svg>
)
export const Play = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3.6 2.6v6.8L9.2 6 3.6 2.6Z" {...S} />
  </svg>
)
export const Pause = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.2 2.8v6.4M7.8 2.8v6.4" {...S} />
  </svg>
)
export const Check = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.4 6.3 5 8.8l4.6-5.6" {...S} />
  </svg>
)
export const CheckCircle = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="4.6" {...S} />
    <path d="M4 6.2 5.4 7.6 8.2 4.6" {...S} />
  </svg>
)
export const X = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 3l6 6M9 3l-6 6" {...S} />
  </svg>
)
export const Rotate = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M9.6 6a3.6 3.6 0 1 1-1.1-2.6" {...S} />
    <path d="M9.8 1.6v2.2H7.6" {...S} />
  </svg>
)
export const TruckOut = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1.6 3h5v4.4H1.6zM6.6 4.6h2.2L10.4 6.4v1H6.6" {...S} />
    <circle cx="3.4" cy="8.6" r="1.1" {...S} />
    <circle cx="8.4" cy="8.6" r="1.1" {...S} />
  </svg>
)
export const Truck = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1.6 2.6h5.2v5H1.6zM6.8 4.2h2.4l1.2 1.8v1.6H6.8" {...S} />
    <circle cx="3.6" cy="8.6" r="1.1" {...S} />
    <circle cx="8.6" cy="8.6" r="1.1" {...S} />
  </svg>
)
export const HomeCheck = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M1.8 5.4 6 2l4.2 3.4M2.8 5v4.6h6.4V5" {...S} />
    <path d="M4.8 7l1 1 1.6-1.8" {...S} />
  </svg>
)
export const Undo = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.4 5.4h5a2.6 2.6 0 1 1 0 5.2H4.6" {...S} />
    <path d="M4.4 3.2 2.2 5.4l2.2 2.2" {...S} />
  </svg>
)
export const Slash = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="4.6" {...S} />
    <path d="M3.1 8.9 8.9 3.1" {...S} />
  </svg>
)
