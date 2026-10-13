/**
 * The global search palette (ARCHITECTURE §1): Ctrl/Cmd+K, type, land on the
 * thing — lots, runs, orders, challans, customers, suppliers, storage
 * locations, shipments — over GET /api/search. One input, one list, the
 * keyboard does everything: arrows move, Enter opens, Esc closes. A mouse
 * works too, on rows that meet the 44px target rule.
 *
 * Results keep the server's order within each kind; the kinds themselves
 * group under headings so a scan can jump to the section it came for.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../../lib/contracts.ts'

/** One flat, keyboard-addressable list of the grouped results. */
interface Row {
  result: SearchResult
  /** True when this row is the first of its kind — it carries the heading. */
  head: boolean
}

const KIND_LABELS: Record<string, string> = {
  lot: 'Lots',
  batch: 'Batches & Runs',
  order: 'Orders',
  challan: 'Challans',
  customer: 'Customers',
  vendor: 'Suppliers',
  storageLocation: 'Storage Locations',
  shipment: 'Shipments',
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  // Every open starts clean — the last search is nobody's head start.
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setError(null)
      setActive(0)
      // The dialog is not focus-trapped beyond the input; the input is the
      // only thing to type into and Esc/Enter both act on it.
      inputRef.current?.focus()
    }
  }, [open])

  const q = query.trim()

  // Debounced search: a newer query's answer never overwrites a newer state.
  useEffect(() => {
    if (!open || q.length < 2) {
      setResults([])
      setLoading(false)
      setError(null)
      return
    }
    let mine = true
    const t = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
        if (!mine) return
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as { results?: SearchResult[] }
        if (!mine) return
        setResults(body.results ?? [])
        setActive(0)
      } catch {
        if (mine) setError('Search cannot be reached right now.')
      } finally {
        if (mine) setLoading(false)
      }
    }, 250)
    return () => {
      mine = false
      clearTimeout(t)
    }
  }, [q, open])

  // The list the keyboard walks: server order, kind headings on first-of-kind.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    let prevKind = ''
    for (const result of results) {
      out.push({ result, head: result.kind !== prevKind })
      prevKind = result.kind
    }
    return out
  }, [results])

  const go = (href: string) => {
    onClose()
    navigate(href)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const row = rows[active]
      if (row) {
        e.preventDefault()
        go(row.result.href)
      }
    }
  }

  // The active row stays in view when the keyboard outruns the scroll.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active, rows])

  if (!open) return null

  return (
    <div className="palette-scrim" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder="Search lots, runs, orders, challans, customers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" id={listId} role="listbox">
          {error ? (
            <p className="palette-note">{error}</p>
          ) : q.length < 2 ? (
            <p className="palette-note">Type at least two characters to search.</p>
          ) : loading ? (
            <p className="palette-note">Searching…</p>
          ) : rows.length === 0 ? (
            <p className="palette-note">Nothing matches “{q}”.</p>
          ) : (
            rows.map(({ result, head }, i) => (
              <div key={`${result.kind}-${result.id}`}>
                {head ? <div className="palette-kind">{KIND_LABELS[result.kind] ?? result.kind}</div> : null}
                <button
                  ref={i === active ? activeRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'palette-row active' : 'palette-row'}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(result.href)}
                >
                  <span className="palette-label">{result.label}</span>
                  {result.sublabel ? <span className="palette-sub">{result.sublabel}</span> : null}
                </button>
              </div>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ move</span>
          <span>Enter opens</span>
          <span>Esc closes</span>
        </div>
      </div>
    </div>
  )
}
