/**
 * Orders — what a customer asked for, and sending it.
 *
 * An order is only raised once the goods are packed and cleared, so nothing is
 * reserved: the stock is checked at the moment it goes out. And an order ships
 * complete, so dispatching is all-or-nothing — every line is measured against live
 * stock before a single ledger row is written.
 *
 * The form takes the order the way the customer gives it — by drink — with a
 * quantity per pack format beneath each; it flattens to plain order lines on
 * save, so nothing downstream ever sees the difference.
 */

import { useMemo, useState } from 'react'
import { DetailView, type DetailSection } from '../components/DetailView'
import { detailRowProps } from '../components/detailRow'
import { useLinkedView } from '../lib/linkedView'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import {
  SortHeader,
  SortSelect,
  sortRows,
  useTableSort,
  type SortAccessors,
} from '../components/tableSort'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { bulkItemOf, formatSize } from '../lib/packs'
import { locationLabel, parseRowKey, rowKey } from '../lib/stock'
import {
  drinkCatalog,
  filterOrders,
  linesByDrink as groupLinesByDrink,
  releasedPacksBySku,
  resolveBlocks as resolveDraftBlocks,
  seedAllocations,
  type OrderDraft,
} from '../lib/ordersView'
import { fmtDate, fmtQty, QTY_EPSILON, toDateKey, toLocalInputValue } from '../lib/utils'
import type { Order, OrderLine } from '../types'

const blankDraft = (): OrderDraft => ({
  customerId: '',
  date: toLocalInputValue(),
  dueDate: '',
  notes: '',
  picked: [],
  formats: {},
  qtys: {},
})

export function Orders() {
  const { state, rows, getItemName, saveOrder, cancelOrder, deleteOrder, dispatchOrder } = useApp()

  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [form, setForm] = useState<OrderDraft>(blankDraft)

  const [sendId, setSendId] = useState('')
  // An order had no view of its own, so a dispatch could name it but not open it.
  const [viewId, setViewId, closeView] = useLinkedView((id) => state.orders.some((o) => o.id === id))
  const [vehicle, setVehicle] = useState('')
  const [picks, setPicks] = useState<Record<string, Record<string, number>>>({})

  const customers = state.customers.filter((c) => c.status === 'Active')

  // ── The drinks the plant sells, each with its pack formats ──────────────────
  const itemById = useMemo(() => new Map(state.items.map((i) => [i.id, i])), [state.items])
  const melangeOutputs = useMemo(
    () => new Set(state.melanges.map((m) => m.outputItem)),
    [state.melanges],
  )
  const productById = useMemo(() => new Map(state.products.map((p) => [p.id, p])), [state.products])

  /** Pack formats grouped under the drink they are filled from — the picker's
   *  offer, largest format first so a drink reads 5 L, 2.5 L, 250 ml. */
  const drinks = useMemo(
    () => drinkCatalog(state.products, itemById, melangeOutputs),
    [itemById, melangeOutputs, state.products],
  )

  const drinkById = useMemo(() => new Map(drinks.map((d) => [d.bulkId, d])), [drinks])

  /** Released packs on hand, by SKU, so a line can be filled from real lots. */
  const availableFor = useMemo(() => releasedPacksBySku(state, rows), [rows, state])

  const onHand = (sku: string) =>
    (availableFor.get(sku) || []).reduce((a, r) => a + r.qty, 0)

  const orders = useMemo(() => filterOrders(state.orders, search), [search, state.orders])

  const { sort, toggle, setSort } = useTableSort()
  const sortBy: SortAccessors<Order> = {
    id: (o) => o.id,
    date: (o) => o.date,
    due: (o) => o.dueDate || '',
    customer: (o) => o.customerName,
    items: (o) => o.lines.reduce((a, l) => a + l.qty, 0),
    status: (o) => o.status,
  }
  const sorted = sortRows(orders, sort, sortBy)

  const sending = sendId ? state.orders.find((o) => o.id === sendId) : undefined
  const today = toDateKey()

  const packLabel = (sku: string) => {
    const p = state.products.find((x) => x.id === sku)
    return p ? `${p.name} · ${formatSize(p.size, p.unit)}` : getItemName(sku)
  }

  const openNew = () => {
    setEditId('')
    setForm(blankDraft())
    setOpen(true)
  }

  const openEdit = (o: Order) => {
    setEditId(o.id)
    // The flat lines rebuild into drinks in the order the customer named them —
    // each drink holding only the packs the order actually asks for. A sku the
    // master no longer knows keeps its own block so it stays on the order.
    const picked: string[] = []
    const formats: Record<string, string[]> = {}
    const qtys: Record<string, number | ''> = {}
    for (const l of o.lines) {
      qtys[l.sku] = l.qty
      const p = productById.get(l.sku)
      const key = p ? bulkItemOf(p) : `orphan:${l.sku}`
      if (!picked.includes(key)) picked.push(key)
      if (p) (formats[key] ||= []).push(l.sku)
    }
    setForm({
      customerId: o.customerId,
      date: toLocalInputValue(new Date(o.date)),
      dueDate: o.dueDate || '',
      notes: o.notes || '',
      picked,
      formats,
      qtys,
    })
    setOpen(true)
  }

  /**
   * What the form is holding, as the blocks the operator sees — and the only
   * thing the save flattens, so what is on screen is exactly what is written.
   */
  const resolveBlocks = (draft: OrderDraft) =>
    resolveDraftBlocks(draft, drinkById, productById, itemById, melangeOutputs, getItemName)

  const addDrink = (bulkId: string) => {
    if (!bulkId) return
    setForm((f) => ({ ...f, picked: [...f.picked, bulkId] }))
  }

  /** Removing a drink clears its packs and quantities too — re-adding starts
   *  blank, so a removed block can never come back carrying an order nobody can
   *  see. */
  const removeBlock = (key: string) => {
    setForm((f) => {
      const qtys = { ...f.qtys }
      const formats = { ...f.formats }
      if (key.startsWith('orphan:')) {
        delete qtys[key.slice('orphan:'.length)]
      } else {
        for (const sku of formats[key] || []) delete qtys[sku]
        delete formats[key]
      }
      return { ...f, picked: f.picked.filter((k) => k !== key), formats, qtys }
    })
  }

  const addFormat = (bulkId: string, sku: string) => {
    if (!sku) return
    setForm((f) => ({
      ...f,
      formats: { ...f.formats, [bulkId]: [...(f.formats[bulkId] || []), sku] },
    }))
  }

  const removeFormat = (bulkId: string, sku: string) => {
    setForm((f) => {
      const qtys = { ...f.qtys }
      delete qtys[sku]
      return {
        ...f,
        formats: { ...f.formats, [bulkId]: (f.formats[bulkId] || []).filter((s) => s !== sku) },
        qtys,
      }
    })
  }

  const setQty = (sku: string, value: string) =>
    setForm((f) => ({ ...f, qtys: { ...f.qtys, [sku]: value === '' ? '' : Number(value) } }))

  /** An order's lines as the plant reads them — by drink, with anything the master
   *  no longer knows under its own heading. Used by the list and the detail view. */
  const linesByDrink = (lines: OrderLine[]) =>
    groupLinesByDrink(lines, productById, itemById, melangeOutputs)

  const openSend = (o: Order) => {
    setSendId(o.id)
    setVehicle('')
    // Pre-fill from the oldest stock, which is what should go first anyway.
    setPicks(seedAllocations(o.lines, availableFor))
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
            { label: 'Ship by', value: viewingOrder.dueDate ? fmtDate(viewingOrder.dueDate) : '' },
            { label: 'Customer', value: viewingOrder.customerName },
            { label: 'Status', value: viewingOrder.status },
            { label: 'Challan', value: viewingOrder.challan },
            {
              label: 'Dispatched on',
              value: viewingOrder.dispatchedAt ? fmtDate(viewingOrder.dispatchedAt) : '',
            },
          ],
        },
        // The items read the way the order was raised: one section per drink, its
        // pack formats beneath; anything off the master under its own heading.
        ...(() => {
          const grouped = linesByDrink(viewingOrder.lines)
          const sections: DetailSection[] = grouped.drinks.map((d) => ({
            title: `${d.name}${d.isMelange ? ' · blend' : ''}`,
            fields: d.lines.map((l) => ({ label: packLabel(l.sku), value: String(l.qty) })),
          }))
          if (grouped.off.length)
            sections.push({
              title: 'No longer in the product master',
              fields: grouped.off.map((l) => ({ label: packLabel(l.sku), value: String(l.qty) })),
            })
          return sections
        })(),
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

      <SortSelect
        sort={sort}
        onPick={setSort}
        columns={[
          { k: 'id', label: 'Order', kind: 'text' },
          { k: 'date', label: 'Raised', kind: 'date' },
          { k: 'due', label: 'Ship by', kind: 'date' },
          { k: 'customer', label: 'Customer' },
          { k: 'items', label: 'Items', kind: 'num' },
          { k: 'status', label: 'Status' },
        ]}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Order" k="id" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Raised" k="date" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Ship by" k="due" sort={sort} onToggle={toggle} />
              <SortHeader label="Customer" k="customer" sort={sort} onToggle={toggle} />
              <SortHeader label="Items" k="items" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
              <th className="cell-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {!orders.length ? (
              <tr>
                <td colSpan={7} className="empty">
                  <EmptyState
                    filtered={!!search}
                    empty="No orders yet. Raise one once a customer's goods are packed and cleared."
                    onClear={() => setSearch('')}
                  />
                </td>
              </tr>
            ) : (
              sorted.map((o) => (
                <tr key={o.id} {...detailRowProps(() => setViewId(o.id))}>
                  <td data-label="Order">
                    <b>{o.id}</b>
                    {o.challan ? <div className="small">{o.challan}</div> : null}
                  </td>
                  <td data-label="Raised">{fmtDate(o.date)}</td>
                  <td data-label="Ship by" className="cell-tight">
                    {o.dueDate ? (
                      <>
                        {fmtDate(o.dueDate)}
                        {/* An open order past its ship-by day is the plant's most
                            urgent demand — say so where the order is listed. */}
                        {o.status === 'Open' && o.dueDate < today ? (
                          <div className="cell-sub" style={{ color: 'var(--warning)' }}>
                            overdue
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="small">—</span>
                    )}
                  </td>
                  <td data-label="Customer">{o.customerName}</td>
                  <td data-label="Items">
                    {(() => {
                      const grouped = linesByDrink(o.lines)
                      return (
                        <>
                          {grouped.drinks.map((d) => (
                            <div key={d.key} className="small">
                              <b>{d.name}</b>
                              {d.lines.map((l) => (
                                <div key={l.sku}>
                                  ↳ {l.qty} × {packLabel(l.sku)}
                                </div>
                              ))}
                            </div>
                          ))}
                          {grouped.off.length ? (
                            <div key="off" className="small">
                              <b>No longer in the product master</b>
                              {grouped.off.map((l) => (
                                <div key={l.sku}>
                                  ↳ {l.qty} × {packLabel(l.sku)}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </>
                      )
                    })()}
                  </td>
                  <td data-label="Status">
                    <StatusBadge value={o.status} />
                  </td>
                  <td className="cell-actions">
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
          // Only what the visible blocks hold is written — drinks in the order they
          // were picked, formats largest-first; an unquantified format never a line.
          const lines: OrderLine[] = []
          for (const b of resolveBlocks(form)) {
            const skus = b.sku ? [b.sku] : b.formats.map((p) => p.id)
            for (const sku of skus) {
              const qty = form.qtys[sku]
              if (Number(qty) > 0) lines.push({ sku, qty: Number(qty) })
            }
          }
          const ok = saveOrder(
            {
              customerId: form.customerId,
              date: form.date,
              dueDate: form.dueDate,
              notes: form.notes,
              lines,
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
          <div className="field">
            <label>Ship by</label>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>What they want</span>
            <span className="small">Pick a drink, then add only the packs they want</span>
          </div>
          <div className="subform-body">
            {(() => {
              const blocks = resolveBlocks(form)
              const remaining = drinks.filter((d) => !form.picked.includes(d.bulkId))
              return (
                <>
                  {/* The picker sits as the body's first row, not in the head: the
                      head's bold small type would bleed into the trigger, and the
                      select's width rule only reaches inside a subform-row. */}
                  <div className="subform-row" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                    <Select
                      value=""
                      aria-label="Add drink"
                      disabled={!drinks.length || !remaining.length}
                      onChange={(e) => addDrink(e.target.value)}
                    >
                      <option value="">
                        {!drinks.length
                          ? 'No pack products — add one on the Products page'
                          : !remaining.length
                            ? 'All drinks added'
                            : '+ Add drink'}
                      </option>
                      {remaining.map((d) => (
                        <option key={d.bulkId} value={d.bulkId}>
                          {d.name}
                          {d.isMelange ? ' · blend' : ''}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {blocks.map((b) => {
                    const orphanSku = b.sku
                    const drinkFormats = drinkById.get(b.key)?.formats || []
                    const chosenIds = new Set(b.formats.map((p) => p.id))
                    const remaining = drinkFormats.filter((p) => !chosenIds.has(p.id))
                    return (
                      <div className="subform" key={b.key} style={{ marginTop: 12 }}>
                        <div className="subform-head">
                          <span>
                            {b.name}
                            {b.isMelange ? <span className="small"> · blend</span> : null}
                            {orphanSku ? (
                              <span className="small"> — no longer in the product master</span>
                            ) : null}
                          </span>
                          <button
                            className="btn btn-danger"
                            type="button"
                            onClick={() => removeBlock(b.key)}
                          >
                            ×
                          </button>
                        </div>
                        <div className="subform-body">
                          {orphanSku ? (
                            <div className="subform-row" style={{ alignItems: 'center' }}>
                              <span className="subform-unit" style={{ display: 'block' }}>
                                <b>{b.name}</b>
                                <div className="small">
                                  {Number(onHand(orphanSku).toFixed(2))} on hand
                                </div>
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                placeholder="Units"
                                value={form.qtys[orphanSku] ?? ''}
                                onChange={(e) => setQty(orphanSku, e.target.value)}
                              />
                              <span className="subform-unit">units</span>
                              <span />
                            </div>
                          ) : (
                            <>
                              {/* The packs this drink comes in, offered one at a time —
                                  only a pack chosen here gets a quantity box, so an
                                  unwanted format is never on the screen at all. */}
                              <div
                                className="subform-row"
                                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
                              >
                                <Select
                                  value=""
                                  aria-label={`Add pack for ${b.name}`}
                                  disabled={!remaining.length}
                                  onChange={(e) => addFormat(b.key, e.target.value)}
                                >
                                  <option value="">
                                    {!drinkFormats.length
                                      ? 'No pack formats for this drink any more'
                                      : remaining.length
                                        ? '+ Add pack'
                                        : 'All packs added'}
                                  </option>
                                  {remaining.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name} · {p.type}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                              {b.formats.map((p) => {
                                const qty = form.qtys[p.id] ?? ''
                                const have = onHand(p.id)
                                const short = Number(qty) > have
                                return (
                                  <div
                                    className="subform-row"
                                    key={p.id}
                                    style={{ alignItems: 'center' }}
                                  >
                                    <span>
                                      {p.name} · {p.type}
                                    </span>
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      placeholder="Units"
                                      value={qty}
                                      onChange={(e) => setQty(p.id, e.target.value)}
                                    />
                                    <span className={`subform-unit${short ? ' off-recipe' : ''}`}>
                                      {`${Number(have.toFixed(2))} on hand`}
                                    </span>
                                    <button
                                      className="btn btn-danger"
                                      type="button"
                                      onClick={() => removeFormat(b.key, p.id)}
                                    >
                                      ×
                                    </button>
                                  </div>
                                )
                              })}
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </>
              )
            })()}
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
