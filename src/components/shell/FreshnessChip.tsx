/**
 * The freshness stamp (overhaul §6: no silent stale data). Every dashboard,
 * report and chart card carries one: "as of HH:MM" from the payload's own
 * last_updated, plus a STALE chip when the SERVER's verdict says so — the
 * badge and the data cannot disagree because both come from the same
 * Freshness object (contracts v1.2).
 */
export interface FreshnessProps {
  last_updated: string
  stale: boolean
  /** aria-label for the chip; defaults to a plain sentence. */
  label?: string
}

const fmt = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function FreshnessChip({ last_updated, stale, label }: FreshnessProps) {
  return (
    <span className={`freshness${stale ? ' stale' : ''}`}>
      <span className="freshness-time">as of {fmt(last_updated)}</span>
      {stale ? (
        <span className="freshness-flag" role="status">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6.8 1.6 2.4 7h3.2l-.6 3.6L9.6 5.4H6.2l.6-3.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          Stale
        </span>
      ) : null}
      <span className="visually-hidden">{label ?? (stale ? 'Data is stale — refresh to be sure.' : 'Data is fresh.')}</span>
    </span>
  )
}
