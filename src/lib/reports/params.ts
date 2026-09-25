/**
 * The range every live report is derived over.
 *
 * A report is a pure function of `(state, params)`, and the only parameter that
 * matters to the arithmetic is a pair of inclusive date keys — everything the
 * RangePicker offers (this month, a picked month, a custom span, a comparison) is
 * UI sugar that resolves to one or two of those pairs before it reaches a
 * derivation. The derivations therefore cannot disagree about what "August" means.
 *
 * Isomorphic like src/lib/permissions.ts: `.ts` extensions, no browser globals, so the
 * same module can run inside the BFF when reports move server-side.
 */

export interface ReportWindow {
  /** First day in the window, `yyyy-mm-dd`, inclusive. */
  from: string
  /** Last day in the window, `yyyy-mm-dd`, inclusive. */
  to: string
}

export interface ReportParams {
  window: ReportWindow
  /** Second window, when the report is asked to compare. Null when it is not. */
  compareWindow: ReportWindow | null
}

/** `2026-09-14` → `2026-09`. Month bucketing is a date-string prefix, so there is
 *  no timezone in which it can be wrong — records carry local date keys. */
export const monthOf = (date: string | undefined): string => (date || '').slice(0, 7)

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `2026-09` → `September 2026`. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-')
  const name = MONTHS[Number(m) - 1]
  return name ? `${name} ${y}` : month
}

/** The last day of a month, from its key — `2026-09` → `2026-09-30`. UTC arithmetic,
 *  so no day can be stolen by a timezone on either side of midnight. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(last).padStart(2, '0')}`
}

/** The whole of one month, as a window. */
export function monthWindow(month: string): ReportWindow {
  return { from: `${month}-01`, to: monthEnd(month) }
}

/** Whether a record's date key falls inside a window. Strings compare correctly
 *  because every date in the app is a `yyyy-mm-dd` key. */
export const inWindow = (date: string | undefined, w: ReportWindow): boolean =>
  !!date && date >= w.from && date <= w.to

/** Every month key from `from` to `to`, inclusive, oldest first. A window that is
 *  not aligned to months still starts and ends where it says. */
export function monthsBetween(w: ReportWindow): string[] {
  const out: string[] = []
  let cursor = monthOf(w.from)
  const last = monthOf(w.to)
  // A window wider than ~5700 months would loop forever on malformed input; real
  // plants do not, but a cap keeps a typo from hanging the page.
  for (let i = 0; i < 1200 && cursor <= last; i++) {
    out.push(cursor)
    const [y, m] = cursor.split('-').map(Number)
    const next = new Date(Date.UTC(y, m, 1))
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`
  }
  return out
}

/** Whether a window is exactly one calendar month — decides if it reads
 *  "September 2026" or "17 Aug – 23 Sep 2026". */
export const isWholeMonth = (w: ReportWindow) =>
  w.from === `${monthOf(w.from)}-01` && w.to === monthEnd(monthOf(w.from))

/** `September 2026`, `15 – 31 Aug 2026` or `14 Aug – 23 Sep 2026` — a window as
 *  a person reads it. */
export function windowLabel(w: ReportWindow): string {
  if (isWholeMonth(w)) return monthLabel(monthOf(w.from))
  const [fy, fm, fd] = w.from.split('-').map(Number)
  const [ty, tm, td] = w.to.split('-').map(Number)
  const mon = (m: number) => MONTHS[m - 1]?.slice(0, 3) || ''
  if (fy === ty && fm === tm) return `${fd} – ${td} ${mon(fm)} ${ty}`
  return `${fd} ${mon(fm)}${fy !== ty ? ` ${fy}` : ''} – ${td} ${mon(tm)} ${ty}`
}

/** `+12.5%` / `−3.0%` / `—`, the honest third one when the base is zero and a
 *  percentage would be infinity dressed up as a number. */
export function fmtDeltaPct(from: number, to: number): string {
  if (!from) return '—'
  const pct = ((to - from) / from) * 100
  // toFixed's own string, not a Number() round-trip — that would strip the
  // trailing zero and print "-3%" where every other figure reads to one decimal.
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/** Percentage change as a number, or null when there is no base to change from. */
export const deltaPct = (from: number, to: number): number | null =>
  from ? ((to - from) / from) * 100 : null

/** One line of a comparison table: what it measures, each side's value already
 *  formatted, and the change between them. */
export interface CompareLine {
  label: string
  a: string
  b: string
  delta: string
  /** Which way is better — colours the delta. Null when it is not a value judgement. */
  goodDirection?: 'up' | 'down' | null
}
