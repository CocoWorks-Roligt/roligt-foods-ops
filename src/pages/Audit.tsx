import { useMemo, useState } from 'react'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { useApp } from '../context/AppContext'
import { transactions } from '../lib/audit'
import { KIND_LABEL } from '../lib/links'
import { fmtDate } from '../lib/utils'
import type { AuditEntry } from '../types'

type View = 'transactions' | 'entries'

const matches = (a: AuditEntry, q: string) =>
  [a.time, a.role, a.action, a.doc, a.details].join(' ').toLowerCase().includes(q)

/**
 * The audit trail, a line per transaction.
 *
 * It was one long list of every entry, newest first — the answer to "what happened
 * today" and to nothing else. What the plant asks of an audit trail is about a record:
 * who received this lot, who changed that batch, who released the malai and when. So
 * each line is one transaction — a receipt, a batch, a QC record, a run, a dispatch —
 * with its whole trail underneath it, and its number opens the record itself. The flat
 * list is still here for the day-by-day question.
 */
export function Audit() {
  const { state } = useApp()
  const [search, setSearch] = useState('')
  const [view, setView] = useState<View>('transactions')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const q = search.trim().toLowerCase()

  const groups = useMemo(() => {
    const all = transactions(state)
    if (!q) return all
    return all.filter((t) => t.id.toLowerCase().includes(q) || t.entries.some((a) => matches(a, q)))
  }, [q, state])

  /** Every entry, newest first, for when the question is about a day rather than a record. */
  const list = useMemo(() => {
    const rows = [...state.audits].sort((a, b) => b.time.localeCompare(a.time))
    return q ? rows.filter((a) => matches(a, q)) : rows
  }, [q, state.audits])

  const empty = (
    <EmptyState
      filtered={!!search}
      empty="Nothing has been posted yet."
      onClear={() => setSearch('')}
    />
  )

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Audit Log</h3>
          <span>
            A line per transaction, with everything that happened to it — entries are never
            edited or removed
          </span>
        </div>
      </div>

      <div className="vendors-toolbar">
        <div className="type-tabs" role="tablist">
          <button
            type="button"
            className={`type-tab ${view === 'transactions' ? 'active' : ''}`}
            onClick={() => setView('transactions')}
          >
            By transaction
          </button>
          <button
            type="button"
            className={`type-tab ${view === 'entries' ? 'active' : ''}`}
            onClick={() => setView('entries')}
          >
            Every entry
          </button>
        </div>
        <input
          className="vendors-search"
          placeholder="Search record, action, detail or user"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {view === 'transactions' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>Type</th>
                <th>Last activity</th>
                <th>Last action</th>
                <th className="cell-num cell-tight">Entries</th>
                <th className="cell-actions">Trail</th>
              </tr>
            </thead>
            <tbody>
              {!groups.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    {empty}
                  </td>
                </tr>
              ) : (
                groups.map((t) => {
                  const last = t.entries[0]
                  const expanded = !!open[t.id]
                  return [
                    <tr key={t.id}>
                      <td data-label="Record" className="cell-id">
                        <DocLink doc={t.id} />
                      </td>
                      <td data-label="Type">{t.kind ? KIND_LABEL[t.kind] : '—'}</td>
                      <td data-label="Last activity">
                        {fmtDate(last.time)}
                        <div className="cell-sub">{last.role}</div>
                      </td>
                      <td data-label="Last action">
                        <b>{last.action}</b>
                        <div className="cell-sub">{last.details}</div>
                      </td>
                      <td data-label="Entries" className="cell-num cell-tight">
                        {t.entries.length}
                      </td>
                      <td className="cell-actions">
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => setOpen((o) => ({ ...o, [t.id]: !expanded }))}
                        >
                          {expanded ? 'Hide trail' : 'Show trail'}
                        </button>
                      </td>
                    </tr>,
                    expanded ? (
                      <tr key={`${t.id}-trail`} className="subrow">
                        <td colSpan={6}>
                          <div className="table-wrap audit-trail">
                            <table>
                              <thead>
                                <tr>
                                  <th className="cell-tight">When</th>
                                  <th className="cell-tight">Who</th>
                                  <th>What</th>
                                </tr>
                              </thead>
                              <tbody>
                                {/* The trail reads the way it happened: first entry first. */}
                                {[...t.entries].reverse().map((a) => (
                                  <tr key={a.id}>
                                    <td data-label="When" className="cell-tight">
                                      {fmtDate(a.time)}
                                    </td>
                                    <td data-label="Who" className="cell-tight">
                                      {a.role}
                                    </td>
                                    <td data-label="What">
                                      <b>{a.action}</b>
                                      <div className="small">{a.details}</div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ]
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Action</th>
                <th>Document</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td data-label="Timestamp">{fmtDate(a.time)}</td>
                  <td data-label="User">{a.role}</td>
                  <td data-label="Action">
                    <b>{a.action}</b>
                  </td>
                  <td data-label="Document">
                    <DocLink doc={a.doc} />
                  </td>
                  <td data-label="Details">{a.details}</td>
                </tr>
              ))}
              {!list.length ? (
                <tr>
                  <td colSpan={5} className="empty">
                    {empty}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
