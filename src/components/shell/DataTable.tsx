import { useMemo, useState, type ReactNode } from 'react'
import { EmptyState } from '../EmptyState'
import { Skeleton } from './Skeleton'
import { sortRows, useTableSort, type SortAccessors } from '../tableSort'

/**
 * The one register grid (overhaul §2 SHELL): sticky header, sortable columns,
 * a density step, a column chooser, and the three states every screen owes
 * (loading skeleton / empty-or-filtered / rows). Sorting reuses the register
 * grids' own comparator (tableSort) so codes sort as codes here too.
 *
 * Density and column choices persist per device under the table's id — an
 * operator's packed production view is theirs, not a global. Bulk actions and
 * server pagination land with their first consumers (P3 lists, P5 reports);
 * the props below are the whole surface those will need to grow into.
 */
export interface Column<T> {
  key: string
  label: string
  render?: (row: T) => ReactNode
  /** Sort accessor; omit on unsortable columns. */
  sort?: (row: T) => string | number | null | undefined
  /** First-click direction — desc for dates/values, asc for names. */
  firstDir?: 'asc' | 'desc'
  align?: 'right' | 'center'
  /** Start hidden (still offered in the column chooser). */
  defaultHidden?: boolean
}

export interface DataTableProps<T> {
  /** Persisted-preferences key: one stable id per table. */
  id: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  loading?: boolean
  /** Rendered instead of rows when the fetch failed. */
  error?: ReactNode
  empty: string
  filtered?: boolean
  onClearFilters?: () => void
  onRowClick?: (row: T) => void
}

type Density = 'cosy' | 'compact'

export function DataTable<T>({
  id,
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  empty,
  filtered = false,
  onClearFilters,
  onRowClick,
}: DataTableProps<T>) {
  const prefKey = `roligt_table_${id}`
  const [density, setDensity] = useState<Density>(() =>
    readPref(prefKey).density ?? 'cosy',
  )
  const [hidden, setHidden] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {}
    for (const c of columns) if (c.defaultHidden) defaults[c.key] = true
    return { ...defaults, ...readPref(prefKey).hidden }
  })
  const [chooserOpen, setChooserOpen] = useState(false)
  const { sort, toggle } = useTableSort()

  const visible = columns.filter((c) => !hidden[c.key])
  const accessors = useMemo<SortAccessors<T>>(
    () => Object.fromEntries(columns.filter((c) => c.sort).map((c) => [c.key, c.sort!])),
    [columns],
  )
  const sorted = useMemo(
    () => sortRows(rows, sort, accessors),
    [rows, sort, accessors],
  )

  const saveDensity = (d: Density) => {
    setDensity(d)
    writePref(prefKey, { density: d })
  }
  const toggleColumn = (key: string) => {
    setHidden((h) => {
      const next = { ...h, [key]: !h[key] }
      writePref(prefKey, { hidden: next })
      return next
    })
  }

  return (
    <div className={`dt density-${density}`}>
      <div className="dt-toolbar">
        <div className="dt-density" role="group" aria-label="Row density">
          {(['cosy', 'compact'] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              className={density === d ? 'active' : ''}
              aria-pressed={density === d}
              onClick={() => saveDensity(d)}
            >
              {d === 'cosy' ? 'Cosy' : 'Compact'}
            </button>
          ))}
        </div>
        <div className="dt-columns">
          <button
            type="button"
            aria-expanded={chooserOpen}
            aria-haspopup="true"
            onClick={() => setChooserOpen((o) => !o)}
            onBlur={() => setChooserOpen(false)}
          >
            Columns
          </button>
          {chooserOpen ? (
            <div className="dt-chooser" role="menu">
              {columns.map((c) => (
                <label key={c.key}>
                  <input
                    type="checkbox"
                    checked={!hidden[c.key]}
                    onChange={() => toggleColumn(c.key)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="dt-error" role="alert">{error}</div>
      ) : loading ? (
        <Skeleton rows={4} />
      ) : (
        <div className="dt-scroll">
          <table>
            <thead>
              <tr>
                {visible.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : c.sort ? 'none' : undefined}
                  >
                    {c.sort ? (
                      <button type="button" onClick={() => toggle(c.key, c.firstDir ?? 'asc')}>
                        {c.label}
                        <span className="dt-sort-mark" aria-hidden="true">
                          {sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={visible.length}>
                    <EmptyState
                      filtered={filtered}
                      empty={empty}
                      onClear={() => onClearFilters?.()}
                    />
                  </td>
                </tr>
              ) : (
                sorted.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={onRowClick ? 'clickable' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') onRowClick(row)
                          }
                        : undefined
                    }
                  >
                    {visible.map((c) => (
                      <td key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Per-device preferences (density, column choices) — convenience state, so
// localStorage's failure modes never take the table down with them.
function readPref(key: string): { density?: Density; hidden?: Record<string, boolean> } {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}')
  } catch {
    return {}
  }
}
function writePref(key: string, patch: { density?: Density; hidden?: Record<string, boolean> }) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...readPref(key), ...patch }))
  } catch {
    // refuse-and-carry-on
  }
}
