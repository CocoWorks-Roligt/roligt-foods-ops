/**
 * Packing Materials — what the plant has on hand, and how much of it is left.
 *
 * This page used to do three jobs at once: list stock by lot, list every receipt ever
 * posted, and receive new stock through a form of its own. So the question it exists
 * to answer — do we have enough BiBs to run tomorrow? — was buried under a second
 * table about how they arrived, and packing material was bought on a completely
 * different screen from everything else the plant buys.
 *
 * Receiving lives on Procurement now, beside produce. What is left here is the answer:
 * one row per material, what is on hand across every lot, and whether it is below the
 * level somebody set. The lots behind a row are there when you want them.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { lowStockItems } from '../lib/alerts'
import { fmtRowTotal, locationLabel, stockRowKey } from '../lib/stock'
import { fmtDate, fmtQty, inr, statusLabel } from '../lib/utils'
import type { StockRow } from '../types'

/** One packing material, with every lot of it folded together. */
interface MaterialRow {
  item: string
  name: string
  uom: string
  qty: number
  value: number
  reorder: number
  low: boolean
  lots: StockRow[]
}

export function PackingMaterials() {
  const { state, rows } = useApp()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [expanded, setExpanded] = useState('')

  // The whole store, whatever the search box says. The cards below report the plant's
  // packing stock, so narrowing the table must not quietly restate them as the total.
  const allPmRows = useMemo(() => rows.filter((r) => r.itemType === 'Packing Material'), [rows])
  const low = useMemo(() => lowStockItems(state, allPmRows), [allPmRows, state])
  const lowByItem = useMemo(() => new Map(low.map((l) => [l.item, l])), [low])

  /**
   * One row per material rather than per lot.
   *
   * A reorder level belongs to the material, not to one lot standing on one shelf — so
   * a table of lots could not answer "are we short of 5 L BiBs?" without the reader
   * adding three rows up in their head. A material the plant has bought before is
   * listed even when the shelf is empty, because an empty shelf is exactly the thing
   * worth seeing.
   */
  const materials = useMemo(() => {
    const everStocked = new Set(state.ledger.map((l) => l.item))
    const byItem = new Map<string, StockRow[]>()
    for (const r of allPmRows) byItem.set(r.item, [...(byItem.get(r.item) || []), r])

    const out: MaterialRow[] = []
    for (const item of state.items) {
      if (item.type !== 'Packing Material') continue
      const lots = byItem.get(item.id) || []
      if (!lots.length && !everStocked.has(item.id)) continue
      out.push({
        item: item.id,
        name: item.name,
        uom: item.uom,
        qty: lots.reduce((a, r) => a + r.qty, 0),
        value: lots.reduce((a, r) => a + r.value, 0),
        reorder: item.reorder || state.config.lowStockPacks,
        low: lowByItem.has(item.id),
        lots: lots.slice().sort((a, b) => a.lot.localeCompare(b.lot)),
      })
    }

    const q = search.trim().toLowerCase()
    return out
      .filter((m) => (!onlyLow || m.low) && (!q || `${m.item} ${m.name}`.toLowerCase().includes(q)))
      // Short of it first: that is the list somebody came here to read.
      .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name))
  }, [allPmRows, lowByItem, onlyLow, search, state])

  /** The last time each material was received, so a low row says how stale the shortage is. */
  const lastReceived = useMemo(() => {
    const by = new Map<string, string>()
    for (const l of state.ledger) {
      if (l.type !== 'PM Receipt') continue
      const seen = by.get(l.item)
      if (!seen || l.time > seen) by.set(l.item, l.time)
    }
    return by
  }, [state.ledger])

  const totalValue = allPmRows.reduce((a, b) => a + b.value, 0)
  // Named by unit: a plant that buys film by the metre and caps by the piece cannot
  // read one "total units" figure.
  const totalQtyLabel = fmtRowTotal(allPmRows, 'None')
  const receive = () => navigate('/procurement?tab=packing')

  return (
    <>
      <div className="grid grid-4">
        <div className="card metric">
          <div className="label">Materials stocked</div>
          <div className="value">{materials.length}</div>
          <div className="sub">Items the plant buys</div>
        </div>
        <div className="card metric">
          <div className="label">Total units</div>
          <div className="value">{totalQtyLabel}</div>
          <div className="sub">On hand packing stock</div>
        </div>
        <div className="card metric">
          <div className="label">Inventory value</div>
          <div className="value">{inr(totalValue)}</div>
          <div className="sub">Ledger-derived</div>
        </div>
        <div className="card metric">
          <div className="label">Below reorder</div>
          <div className="value">{low.length}</div>
          <div className="sub">{low.length ? 'Order these' : 'Nothing to order'}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head">
          <div>
            <h3>What is on hand</h3>
            <span>
              One row per material, added up across every lot — the figure a reorder level is
              actually judged against
            </span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" type="button" onClick={receive}>
              + Receive Packing Material
            </button>
          </div>
        </div>

        <div className="note">
          Packing material is received on the <b>Procurement</b> page, beside farm produce — the
          receipt names the supplier, the quantity and the rate, and every packing run that draws
          on that lot costs itself at it. Open a row here to see which lots the total is made of
          and where each one is sitting.
        </div>

        <div className="vendors-toolbar">
          <div className="type-tabs" role="tablist">
            <button
              type="button"
              className={`type-tab ${onlyLow ? '' : 'active'}`}
              onClick={() => setOnlyLow(false)}
            >
              All materials
            </button>
            <button
              type="button"
              className={`type-tab ${onlyLow ? 'active' : ''}`}
              onClick={() => setOnlyLow(true)}
            >
              Below reorder{low.length ? ` (${low.length})` : ''}
            </button>
          </div>
          <input
            className="vendors-search"
            placeholder="Search packing material"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th className="cell-num cell-tight">On hand</th>
                <th className="cell-num cell-tight">Reorder level</th>
                <th className="cell-num cell-tight">Value</th>
                <th>Last received</th>
                <th className="cell-actions">Lots</th>
              </tr>
            </thead>
            <tbody>
              {!materials.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    <EmptyState
                      filtered={!!search || onlyLow}
                      empty="No packing material has been received yet. Receive some on the Procurement page."
                      onClear={() => {
                        setSearch('')
                        setOnlyLow(false)
                      }}
                    />
                  </td>
                </tr>
              ) : (
                materials.map((m) => {
                  const open = expanded === m.item
                  const received = lastReceived.get(m.item)
                  return [
                    <tr key={m.item}>
                      <td data-label="Material">
                        <b>{m.name}</b>
                        {m.low ? <StatusBadge value="Low stock" /> : null}
                        <div className="cell-sub cell-id">{m.item}</div>
                      </td>
                      <td data-label="On hand" className="cell-num cell-tight">
                        {fmtQty(m.qty)} {m.uom}
                        <div className="cell-sub">
                          {m.lots.length} lot{m.lots.length === 1 ? '' : 's'}
                        </div>
                      </td>
                      <td data-label="Reorder level" className="cell-num cell-tight">
                        {m.reorder}
                        <div className="cell-sub">
                          {m.low
                            ? `Short by ${fmtQty(Math.max(0, m.reorder - m.qty))}`
                            : 'Above level'}
                        </div>
                      </td>
                      <td data-label="Value" className="cell-num cell-tight">{inr(m.value)}</td>
                      <td data-label="Last received">{received ? fmtDate(received) : 'Never'}</td>
                      <td className="cell-actions">
                        <div className="row-actions">
                          <button
                            className="btn btn-light"
                            type="button"
                            disabled={!m.lots.length}
                            onClick={() => setExpanded(open ? '' : m.item)}
                          >
                            {open ? 'Hide lots' : 'Show lots'}
                          </button>
                          <button className="btn btn-light" type="button" onClick={receive}>
                            Receive
                          </button>
                        </div>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${m.item}-lots`} className="subrow">
                        <td colSpan={6}>
                          <div className="room-stock">
                            {m.lots.map((r) => (
                              <div className="room-stock-row" key={stockRowKey(r)}>
                                <div>
                                  <b>{r.lot}</b>
                                  <div className="small">
                                    {locationLabel(state, r.location)} · {statusLabel(r.status)}
                                  </div>
                                  <div className="small">
                                    {fmtQty(r.qty)} {r.uom} at {inr(r.unitCost)} · {inr(r.value)}
                                  </div>
                                </div>
                                <button
                                  className="btn btn-light"
                                  type="button"
                                  onClick={() =>
                                    navigate(
                                      `/stickers?stage=material&q=${encodeURIComponent(r.lot)}`,
                                    )
                                  }
                                >
                                  Sticker
                                </button>
                              </div>
                            ))}
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
      </div>
    </>
  )
}
