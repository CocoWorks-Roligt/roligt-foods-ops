import { Fragment, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { batchKind, batchLabel, fmtBulk } from '../lib/batches'
import { describeIssue } from '../lib/issues'
import { itemName, locationLabel, stockRowKey } from '../lib/stock'
import { traceChain, type TraceResult } from '../lib/trace'
import { sourceKey, traceGraph } from '../lib/traceGraph'
import { outputStockIds, packStockIds, receiptsFor, runsFilling, stockIdsOfRow } from '../lib/stockIds'
import { sampleProductName } from '../lib/controlSamples'
import { categoryTitle } from '../lib/qcCategories'
import { scoreSensory } from '../lib/sensory'
import { fmtDate, fmtQty, inr, localDay } from '../lib/utils'
import type { QcRecord, StockIssue } from '../types'

/** Just the day, for the dates a node carries — a trace reads by day, not by minute. */
const day = (s?: string) => (s ? fmtDate(localDay(s)) : '')

/** A stored date or timestamp as a point in time, a bare date read as local midnight. */
const moment = (s: string) => {
  const t = Date.parse(s.includes('T') ? s : `${s.slice(0, 10)}T00:00`)
  return Number.isNaN(t) ? 0 : t
}

/**
 * The network view pulls in d3-force, which nothing else in the app needs — so it loads
 * the first time somebody opens it, not with every screen.
 */
const TraceNetwork = lazy(() =>
  import('../components/TraceNetwork').then((m) => ({ default: m.TraceNetwork })),
)


export function Traceability() {
  const { state, rows, getItemName } = useApp()
  const [params] = useSearchParams()
  const [term, setTerm] = useState(() => params.get('q') || '')
  const [result, setResult] = useState<TraceResult | null>(null)
  const [empty, setEmpty] = useState(false)
  /** Whether the chain is scrolled to its right-hand end, so the fade can get out of
   *  the way once there is genuinely nothing more to see. */
  const [chainAtEnd, setChainAtEnd] = useState(false)
  /** Two ways to read one trace: every record and every link between them, or the row of stages. */
  const [view, setView] = useState<'network' | 'chain'>('network')

  const inScope = (scope: 'all' | string[] | undefined, value: string) =>
    scope === 'all' || !!scope?.includes(value)

  /** A batch's outputs this trace is about, each with its stock ID. */
  const shownOutputs = (batchId: string) => {
    const b = state.batches.find((x) => x.id === batchId)
    return b ? outputStockIds(b).filter((l) => inScope(result?.outputs[batchId], l.item)) : []
  }

  /** A packing run's lines this trace is about, each with its stock ID. */
  const shownLines = (runId: string) => {
    const r = state.packingRuns.find((x) => x.id === runId)
    return r ? packStockIds(r).filter((l) => inScope(result?.lines[runId], l.sku)) : []
  }

  /** A QC record belongs to the trace when the product it tested does. */
  const qcShown = (q: QcRecord) => inScope(result?.outputs[q.batchId], q.item || '')

  /** "QC Released" for one product, "1/2 released" once there are several. */
  const qcSummary = (batchId: string) => {
    const records = state.qcs.filter((q) => q.batchId === batchId && qcShown(q))
    if (!records.length) return 'QC N/A'
    if (records.length === 1) return `QC ${records[0].disposition}`
    const released = records.filter((q) => q.disposition === 'Released').length
    return `QC ${released}/${records.length} released`
  }

  /** The lines of a stock issue that took stock this trace is about — one issue can take from several batches. */
  const issueLinesInChain = (i: StockIssue) => {
    if (!result) return i.lines
    const inChain = i.lines.filter((l) => {
      if (l.itemType === 'Raw Material') return result.lots.includes(l.lot)
      if (l.itemType === 'Semi Finished') return inScope(result.outputs[l.lot], l.item)
      if (l.itemType === 'Finished Goods') {
        const filled = runsFilling(state, l.lot, l.item, {
          expiry: l.expiry,
          location: l.location,
          time: i.date,
        })
        return filled.length
          ? filled.some((r) => inScope(result.lines[r.id], l.item))
          : result.batches.includes(l.lot)
      }
      return receiptsFor(state, l.item, l.lot, { location: l.location, time: i.date }).some(
        (doc) => result.materials.includes(doc),
      )
    })
    return inChain.length ? inChain : i.lines
  }

  /**
   * Every dated event in the chain, oldest first.
   *
   * The chain above reads left to right and scrolls sideways, which is the right shape
   * for *what came from what* and the wrong one for *when*. A recall is a question
   * about time — when was it cut, when did it arrive, when did it go out — so the same
   * chain is also laid out as a timeline, where the dates line up under each other and
   * a gap between harvest and pressing is visible at a glance.
   */
  const timeline = () => {
    if (!result) return []
    const out: { when: string; stage: string; reference: string; detail: string }[] = []
    const add = (when: string | undefined, stage: string, reference: string, detail: string) => {
      if (when) out.push({ when, stage, reference, detail })
    }

    for (const id of result.lots) {
      const g = state.grns.find((x) => x.lot === id)
      if (!g) continue
      const unit = (g.uom || 'Piece').toLowerCase()
      add(
        g.harvestedOn,
        'Harvested',
        id,
        [g.productName, g.farmer && `by ${g.farmer}`, g.area].filter(Boolean).join(' · '),
      )
      add(
        g.date,
        'Received',
        `${g.id} · ${id}`,
        `${g.accepted} ${unit} accepted from ${g.farmerName || g.farmer || 'a direct farmer'}`,
      )
    }
    for (const id of result.batches) {
      const b = state.batches.find((x) => x.id === id)
      if (!b) continue
      add(
        b.date,
        batchKind(b) === 'Melange' ? 'Blended' : 'Produced',
        id,
        `${batchLabel(state, b)} — ${shownOutputs(id)
          .map((l) => `${l.stockId} ${fmtBulk(l.qty, l.uom)} ${itemName(state, l.item)}`)
          .join(' + ')}`,
      )
      for (const q of state.qcs.filter((x) => x.batchId === id && x.reviewedAt && qcShown(x))) {
        add(
          q.reviewedAt,
          'QC reviewed',
          `${q.id} · ${id}`,
          `${itemName(state, q.item || '')} ${q.disposition.toLowerCase()}`,
        )
      }
      for (const r of state.labReports.filter((x) => x.batchId === id)) {
        add(
          r.scores ? r.sampleDate : r.issueDate,
          'Tested',
          r.id,
          r.scores
            ? `${categoryTitle(state, r.category)} — ${scoreSensory(r.scores, r).decision.toLowerCase()}`
            : `${categoryTitle(state, r.category)} for ${r.customerName}`,
        )
      }
    }
    for (const doc of result.materials) {
      const l = state.ledger.find((x) => x.type === 'PM Receipt' && x.doc === doc)
      if (!l) continue
      const vendor = state.vendors.find((v) => v.id === l.vendorId)?.name
      add(
        l.time,
        'Material received',
        doc,
        `${fmtQty(l.qtyIn)} ${l.uom} ${itemName(state, l.item)} · supplier lot ${l.lot}${vendor ? ` from ${vendor}` : ''}`,
      )
    }
    for (const id of result.packings) {
      const p = state.packingRuns.find((x) => x.id === id)
      if (!p) continue
      const lines = shownLines(id)
      add(
        p.date,
        'Packed',
        `${id} · ${p.batchId}`,
        lines.map((l) => `${l.stockId} ${l.packs} × ${getItemName(l.sku)}`).join(', '),
      )
      // The shelf life a pack carries is a date the chain has to show: it is the one
      // that says whether stock still in the trade is fit to be there.
      for (const expiry of [...new Set(lines.map((l) => l.expiry).filter(Boolean))]) {
        add(expiry, 'Best before', id, 'Packs from this run')
      }
      // Control samples are not stock, but they are part of what the run made and the
      // record an auditor asks for: who kept them, when they expired, when they went.
      for (const s of p.controlSamples || []) {
        const what = `${s.count} × ${sampleProductName(state, p, s)}`
        add(p.date, 'Control samples kept', id, `${what}${s.collectedBy ? ` · collected by ${s.collectedBy}` : ''}`)
        add(s.expiresOn, 'Control samples expire', id, what)
        add(s.destroyedOn, 'Control samples destroyed', id, `${what}${s.remark ? ` · ${s.remark}` : ''}`)
      }
    }
    for (const id of result.dispatches) {
      const d = state.dispatches.find((x) => x.id === id)
      if (!d) continue
      add(
        d.dispatchTime,
        'Dispatched',
        `${id} · ${d.challan}`,
        `${d.qty} × ${getItemName(d.sku)} to ${d.customerName}`,
      )
      add(d.expected, 'Delivery expected', id, d.customerName)
      add(d.deliveredTime, 'Delivered', id, `${d.status}${d.pod ? ` — received by ${d.pod}` : ''}`)
    }
    for (const id of result.issues) {
      const i = (state.stockIssues || []).find((x) => x.id === id)
      if (!i) continue
      const lines = issueLinesInChain(i)
      add(
        i.date,
        'Stock issued',
        id,
        [
          i.reason,
          i.recipient,
          describeIssue(state, lines),
          `from ${[...new Set(lines.map((l) => l.lot))].join(', ')}`,
        ]
          .filter(Boolean)
          .join(' · '),
      )
    }
    for (const oid of orderIds()) {
      const o = state.orders.find((x) => x.id === oid)
      if (o) add(o.date, 'Ordered', oid, o.customerName)
    }

    return out.sort((a, b) => moment(a.when) - moment(b.when))
  }

  const orderIds = () =>
    result
      ? [
          ...new Set(
            result.dispatches
              .map((id) => state.dispatches.find((d) => d.id === id)?.orderId)
              .filter(Boolean) as string[],
          ),
        ]
      : []

  const runTrace = (raw: string) => {
    if (!raw.trim()) {
      setResult(null)
      setEmpty(false)
      return
    }
    const found = traceChain(state, raw)
    setResult(found)
    setEmpty(!found)
  }

  /**
   * `?q=` runs the trace on arrival, so an item on the Inventory screen opens straight
   * onto its chain instead of leaving the operator to copy a code between screens.
   */
  const linked = params.get('q') || ''
  useEffect(() => {
    if (linked) runTrace(linked)
    // Once per linked term. runTrace reads the state it is called with; re-running it
    // on every save would reset a trace the operator is in the middle of reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])

  /**
   * The chain, stage by stage, with the empty stages left out.
   *
   * Every stage used to be preceded by an arrow whether it had anything in it or not,
   * so a batch not yet packed or dispatched ended in a row of arrows pointing at
   * nothing. Arrows now go only between two stages that both hold something.
   */
  const stages: ReactNode[][] = result
    ? [
        result.sources.map((key) => {
          const vendor = state.vendors.find((x) => x.id === key)
          // A vendor supplies many lots; only the ones in this chain say anything about it here.
          const received = state.grns.filter(
            (x) => sourceKey(x) === key && result.lots.includes(x.lot),
          )
          const g = received[0] || state.grns.find((x) => sourceKey(x) === key)
          const harvested = [
            ...new Set(received.map((x) => x.harvestedOn).filter(Boolean)),
          ] as string[]
          return (
            <div className="node" key={key}>
              <div className="small">{vendor ? 'Vendor / Source' : 'Direct farmer'}</div>
              <b>{vendor?.name || g?.farmer || key}</b>
              <div className="small">{vendor ? key : g?.area || 'No vendor record'}</div>
              {harvested.length ? (
                <div className="trace-date">
                  Harvested {harvested.map((h) => day(h)).join(', ')}
                </div>
              ) : null}
            </div>
          )
        }),
        result.lots.map((id) => {
          const g = state.grns.find((x) => x.lot === id)
          return (
            <div className="node" key={id}>
              <div className="small">Procurement Lot</div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">{g?.productName || 'Tender Coconut'}</div>
              <div className="small">
                {g?.accepted || 0} {(g?.uom || 'Piece').toLowerCase()} ·{' '}
                {inr(g?.usableCost || 0)}/{(g?.uom || 'Piece').toLowerCase()}
              </div>
              {g?.farmer && <div className="small">Farmer: {g.farmer}</div>}
              {g?.area && <div className="small">Area: {g.area}</div>}
              <div className="trace-date">
                {g?.harvestedOn ? `Harvested ${day(g.harvestedOn)} · ` : ''}
                Received {day(g?.date) || '—'}
              </div>
            </div>
          )
        }),
        result.batches.map((id) => {
          const b = state.batches.find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">
                {b && batchKind(b) === 'Melange' ? 'Melange Run' : 'Production Batch'}
              </div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">
                {b ? batchLabel(state, b) : ''} · {qcSummary(id)}
              </div>
              {shownOutputs(id).map((l) => (
                <div className="small" key={l.stockId}>
                  <span className="cell-id">{l.stockId}</span> · {itemName(state, l.item)} ·{' '}
                  {fmtBulk(l.qty, l.uom)}
                </div>
              ))}
              {b?.blendLines?.length ? (
                <div className="small">from {b.blendLines.map((l) => l.lot).join(', ')}</div>
              ) : null}
              <div className="trace-date">Produced {day(b?.date) || '—'}</div>
            </div>
          )
        }),
        result.materials.map((doc) => {
          const receipt = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
          const vendor = state.vendors.find((v) => v.id === receipt?.vendorId)?.name
          return (
            <div className="node" key={doc}>
              <div className="small">Packing Material</div>
              <b>
                <DocLink doc={doc} />
              </b>
              <div className="small">{receipt ? itemName(state, receipt.item) : ''}</div>
              {receipt ? (
                <div className="small">
                  {fmtQty(receipt.qtyIn)} {receipt.uom} · supplier lot {receipt.lot}
                </div>
              ) : null}
              {vendor ? <div className="small">Supplier: {vendor}</div> : null}
              <div className="trace-date">Received {day(receipt?.time) || '—'}</div>
            </div>
          )
        }),
        result.packings.map((id) => {
          const p = state.packingRuns.find((x) => x.id === id)
          const lines = shownLines(id)
          const expiries = ([...new Set(lines.map((l) => l.expiry).filter(Boolean))] as string[]).sort()
          return (
            <div className="node" key={id}>
              <div className="small">Packing Run</div>
              <b>
                <DocLink doc={id} />
              </b>
              {lines.map((l) => (
                <div className="small" key={l.stockId}>
                  <span className="cell-id">{l.stockId}</span> · {l.packs} × {getItemName(l.sku)}
                </div>
              ))}
              {p
                ? (p.controlSamples || []).map((s, i) => (
                    <div className="small" key={`sample-${i}`}>
                      Control samples · {s.count} × {sampleProductName(state, p, s)}
                    </div>
                  ))
                : null}
              <div className="trace-date">
                Packed {day(p?.date) || '—'}
                {expiries.length
                  ? ` · best before ${expiries.map((e) => day(e)).join(', ')}`
                  : ''}
              </div>
            </div>
          )
        }),
        result.dispatches.map((id) => {
          const d = state.dispatches.find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">Dispatch</div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">
                {d?.challan || ''} · {d?.status || ''}
              </div>
              <div className="trace-date">
                Dispatched {day(d?.dispatchTime) || '—'}
                {d?.deliveredTime ? ` · delivered ${day(d.deliveredTime)}` : ''}
              </div>
            </div>
          )
        }),
        result.issues.map((id) => {
          const i = (state.stockIssues || []).find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">Stock Issue</div>
              <b>
                <DocLink doc={id} />
              </b>
              <div className="small">{i?.reason}</div>
              {i?.recipient ? <div className="small">{i.recipient}</div> : null}
              <div className="trace-date">Issued {day(i?.date) || '—'}</div>
            </div>
          )
        }),
        orderIds().map((oid) => {
          const o = state.orders.find((x) => x.id === oid)
          return (
            <div className="node" key={oid}>
              <div className="small">Order</div>
              <b>
                <DocLink doc={oid} />
              </b>
              <div className="small">{o?.customerName}</div>
              <div className="small">
                {o?.lines.length || 0} line{(o?.lines.length || 0) === 1 ? '' : 's'} ·{' '}
                {o?.status}
              </div>
              <div className="trace-date">
                Ordered {day(o?.date) || '—'}
                {o?.dispatchedAt ? ` · sent ${day(o.dispatchedAt)}` : ''}
              </div>
            </div>
          )
        }),
        result.customers.map((id) => {
          const c = state.customers.find((x) => x.id === id)
          return (
            <div className="node" key={id}>
              <div className="small">Customer</div>
              <b>{c?.name || id}</b>
              <div className="small">{id}</div>
            </div>
          )
        }),
      ].filter((stage) => stage.length)
    : []

  /**
   * What the chain's items are holding right now. A row can pool two runs' packs — or two
   * deliveries of one supplier lot — so it belongs when any item it holds is in the chain,
   * and is labelled with just those.
   */
  const chainStock = result
    ? rows.flatMap((row) => {
        const ids = stockIdsOfRow(state, row).filter((id) => result.stockIds.includes(id))
        return ids.length ? [{ row, ids }] : []
      })
    : []

  const graph = useMemo(() => (result ? traceGraph(state, result) : null), [result, state])

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Traceability Search</h3>
          <span>
            Backward and forward in one page — every link, and the date it happened on
          </span>
        </div>
      </div>
      <div className="toolbar">
        <input
          className="trace-search"
          placeholder="Enter a stock ID, lot, farmer, product, batch, packing run, dispatch, challan, order or customer"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runTrace(term)
          }}
        />
        <button className="btn btn-primary" onClick={() => runTrace(term)}>
          Trace
        </button>
      </div>

      {!result && !empty && (
        <div className="empty">
          Enter a lot, farmer, product or batch to see everything that came out of it — or one
          stock ID (BAT-2026-0002/1), packing run, dispatch, challan, order or stock issue to see
          just that record's chain.
        </div>
      )}
      {empty && (
        <div className="empty">
          {/* The same affordance every other searchable screen offers: say nothing
              matched, and give the way back out rather than leaving the operator to
              clear the box themselves. */}
          <EmptyState
            filtered
            empty="No linked records found."
            onClear={() => {
              setTerm('')
              setEmpty(false)
              setResult(null)
            }}
          />
        </div>
      )}

      {result && (
        <>
          <div className="type-tabs trace-view-tabs" role="tablist">
            <button
              type="button"
              className={`type-tab ${view === 'network' ? 'active' : ''}`}
              onClick={() => setView('network')}
            >
              Network
            </button>
            <button
              type="button"
              className={`type-tab ${view === 'chain' ? 'active' : ''}`}
              onClick={() => setView('chain')}
            >
              Chain
            </button>
          </div>

          {view === 'network' && graph ? (
            <Suspense fallback={<div className="empty">Laying out the network…</div>}>
              <TraceNetwork graph={graph} />
            </Suspense>
          ) : (
            <div
              className="trace-chain-wrap"
              style={{ ['--trace-fade' as string]: chainAtEnd ? 0 : 1 }}
            >
              <div
                className="trace-chain"
                onScroll={(e) => {
                  const el = e.currentTarget
                  setChainAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
                }}
              >
                {stages.map((nodes, i) => (
                  <Fragment key={i}>
                    {i > 0 ? <div className="arrow">→</div> : null}
                    {nodes}
                  </Fragment>
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ marginTop: 12 }}>
            <h3>Key dates</h3>
            <span className="small">
              Everything in the chain in the order it happened — harvest, receipt, pressing, QC,
              packing, dispatch and delivery
            </span>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th className="cell-tight">Date</th>
                    <th className="cell-tight">What happened</th>
                    <th>Reference</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {!timeline().length ? (
                    <tr>
                      <td colSpan={4} className="empty">
                        Nothing in this chain carries a date.
                      </td>
                    </tr>
                  ) : (
                    timeline().map((e, i) => (
                      <tr key={`${e.stage}-${e.reference}-${e.when}-${i}`}>
                        <td data-label="Date" className="cell-tight">
                          <b>{day(e.when)}</b>
                        </td>
                        <td data-label="What happened" className="cell-tight">
                          {e.stage}
                        </td>
                        <td data-label="Reference" className="cell-id">
                          {e.reference}
                        </td>
                        <td data-label="Detail">{e.detail}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <div className="card">
              <h3>Linked QC evidence</h3>
              {/* One row per product, not per batch: a pressing is tested twice and a
                  recall has to know which of the two failed. */}
              {result.batches.flatMap((id) =>
                state.qcs
                  .filter((x) => x.batchId === id && qcShown(x))
                  .map((q) => (
                    <div className="kpi-row" key={q.id}>
                      <span>
                        {itemName(state, q.item || '') || q.id} · {id}
                        <div className="small">
                          {q.id}
                          {q.reviewedAt ? ` · reviewed ${day(q.reviewedAt)}` : ''}
                        </div>
                      </span>
                      <StatusBadge value={q.disposition} />
                    </div>
                  )),
              )}
              {!result.batches.some((id) =>
                state.qcs.some((x) => x.batchId === id && qcShown(x)),
              ) ? (
                <div className="small">No QC records against this chain.</div>
              ) : null}
            </div>
            <div className="card">
              <h3>Lab reports</h3>
              {result.batches.flatMap((id) =>
                state.labReports
                  .filter((r) => r.batchId === id)
                  .map((r) => (
                    <div className="kpi-row" key={r.id}>
                      <span>
                        <DocLink doc={r.id} /> · {categoryTitle(state, r.category)}
                        <div className="small">
                          {id}
                          {r.scores ? ` · ${scoreSensory(r.scores, r).decision.toLowerCase()}` : ''}
                          {` · ${fmtDate(r.scores ? r.sampleDate : r.issueDate)}`}
                        </div>
                      </span>
                    </div>
                  )),
              )}
              {!result.batches.some((id) => state.labReports.some((r) => r.batchId === id)) ? (
                <div className="small">No lab reports against this chain.</div>
              ) : null}
            </div>
            <div className="card">
              <h3>Current stock</h3>
              {chainStock.map(({ row: r, ids }) => (
                <div className="kpi-row" key={stockRowKey(r)}>
                  <span>
                    <b className="cell-id">{ids.join(' + ')}</b> · {getItemName(r.item)}{' '}
                    <StatusBadge value={r.status} />
                    <div className="small">{locationLabel(state, r.location)}</div>
                  </span>
                  <b>
                    {fmtQty(r.qty)} {r.uom}
                  </b>
                </div>
              ))}
              {!chainStock.length && <div className="small">No current balance.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
