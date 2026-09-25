import { useSearchParams } from 'react-router-dom'
import { Select } from '../Select'
import { isWholeMonth, monthOf, monthWindow } from '../../lib/reports/params.ts'
import { monthChoices, previousWindow, readRange } from './range.ts'

/**
 * The range every live report runs over: a month pick, a custom span, and —
 * where the report supports it — a second window to compare against.
 *
 * The URL is the only state. Every choice resolves to explicit `from`/`to`
 * (and `cfrom`/`cto`) before it is written, so a bookmarked link shows the
 * same figures the day it was made, and the Back button walks the ranges the
 * operator has already looked at. The compare side mirrors the primary side:
 * a month against a month, a span against a span.
 */
export function RangePicker({ compare }: { compare: boolean }) {
  const [params, setParams] = useSearchParams()
  const { window: w, compareWindow } = readRange(params, compare)
  const monthMode = isWholeMonth(w)
  const comparing = !!compareWindow

  /** Rewrite the range params, leaving every other param (`type`, `group`) put. */
  const write = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace: true },
    )

  const pickMonth = (key: string) => {
    if (!key) return // "Custom span…" just uncovers the date inputs below
    write({ from: `${key}-01`, to: monthWindow(key).to })
  }

  const setSpan = (from: string, to: string) => {
    // An inverted span is clamped rather than rejected — the operator meant a
    // range, and the day they picked twice is a range of one.
    write({ from, to: to < from ? from : to })
  }

  const setCompareSpan = (from: string, to: string) =>
    write({ cmp: '1', cfrom: from, cto: to < from ? from : to })

  const clearCompare = () => write({ cmp: null, cfrom: null, cto: null })

  const months = monthChoices()
  const thisMonth = monthOf(w.from)
  const prev = previousWindow(w)
  const prevMonth = monthOf(prev.from)
  // The compare select speaks in months; a compare side that is not a whole
  // month (a span left over from custom mode) is not its business to restate.
  const cmpMonthKey = compareWindow && isWholeMonth(compareWindow) ? monthOf(compareWindow.from) : ''

  return (
    <div className="range-picker">
      <Select value={monthMode ? thisMonth : ''} onChange={(e) => pickMonth(e.target.value)} id="report-month">
        {months.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
        <option value="">Custom span…</option>
      </Select>

      {!monthMode && (
        <>
          <input type="date" aria-label="From" value={w.from} onChange={(e) => setSpan(e.target.value, w.to)} />
          <input type="date" aria-label="To" value={w.to} onChange={(e) => setSpan(w.from, e.target.value)} />
        </>
      )}

      {compare &&
        (monthMode ? (
          <>
            <span className="range-vs" aria-hidden="true">
              vs
            </span>
            <Select
              value={cmpMonthKey}
              onChange={(e) => {
                if (!e.target.value) return clearCompare()
                const cw = monthWindow(e.target.value)
                write({ cmp: '1', cfrom: cw.from, cto: cw.to })
              }}
              id="report-compare"
            >
              <option value="">No comparison</option>
              <option value={prevMonth}>Previous month</option>
              {months
                .filter((m) => m.key !== thisMonth && m.key !== prevMonth)
                .map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
            </Select>
          </>
        ) : comparing ? (
          <>
            <span className="range-vs" aria-hidden="true">
              vs
            </span>
            <input
              type="date"
              aria-label="Compare from"
              value={compareWindow.from}
              onChange={(e) => setCompareSpan(e.target.value, compareWindow.to)}
            />
            <input
              type="date"
              aria-label="Compare to"
              value={compareWindow.to}
              onChange={(e) => setCompareSpan(compareWindow.from, e.target.value)}
            />
            <button className="btn btn-light" type="button" onClick={clearCompare}>
              Clear comparison
            </button>
          </>
        ) : (
          <button
            className="btn btn-light"
            type="button"
            onClick={() => write({ cmp: '1', cfrom: prev.from, cto: prev.to })}
          >
            Compare against previous period
          </button>
        ))}
    </div>
  )
}
