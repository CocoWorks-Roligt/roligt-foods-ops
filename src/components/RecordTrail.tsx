import { Fragment } from 'react'
import { useApp } from '../context/AppContext'
import { historyOf } from '../lib/audit'
import { KIND_LABEL, linkedRecords, type DocRef } from '../lib/links'
import { fmtDate } from '../lib/utils'
import { DocLink } from './DocLink'

/**
 * Where a record sits in the chain, and everything that has happened to it.
 *
 * Shown at the foot of every record's View: what it came from and what it went into,
 * each one a link to open, then its own audit history — the entries about this record
 * and nothing else. A QC record reads as the step between a batch and its packs, with
 * the goods receipt the batch was pressed from one click away.
 */
export function RecordTrail({ record }: { record: string }) {
  const { state } = useApp()
  const linked = linkedRecords(state, record)
  const history = historyOf(state, record)
  return (
    <>
      <LinkSection title="Came from" refs={linked.cameFrom} />
      <LinkSection title="Went into" refs={linked.wentInto} />
      <div className="detail-section">
        <h4>History</h4>
        {!history.length ? (
          <div className="small">No audit entries for this record.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="cell-tight">When</th>
                  <th className="cell-tight">Who</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
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
        )}
      </div>
    </>
  )
}

/** One field per kind of record, so three receipts read as one line of three links. */
function LinkSection({ title, refs }: { title: string; refs: DocRef[] }) {
  if (!refs.length) return null
  const byKind = new Map<string, DocRef[]>()
  for (const r of refs) {
    const label = KIND_LABEL[r.kind]
    const list = byKind.get(label)
    if (list) list.push(r)
    else byKind.set(label, [r])
  }
  return (
    <div className="detail-section">
      <h4>{title}</h4>
      <div className="detail-grid">
        {[...byKind].map(([label, list]) => (
          <div className={`detail-item${list.length > 2 ? ' wide' : ''}`} key={label}>
            <span className="detail-label">{label}</span>
            <span className="detail-value">
              {list.map((r, i) => (
                <Fragment key={r.id}>
                  {i ? ', ' : ''}
                  <DocLink doc={r.id} />
                </Fragment>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
