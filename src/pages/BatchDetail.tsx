/**
 * Batch/Lot Detail (WORKFLOW, `pipeline` flag): one batch's whole story — the
 * timeline of what happened to it, its genealogy both ways (the same isomorphic
 * walk Traceability runs), and the one next action, with every refused action
 * saying why in plain words. Reached from the Pipeline board's stage tables;
 * the model is src/lib/batchDetail.ts, folded pure.
 */
import { Link, useParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { batchDetail } from '../lib/batchDetail.ts'
import { fmtDate } from '../lib/utils.ts'
import { useSessionPermissions } from '../lib/sessionPermissions.ts'

const KIND_LABEL: Record<string, string> = {
  grn: 'Receipt',
  batch: 'Batch',
  packing: 'Packing run',
  order: 'Order',
  dispatch: 'Dispatch',
  shipment: 'Shipment',
  challan: 'Challan',
}

export function BatchDetail() {
  const { id = '' } = useParams()
  const { state, flags } = useApp()
  const permissions = useSessionPermissions()
  const model = batchDetail(state, id, permissions, flags.qc_gate_v2)

  if (!model) {
    return (
      <div className="card">
        <EmptyState filtered={false} empty={`No batch records itself as “${id}”.`} onClear={() => {}} />
        <p>
          <Link className="btn btn-chip" to="/pipeline">
            Back to the pipeline
          </Link>
        </p>
      </div>
    )
  }

  const { batch, kindLabel, timeline, actions, upstream, downstream, truncated } = model
  const primary = actions.find((a) => a.legal)
  const refused = actions.filter((a) => !a.legal)

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>
            {batch.id} · {kindLabel}
          </h3>
          <span>
            Recorded {fmtDate(batch.date)} · <StatusBadge value={batch.status} />
          </span>
        </div>
        <Link className="btn btn-chip" to="/pipeline">
          Pipeline
        </Link>
      </div>

      <div className="batch-next">
        {primary ? (
          <Link className="btn btn-primary batch-next-btn" to={primary.href!}>
            {primary.label}
          </Link>
        ) : actions.length ? (
          <p className="batch-next-none">Nothing you can do next yourself — see below for who can.</p>
        ) : (
          <p className="batch-next-none">Nothing waiting — this record is complete.</p>
        )}
        {refused.length ? (
          <ul className="batch-refused">
            {refused.map((a) => (
              <li key={a.key}>
                <span className="batch-refused-label">{a.label}</span>
                <span className="cell-sub"> — {a.why}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="batch-columns">
        <section>
          <h4>Timeline</h4>
          <ol className="batch-timeline">
            {timeline.map((e, i) => (
              <li key={i}>
                <div className="batch-when">{e.at ? fmtDate(e.at) : '—'}</div>
                <div>
                  <div>
                    {e.label} {e.status ? <StatusBadge value={e.status} /> : null}
                  </div>
                  {e.detail ? <div className="cell-sub">{e.detail}</div> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h4>Genealogy</h4>
          <h5 className="batch-gene-title">Made from</h5>
          {upstream.length ? (
            <ul className="batch-gene">
              {upstream.map((n) => (
                <li key={n.id}>
                  <span className="batch-gene-kind">{KIND_LABEL[n.kind] ?? n.kind}</span> {n.label}
                  {n.at ? <span className="cell-sub"> · {fmtDate(n.at)}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="cell-sub">Nothing upstream recorded.</p>
          )}
          <h5 className="batch-gene-title">Became</h5>
          {downstream.length ? (
            <ul className="batch-gene">
              {downstream.map((n) => (
                <li key={n.id}>
                  <span className="batch-gene-kind">{KIND_LABEL[n.kind] ?? n.kind}</span> {n.label}
                  {n.at ? <span className="cell-sub"> · {fmtDate(n.at)}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="cell-sub">Nothing downstream yet.</p>
          )}
          {truncated ? <p className="cell-sub">Deeper links exist — the full graph is on Traceability.</p> : null}
        </section>
      </div>
    </div>
  )
}
