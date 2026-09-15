/**
 * Orders — what a customer asked for, and sending it.
 *
 * An order is only raised once the goods are packed and cleared, so nothing is
 * reserved: the stock is checked at the moment it goes out. And an order ships
 * complete, so dispatching is all-or-nothing — every line is measured against live
 * stock before a single ledger row is written.
 */

import { useMemo, useState } from 'react'
import { DetailView, type DetailSection } from '../components/DetailView'
import { useLinkedView } from '../lib/linkedView'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { formatSize } from '../lib/packs'
import { displayExpiry, locationLabel, parseRowKey, rowKey } from '../lib/stock'
import { fmtDate, fmtQty, QTY_EPSILON, toLocalInputValue } from '../lib/utils'
import type { Order, OrderLine } from '../types'
import { bareAll, keyed, keyedAll, type Keyed } from '../lib/rows'

const blankLine: OrderLine = { sku: '', qty: 0 }

export function Orders() {
  const { state, rows, getItemName, saveOrder, cancelOrder, deleteOrder, dispatchOrder } = useApp()

  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [form, setForm] = useState({
    customerId: '',
    date: toLocalInputValue(),
    notes: '',
    lines: [keyed(blankLine)] as Keyed<OrderLine>[],
  })

  const [sendId, setSendId] = useState('')
  // An order had no view of its own, so a dispatch could name it but not open it.
  const [viewId, setViewId, closeView] = useLinkedView((id) => state.orders.some((o) => o.id === id))
  const [vehicle, setVehicle] = useState('')
  const [picks, setPicks] = useState<Record<string, Record<string, number>>>({})

  const customers = state.customers.filter((c) => c.status === 'Active')
  /** Every pack the plant sells — what an order line can name. */
  const sellable = state.products

  /** Released packs on hand, by SKU, so a line can be filled from real lots. */
  const availableFor = useMemo(() => {
    const by = new Map<
      string,
      { item: string; lot: string; location: string; qty: number; expiry?: string; shownExpiry?: string }[]
    >()
    for (const r of rows) {
      if (r.itemType !== 'Finished Goods' || r.status !== 'Released' || r.qty <= QTY_EPSILON) continue
      const list = by.get(r.item) || []
      list.push({
        item: r.item,
        lot: r.lot,
        location: r.location,
        qty: r.qty,
        // `expiry` is what the ledger recorded and is part of which row this is.
        // `shownExpiry` is only for printing, and falls back to the lot-wide lookup
        // for rows written before lines carried their own date.
        expiry: r.expiry,
        shownExpiry: displayExpiry(state, r),
      })
      by.set(r.item, list)
    }
    // Oldest stock goes first, so the operator is offered it first.
    for (const list of by.values())
      list.sort((a, b) => (a.shownExpiry || '').localeCompare(b.shownExpiry || ''))
    return by
  }, [rows, state])

  const onHand = (sku: string) =>
    (availableFor.get(sku) || []).reduce((a, r) => a + r.qty, 0)

  const orders = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = [...state.orders].sort((a, b) => b.date.localeCompare(a.date))
    if (!q) return list
    return list.filter((o) =>
      [o.id, o.customerName, o.status, o.challan || ''].join(' ').toLowerCase().includes(q),
    )
  }, [search, state.orders])

  const sending = sendId ? state.orders.find((o) => o.id === sendId) : undefined

  const packLabel = (sku: string) => {
    const p = state.products.find((x) => x.id === sku)
    return p ? `${p.name} · ${formatSize(p.size, p.unit)}` : getItemName(sku)
  }

  const openNew = () => {
    setEditId('')
    setForm({ customerId: '', date: toLocalInputValue(), notes: '', lines: [keyed(blankLine)] })
    setOpen(true)
  }

  const openEdit = (o: Order) => {
    setEditId(o.id)
    setForm({
      customerId: o.customerId,
      date: toLocalInputValue(new Date(o.date)),
      notes: o.notes || '',
      lines: o.lines.length ? keyedAll(o.lines) : [keyed(blankLine)],
    })
    setOpen(true)
  }

  const openSend = (o: Order) => {
    setSendId(o.id)
    setVehicle('')
    // Pre-fill from the oldest stock, which is what should go first anyway.
    const seeded: Record<string, Record<string, number>> = {}
    for (const line of o.lines) {
      let left = line.qty
      seeded[line.sku] = {}
      for (const r of availableFor.get(line.sku) || []) {
        if (left <= 0) break
        const take = Math.min(left, r.qty)
        seeded[line.sku][rowKey(r)] = take
        left -= take
      }
    }
    setPicks(seeded)
  }

  const allocations = sending
    ? sending.lines.map((l) => ({
        sku: l.sku,
        picks: Object.entries(picks[l.sku] || {}).map(([k, qty]) => {
          const { lot, location, expiry } = parseRowKey(k)
          return { lot, location, expiry, qty }
        }),
      }))
    : []

  const allottedFor = (sku: string) =>
    Object.values(picks[sku] || {}).reduce((a, q) => a + (Number(q) || 0), 0)

  const shortLine = sending?.lines.find((l) => Math.abs(allottedFor(l.sku) - l.qty) > QTY_EPSILON)


  const viewingOrder = viewId ? state.orders.find((o) => o.id === viewId) : undefined
  const orderSections: DetailSection[] = viewingOrder
    ? [
        {
          title: 'Order',
          fields: [
            { label: 'Order', value: viewingOrder.id },
            { label: 'Raised on', value: fmtDate(viewingOrder.date) },
            { label: 'Customer', value: viewingOrder.customerName },
            { label: 'Status', value: viewingOrder.status },
            { label: 'Challan', value: viewingOrder.challan },
            {
              label: 'Dispatched on',
              value: viewingOrder.dispatchedAt ? fmtDate(viewingOrder.dispatchedAt) : '',
            },
          ],
        },
        {
          title: 'Items',
          fields: viewingOrder.lines.map((l) => ({ label: packLabel(l.sku), value: String(l.qty) })),
        },
        ...(viewingOrder.notes
          ? [{ title: 'Notes', fields: [{ label: 'Notes', value: viewingOrder.notes, wide: true }] }]
          : []),
      ]
    : []

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Orders</h3>
          <span>What a customer asked for. An order goes out complete, in one challan.</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={openNew}>
            + New Order
          </button>
        </div>
      </div>

      <div className="note">
        Raise an order once the goods are packed and cleared. Nothing is held back when you save
        it — the stock is checked the moment you dispatch, and if any line falls short the whole
        order is refused rather than half of it going out.
      </div>

      <div className="toolbar">
        <input
          placeholder="Search order, customer, challan or status"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Raised</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Status</th>
              <th className="cell-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {!orders.length ? (
              <tr>
                <td colSpan={6} className="empty">
                  <EmptyState
                    filtered={!!search}
                    empty="No orders yet. Raise one once a customer's goods are packed and cleared."
                    onClear={() => setSearch('')}
                  />
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.id}>
                  <td data-label="Order">
                    <b>{o.id}</b>
                    {o.challan ? <div className="small">{o.challan}</div> : null}
                  </td>
                  <td data-label="Raised">{fmtDate(o.date)}</td>
                  <td data-label="Customer">{o.customerName}</td>
                  <td data-label="Items">
                    {o.lines.map((l) => (
                      <div key={l.sku} className="small">
                        {l.qty} × {packLabel(l.sku)}
                      </div>
                    ))}
                  </td>
                  <td data-label="Status">
                    <StatusBadge value={o.status} />
                  </td>
                  <td className="cell-actions">
                    <button className="btn btn-light" type="button" onClick={() => setViewId(o.id)}>
                      View
                    </button>
                    {o.status === 'Open' ? (
                      <>
                        <button className="btn btn-primary" type="button" onClick={() => openSend(o)}>
                          Dispatch
                        </button>
                        <button className="btn btn-light" type="button" onClick={() => openEdit(o)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => {
                            if (confirm(`Cancel ${o.id}?`)) cancelOrder(o.id)
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <span className="small">
                        {o.status === 'Dispatched'
                          ? `Sent ${o.dispatchedAt ? fmtDate(o.dispatchedAt) : ''}`
                          : 'Cancelled'}
                      </span>
                    )}
                    {o.status !== 'Dispatched' ? (
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => {
                          if (confirm(`Delete ${o.id}?`)) deleteOrder(o.id)
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ---- raise / edit ---- */}
      <DetailView
        open={!!viewingOrder}
        title={viewingOrder ? `${viewingOrder.id} · ${viewingOrder.customerName}` : 'Order'}
        sections={orderSections}
        onClose={closeView}
        record={viewingOrder?.id}
      />

      <Modal
        open={open}
        title={editId ? `Edit ${editId}` : 'New order'}
        saveLabel={editId ? 'Save Changes' : 'Raise Order'}
        onClose={() => setOpen(false)}
        onSave={() => {
          const ok = saveOrder(
            {
              customerId: form.customerId,
              date: form.date,
              notes: form.notes,
              lines: bareAll(form.lines.filter((l) => l.sku && l.qty > 0)),
            },
            editId || undefined,
          )
          if (ok) setOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field span-2">
            <label>Customer</label>
            <Select
              value={form.customerId}
              onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            >
              <option value="">
                {customers.length ? 'Select customer' : 'No active customers — add one first'}
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Order date</label>
            <input
              type="datetime-local"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>What they want</span>
            <button
              className="btn btn-light"
              type="button"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, keyed(blankLine)] }))}
            >
              + Add item
            </button>
          </div>
          <div className="subform-body">
            {form.lines.map((line, idx) => {
              const have = line.sku ? onHand(line.sku) : 0
              const short = line.sku && line.qty > have
              return (
                <div className="subform-row" key={line.rowId}>
                  <Select
                    value={line.sku}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        lines: f.lines.map((l, i) =>
                          i === idx ? { ...l, sku: e.target.value } : l,
                        ),
                      }))
                    }
                  >
                    <option value="">Select product</option>
                    {sellable
                      .filter((p) => p.id === line.sku || !form.lines.some((l) => l.sku === p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {formatSize(p.size, p.unit)}
                        </option>
                      ))}
                  </Select>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Units"
                    value={line.qty || ''}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        lines: f.lines.map((l, i) =>
                          i === idx ? { ...l, qty: Number(e.target.value) } : l,
                        ),
                      }))
                    }
                  />
                  <span className={`subform-unit${short ? ' off-recipe' : ''}`}>
                    {line.sku ? `${Number(have.toFixed(2))} on hand` : ''}
                  </span>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() =>
                      setForm((f) => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))
                    }
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <div className="field span-3" style={{ marginTop: 14 }}>
          <label>Notes</label>
          <input
            value={form.notes}
            placeholder="Anything the driver or the customer needs to know"
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>
        <div className="note">
          On-hand is shown as a guide only — nothing is held back until you dispatch. If a line is
          short at that point the whole order is refused, so nothing part-ships.
        </div>
      </Modal>

      {/* ---- dispatch ---- */}
      <Modal
        open={!!sending}
        title={sending ? `Dispatch ${sending.id} · ${sending.customerName}` : 'Dispatch order'}
        saveLabel="Dispatch Order"
        saveDisabled={!!shortLine}
        onClose={() => setSendId('')}
        onSave={() => {
          if (!sending) return
          const ok = dispatchOrder(sending.id, allocations, vehicle)
          if (ok) setSendId('')
        }}
      >
        {sending?.lines.map((line) => {
          const lots = availableFor.get(line.sku) || []
          const allotted = allottedFor(line.sku)
          return (
            <div className="subform" key={line.sku} style={{ marginBottom: 12 }}>
              <div className="subform-head">
                <span>
                  {line.qty} × {packLabel(line.sku)}
                </span>
                <span
                  className={`small${Math.abs(allotted - line.qty) > QTY_EPSILON ? ' off-recipe' : ''}`}
                  style={{ fontWeight: 700 }}
                >
                  {allotted} of {line.qty} allotted
                </span>
              </div>
              <div className="subform-body">
                {!lots.length ? (
                  <div className="note warning-note">
                    Nothing released on hand for this product.
                  </div>
                ) : (
                  lots.map((r) => (
                    <div className="subform-row" key={rowKey(r)}>
                      <span className="subform-unit" style={{ display: 'block' }}>
                        <b>{r.lot}</b>
                        <div className="small">
                          {locationLabel(state, r.location)} · {fmtQty(r.qty)} on hand ·
                          exp {r.shownExpiry || '—'}
                        </div>
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="0"
                        value={picks[line.sku]?.[rowKey(r)] || ''}
                        onChange={(e) =>
                          setPicks((p) => ({
                            ...p,
                            [line.sku]: {
                              ...(p[line.sku] || {}),
                              [rowKey(r)]: Number(e.target.value),
                            },
                          }))
                        }
                      />
                      <span className="subform-unit">units</span>
                      <span />
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}

        <div className="form-grid">
          <div className="field span-3">
            <label>Vehicle</label>
            <input
              value={vehicle}
              placeholder="Registration or transporter"
              onChange={(e) => setVehicle(e.target.value)}
            />
          </div>
        </div>

        <div className={`note${shortLine ? ' warning-note' : ''}`}>
          {shortLine
            ? `${packLabel(shortLine.sku)} is ${allottedFor(shortLine.sku)} of ${shortLine.qty}. An order goes out complete, so every line has to be filled before it can be dispatched.`
            : 'Every line is checked against live stock again as it posts, and all of them are written together — the order cannot end up half sent.'}
        </div>
      </Modal>
    </div>
  )
}
