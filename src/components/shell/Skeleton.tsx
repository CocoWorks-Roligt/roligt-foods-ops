/**
 * Loading placeholder rows (overhaul §6: every screen has a loading skeleton).
 * Pure CSS shimmer over the token surfaces — no animation cost beyond one
 * transform, and it inherits the theme because it only reads tokens.
 */
export function Skeleton({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`skeleton ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" style={{ width: `${88 - i * (52 / Math.max(rows - 1, 1))}%` }} />
      ))}
    </div>
  )
}

/** Card-shaped skeleton for one KPI tile. */
export function KpiSkeleton() {
  return (
    <div className="kpi-card skeleton-card" role="status" aria-label="Loading figure">
      <div className="skeleton-row" style={{ width: '55%' }} />
      <div className="skeleton-row big" style={{ width: '40%' }} />
      <div className="skeleton-row" style={{ width: '70%' }} />
    </div>
  )
}
