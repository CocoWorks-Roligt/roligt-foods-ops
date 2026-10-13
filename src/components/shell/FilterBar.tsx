import { type ReactNode } from 'react'
import { DATE_PRESETS, type DateRange } from '../../lib/dateRanges.ts'

/**
 * The one filter row that sits ABOVE the charts (dataviz interaction rule):
 * date presets on the left, free filter slots on the right. Presets answer
 * "over what range?" in one tap; the range is a controlled {from, to} pair of
 * yyyy-mm-dd days — the exact shape /api/kpis?from=&to= reads.
 */
export function FilterBar({
  range,
  onRange,
  children,
}: {
  range: DateRange
  onRange: (r: DateRange) => void
  /** Extra filter slots (selects, searches) rendered to the right. */
  children?: ReactNode
}) {
  const activePreset = DATE_PRESETS.find((p) => {
    const r = p.range()
    return r.from === range.from && r.to === range.to
  })

  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <div className="filter-presets" role="group" aria-label="Date range">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`btn btn-chip${activePreset?.label === p.label ? ' active' : ''}`}
            aria-pressed={activePreset?.label === p.label}
            onClick={() => onRange(p.range())}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="filter-dates">
        <span className="visually-hidden">From date</span>
        <input
          type="date"
          value={range.from}
          max={range.to}
          onChange={(e) => onRange({ ...range, from: e.target.value })}
        />
        <span aria-hidden="true">–</span>
        <span className="visually-hidden">To date</span>
        <input
          type="date"
          value={range.to}
          min={range.from}
          onChange={(e) => onRange({ ...range, to: e.target.value })}
        />
      </label>
      {children ? <div className="filter-slots">{children}</div> : null}
    </div>
  )
}
