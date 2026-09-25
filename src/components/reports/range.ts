/**
 * The report range as URL params — the one place the page, the picker and a
 * shared link all agree on.
 *
 * A window is always stored resolved (`from`/`to`, and `cfrom`/`cto` when a
 * comparison is on), never as "this month" or "previous period": a link opened
 * in March must show March's figures, not whatever March-from-then means now.
 * The picker derives its own mode (month pick or custom span) from whether the
 * stored window happens to be a whole month — the URL never has to say.
 */
import {
  isWholeMonth,
  monthLabel,
  monthOf,
  monthWindow,
  windowLabel,
  type ReportWindow,
} from '../../lib/reports/params.ts'

export interface ReportRange {
  window: ReportWindow
  /** The window being compared against, when the report is comparing. */
  compareWindow: ReportWindow | null
  /** Window labels for the compare table's two columns. */
  labelA: string
  labelB: string
}

/** The month a report with no `from`/`to` in the URL opens on: the current one. */
export const defaultMonth = () => monthOf(toDayKey())

// Local, not imported from lib/utils, so this module stays browser-and-BFF clean
// the way the derivation modules are.
function toDayKey(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const readWindow = (params: URLSearchParams, from: string, to: string): ReportWindow | null => {
  const f = params.get(from)
  const t = params.get(to)
  if (!f || !t || f > t) return null
  return { from: f, to: t }
}

/** The range a report runs over, from the URL, with the current month standing
 *  in when nobody has picked one yet. */
export function readRange(params: URLSearchParams, compareEnabled: boolean): ReportRange {
  const w = readWindow(params, 'from', 'to') || monthWindow(defaultMonth())
  const comparing = compareEnabled && params.get('cmp') === '1'
  const compareWindow = comparing ? readWindow(params, 'cfrom', 'cto') || previousWindow(w) : null
  return {
    window: w,
    compareWindow,
    labelA: windowLabel(compareWindow || w),
    labelB: windowLabel(w),
  }
}

/** The window immediately before `w`: the month before a whole month, the
 *  same-length span ending the day before any other span. */
export function previousWindow(w: ReportWindow): ReportWindow {
  if (isWholeMonth(w)) {
    const [y, m] = monthOf(w.from).split('-').map(Number)
    const prev = new Date(Date.UTC(y, m - 1, 1))
    const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
    return monthWindow(key)
  }
  const days = daysBetween(w)
  return { from: shiftDay(w.from, -days), to: shiftDay(w.from, -1) }
}

function daysBetween(w: ReportWindow): number {
  const a = Date.parse(`${w.from}T00:00:00Z`)
  const b = Date.parse(`${w.to}T00:00:00Z`)
  return Math.round((b - a) / 86400000) + 1
}

function shiftDay(day: string, by: number): string {
  const d = new Date(Date.parse(`${day}T00:00:00Z`) + by * 86400000)
  return d.toISOString().slice(0, 10)
}

/** The picker's month choices: the last 18 months, newest first. A plant's
 *  report questions rarely reach further back, and an unbounded list of future
 *  months is noise. */
export function monthChoices(): { key: string; label: string }[] {
  const now = defaultMonth()
  const [y, m] = now.split('-').map(Number)
  const out: { key: string; label: string }[] = []
  for (let i = 0; i < 18; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ key, label: monthLabel(key) + (key === now ? ' (this month)' : '') })
  }
  return out
}
