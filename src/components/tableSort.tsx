/**
 * Sorting for the register grids.
 *
 * Every list arrives newest-first, which is right until it isn't — "which
 * melange cost the most per litre", "which receipts are still unpaid". The
 * column heads are the control: a first click sorts the way that column is
 * usually asked about (a date newest-first, a value largest-first, a name
 * A–Z), a second flips it, a third hands the order back to the page.
 */
import { useState, type ReactNode } from 'react'

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

export type SortAccessors<T> = Record<string, (row: T) => string | number | null | undefined>

/** Numbers compare as numbers, codes as codes (RF-9 before RF-10), blanks last. */
function compare(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/** Rows in the sorted order. Ties keep the page's own order (the sort is stable). */
export function sortRows<T>(rows: T[], sort: SortState | null, by: SortAccessors<T>): T[] {
  if (!sort) return rows
  const get = by[sort.key]
  if (!get) return rows
  const dir = sort.dir === 'desc' ? -1 : 1
  return [...rows].sort((r1, r2) => compare(get(r1), get(r2)) * dir)
}

export function useTableSort(defaultKey?: string, defaultDir: 'asc' | 'desc' = 'desc') {
  const [sort, setSort] = useState<SortState | null>(() =>
    defaultKey ? { key: defaultKey, dir: defaultDir } : null,
  )
  const toggle = (key: string, first: 'asc' | 'desc' = 'asc') =>
    setSort((s) =>
      s?.key !== key
        ? { key, dir: first }
        : s.dir === first
          ? { key, dir: first === 'asc' ? 'desc' : 'asc' }
          : null,
    )
  return { sort, toggle, setSort }
}

/** A column head that is itself the sort control. */
export function SortHeader({
  label,
  k,
  sort,
  onToggle,
  /** The direction this column is asked about first — dates newest, values largest. */
  first = 'asc',
  className,
}: {
  label: ReactNode
  k: string
  sort: SortState | null
  onToggle: (k: string, first?: 'asc' | 'desc') => void
  first?: 'asc' | 'desc'
  className?: string
}) {
  const active = sort?.key === k
  return (
    <th
      className={className}
      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`th-sort${active ? ' active' : ''}`}
        onClick={() => onToggle(k, first)}
      >
        {label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}

/**
 * On a phone the table has become cards and its column heads are gone, so the
 * sort moves into this select above the list — both directions spelled out,
 * because a select cannot re-fire on a re-pick of the same option.
 */
export function SortSelect({
  columns,
  sort,
  onPick,
}: {
  columns: { k: string; label: string; kind?: 'text' | 'num' | 'date' }[]
  sort: SortState | null
  onPick: (sort: SortState | null) => void
}) {
  // What each direction is called, per kind of column — "Date oldest first",
  // not "Date Z→A".
  const words: Record<string, [string, string]> = {
    text: ['A→Z', 'Z→A'],
    num: ['low → high', 'high → low'],
    date: ['oldest first', 'newest first'],
  }
  return (
    <select
      className="sort-select"
      aria-label="Sort list"
      value={sort ? `${sort.key}:${sort.dir}` : ''}
      onChange={(e) => {
        const v = e.target.value
        if (!v) return onPick(null)
        const [key, dir] = v.split(':')
        onPick({ key, dir: dir as 'asc' | 'desc' })
      }}
    >
      <option value="">Default order</option>
      {columns.flatMap((c) => {
        const [asc, desc] = words[c.kind || 'text']
        return [
          <option key={`${c.k}:asc`} value={`${c.k}:asc`}>
            {c.label} · {asc}
          </option>,
          <option key={`${c.k}:desc`} value={`${c.k}:desc`}>
            {c.label} · {desc}
          </option>,
        ]
      })}
    </select>
  )
}
