/**
 * The Order stage form (WORKFLOW W14, behind the pipeline flag) — an "Order
 * desk" tab on Orders. Open orders in ship-by order (the overdue ones the
 * pipeline tile flags are the head), each line held against the released packs
 * the dispatch path itself would draw from — a guide, never a reservation.
 * Raising and editing both post through the SAME saveOrder the register's
 * modal uses, over the SAME folds (drinkCatalog, resolveBlocks,
 * draftFromOrder, linesFromDraft, releasedPacksBySku) — nothing here re-derives
 * a rule the save would not stamp.
 *
 * saveOrder's refusals are its own toasts (a customer, the ship-by day, whole
 * lines, one line per product); the client checks below only mirror its own
 * questions so the button is not offered dead, and a null return leaves this
 * form open.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import { useDraft } from '../lib/useDraft'
import {
  drinkCatalog,
  draftFromOrder,
  linesFromDraft,
  releasedPacksBySku,
  resolveBlocks,
  type OrderDraft,
} from '../lib/ordersView'
import { openOrderRows } from '../lib/orderStage'
import { formatSize } from '../lib/packs'
import { fmtDate, toDateKey, toLocalInputValue } from '../lib/utils'
import type { Order } from '../types'

const blankDraft = (): OrderDraft => ({
  customerId: '',
  date: toLocalInputValue(),
  dueDate: '',
  notes: '',
  picked: [],
  formats: {},
  qtys: {},
})

export function OrderDeskTab() {
  const { state, rows, getItemName, saveOrder } = useApp()
  const [, setParams] = useSearchParams()
  const today = toDateKey()
  // Data-entry reduction: the desk usually serves returning customers — the
  // last one used is remembered, everything else starts blank per order.
  const remembered = useDraft('roligt_order_desk', { customerId: '' })
  const [picked, setPicked] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [editId, setEditId] = useState('')
  const [draft, setDraft] = useState<OrderDraft>(blankDraft)

  const queue = useMemo(() => openOrderRows(state, today), [state, today])
  const current = queue.find((q) => q.order.id === picked)

  // The drinks the plant sells — the register's own catalogue folds.
  const itemById = useMemo(() => new Map(state.items.map((i) => [i.id, i])), [state.items])
  const melangeOutputs = useMemo(
    () => new Set(state.melanges.map((m) => m.outputItem)),
    [state.melanges],
  )
  const productById = useMemo(() => new Map(state.products.map((p) => [p.id, p])), [state.products])
  const drinks = useMemo(
    () => drinkCatalog(state.products, itemById, melangeOutputs),
    [itemById, melangeOutputs, state.products],
  )
  const drinkById = useMemo(() => new Map(drinks.map((d) => [d.bulkId, d])), [drinks])
  const availableFor = useMemo(() => releasedPacksBySku(state, rows), [rows, state])
  const onHand = (sku: string) => (availableFor.get(sku) || []).reduce((a, r) => a + r.qty, 0)

  const blocks = useMemo(
    () => resolveBlocks(draft, drinkById, productById, itemById, melangeOutputs, getItemName),
    [draft, drinkById, getItemName, itemById, melangeOutputs, productById],
  )
  const lines = useMemo(() => linesFromDraft(blocks, draft.qtys), [blocks, draft.qtys])

  // A remembered customer lands after mount; an untouched form picks it up, an
  // edit in progress is never overwritten.
  useEffect(() => {
    const last = remembered.value.customerId
    if (remembered.restored && last && !draft.customerId && !editId) {
      setDraft((d) => ({ ...d, customerId: last }))
    }
  }, [draft.customerId, editId, remembered.restored, remembered.value.customerId])

  const customers = state.customers.filter((c) => c.status === 'Active')
  const editing = editId ? state.orders.find((o) => o.id === editId) : undefined

  const packLabel = (sku: string) => {
    const p = state.products.find((x) => x.id === sku)
    return p ? `${p.name} · ${formatSize(p.size, p.unit)}` : getItemName(sku)
  }

  const pick = (id: string) => {
    setPicked(id)
    setScanNote('')
  }

  const scanOrder = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = queue.find(
      (q) =>
        q.order.id.toLowerCase() === wanted ||
        q.order.customerName.toLowerCase() === wanted,
    )
    if (!found) {
      setScanNote(
        queue.length
          ? `No open order reads ${code}.`
          : `No open orders — nothing to work at the desk.`,
      )
      return
    }
    pick(found.order.id)
  }

  const startEdit = (o: Order) => {
    setEditId(o.id)
    setDraft(draftFromOrder(o, productById))
    setPicked('')
  }

  const startRaise = () => {
    setEditId('')
    setDraft({ ...blankDraft(), customerId: remembered.value.customerId })
  }

  const setQty = (sku: string, raw: string) => {
    const qty = raw === '' ? ('' as const) : Math.max(0, Number(raw))
    setDraft((d) => ({ ...d, qtys: { ...d.qtys, [sku]: qty } }))
  }

  // The server's own questions, asked before the button is offered dead.
  const problem = !draft.customerId
    ? 'Select a customer.'
    : !draft.dueDate
      ? "Pick the ship-by day — planning scopes the week's work by it."
      : !lines.length
        ? 'Add at least one product to the order.'
        : ''

  const submit = () => {
    if (problem) return
    // saveOrder validates and toasts; on a refusal it returns null and the
    // form stays put with its words already on screen.
    const saved = saveOrder(
      {
        customerId: draft.customerId,
        date: draft.date,
        dueDate: draft.dueDate,
        notes: draft.notes,
        lines,
      },
      editId || undefined,
    )
    if (!saved) return
    if (draft.customerId) remembered.set({ customerId: draft.customerId })
    // After an edit the desk goes back to the queue (the order owes a dispatch,
    // not more edits); after a raise it is ready for the next one.
    if (editId) {
      setEditId('')
      setDraft(blankDraft())
      const next = queue.find((q) => q.order.id !== editId)
      pick(next ? next.order.id : '')
    } else {
      setDraft({ ...blankDraft(), customerId: draft.customerId })
    }
  }

  const shortLines = current?.lines.filter((l) => l.short) || []

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Order desk</h2>
          <span className="cell-sub">
            Open orders in ship-by order — the overdue ones first — each line held against the
            released packs a dispatch would draw from
          </span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={startRaise}>
            + Raise an order
          </button>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'queue',
            title: 'Open orders',
            hint: queue.length ? `${queue.length} open` : undefined,
            children: (
              <div>
                {queue.length ? (
                  <>
                    <div className="form-grid">
                      <label className="span-2">
                        Order
                        <Select value={picked} onChange={(e) => pick(e.target.value)}>
                          <option value="">Select an open order</option>
                          {queue.map((q) => (
                            <option key={q.order.id} value={q.order.id}>
                              {q.order.customerName} · {q.order.id} ·{' '}
                              {q.order.dueDate
                                ? `ship by ${fmtDate(q.order.dueDate)}${q.overdue ? ' · OVERDUE' : ''}`
                                : 'no ship-by day'}
                              {' · '}
                              {q.fillable ? 'fills today' : 'short'}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </div>
                    <div style={{ marginTop: 8, maxWidth: 360 }}>
                      <ScanInput
                        label="Order or customer"
                        onScan={scanOrder}
                        placeholder="Scan or type an order id or customer"
                      />
                    </div>
                  </>
                ) : (
                  <p className="cell-sub">
                    No open orders. Raise one once the goods are packed and cleared — an order
                    goes out complete, in one challan.
                  </p>
                )}
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
                {current ? (
                  <div style={{ marginTop: 12 }}>
                    <div className="form-grid">
                      <div className="field">
                        <label>Customer</label>
                        <div className="field-fixed">{current.order.customerName}</div>
                      </div>
                      <div className="field">
                        <label>Ship by</label>
                        <div className="field-fixed">
                          {current.order.dueDate ? fmtDate(current.order.dueDate) : '—'}
                        </div>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Line</th>
                            <th className="cell-num cell-tight">Ordered</th>
                            <th className="cell-num cell-tight">Released on hand</th>
                          </tr>
                        </thead>
                        <tbody>
                          {current.lines.map((l) => (
                            <tr key={l.sku}>
                              <td data-label="Line">{packLabel(l.sku)}</td>
                              <td data-label="Ordered" className="cell-num cell-tight">
                                {l.qty}
                              </td>
                              <td
                                data-label="Released on hand"
                                className={`cell-num cell-tight${l.short ? ' off-recipe' : ''}`}
                              >
                                {Number(l.onHand.toFixed(2))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className={`note${shortLines.length ? ' warning-note' : ''}`}>
                      {shortLines.length
                        ? `${shortLines.map((l) => packLabel(l.sku)).join(', ')} ${shortLines.length === 1 ? 'is' : 'are'} short of released stock — an order goes out complete, so nothing part-ships.`
                        : 'On-hand is shown as a guide only — nothing is held back until dispatch. If a line is short at that point the whole order is refused, so nothing part-ships.'}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="btn btn-light"
                        type="button"
                        onClick={() => startEdit(current.order)}
                      >
                        Edit this order
                      </button>
                      {/* The order's next action once it fills — the dispatch
                          stage form (W15), arriving with this order picked. */
                      current.fillable ? (
                        <button
                          className="btn btn-light"
                          type="button"
                          style={{ marginLeft: 8 }}
                          onClick={() =>
                            setParams(
                              { tab: 'dispatch', id: current.order.id },
                              { replace: true },
                            )
                          }
                        >
                          Dispatch this order →
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            id: 'order',
            title: editing ? `Edit ${editing.id}` : 'Raise an order',
            hint: editing ? editing.customerName : 'Nothing is held back when you save',
            children: (
              <div>
                <div className="form-grid">
                  <div className="field span-2">
                    <label>Customer</label>
                    <Select
                      value={draft.customerId}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, customerId: e.target.value }))
                      }
                      aria-label="Customer"
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
                      value={draft.date}
                      aria-label="Order date"
                      onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label>Ship by</label>
                    <input
                      type="date"
                      value={draft.dueDate}
                      aria-label="Ship by"
                      onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="subform" style={{ marginTop: 12 }}>
                  <div className="subform-head">
                    <span>What they want</span>
                    <span className="small">Pick a drink, then add only the packs they want</span>
                  </div>
                  <div className="subform-body">
                    {(() => {
                      const remaining = drinks.filter((d) => !draft.picked.includes(d.bulkId))
                      return (
                        <>
                          <div
                            className="subform-row"
                            style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
                          >
                            <Select
                              value=""
                              aria-label="Add drink"
                              disabled={!drinks.length || !remaining.length}
                              onChange={(e) => {
                                if (!e.target.value) return
                                setDraft((d) => ({ ...d, picked: [...d.picked, e.target.value] }))
                              }}
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
                            const drinkFormats = drinkById.get(b.key)?.formats || []
                            const chosenIds = new Set(b.formats.map((p) => p.id))
                            const remainingFormats = drinkFormats.filter(
                              (p) => !chosenIds.has(p.id),
                            )
                            return (
                              <div className="subform" key={b.key} style={{ marginTop: 12 }}>
                                <div className="subform-head">
                                  <span>
                                    {b.name}
                                    {b.isMelange ? <span className="small"> · blend</span> : null}
                                    {b.sku ? (
                                      <span className="small"> — no longer in the product master</span>
                                    ) : null}
                                  </span>
                                  <button
                                    className="btn btn-danger"
                                    type="button"
                                    onClick={() =>
                                      setDraft((d) => {
                                        const qtys = { ...d.qtys }
                                        const formats = { ...d.formats }
                                        if (b.sku) {
                                          delete qtys[b.sku]
                                        } else {
                                          for (const sku of formats[b.key] || []) delete qtys[sku]
                                          delete formats[b.key]
                                        }
                                        return {
                                          ...d,
                                          picked: d.picked.filter((k) => k !== b.key),
                                          formats,
                                          qtys,
                                        }
                                      })
                                    }
                                  >
                                    ×
                                  </button>
                                </div>
                                <div className="subform-body">
                                  {b.sku ? (
                                    <div className="subform-row" style={{ alignItems: 'center' }}>
                                      <span className="subform-unit" style={{ display: 'block' }}>
                                        <b>{b.name}</b>
                                        <div className="small">
                                          {Number(onHand(b.sku).toFixed(2))} on hand
                                        </div>
                                      </span>
                                      <input
                                        type="number"
                                        min="0"
                                        step="1"
                                        placeholder="Units"
                                        value={draft.qtys[b.sku] ?? ''}
                                        onChange={(e) => setQty(b.sku || '', e.target.value)}
                                      />
                                      <span className="subform-unit">units</span>
                                      <span />
                                    </div>
                                  ) : (
                                    <>
                                      <div
                                        className="subform-row"
                                        style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
                                      >
                                        <Select
                                          value=""
                                          aria-label={`Add pack for ${b.name}`}
                                          disabled={!remainingFormats.length}
                                          onChange={(e) => {
                                            if (!e.target.value) return
                                            setDraft((d) => ({
                                              ...d,
                                              formats: {
                                                ...d.formats,
                                                [b.key]: [...(d.formats[b.key] || []), e.target.value],
                                              },
                                            }))
                                          }}
                                        >
                                          <option value="">
                                            {!drinkFormats.length
                                              ? 'No pack formats for this drink any more'
                                              : remainingFormats.length
                                                ? '+ Add pack'
                                                : 'All packs added'}
                                          </option>
                                          {remainingFormats.map((p) => (
                                            <option key={p.id} value={p.id}>
                                              {p.name} · {p.type}
                                            </option>
                                          ))}
                                        </Select>
                                      </div>
                                      {b.formats.map((p) => {
                                        const qty = draft.qtys[p.id] ?? ''
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
                                            <span
                                              className={`subform-unit${short ? ' off-recipe' : ''}`}
                                            >
                                              {`${Number(have.toFixed(2))} on hand`}
                                            </span>
                                            <button
                                              className="btn btn-danger"
                                              type="button"
                                              onClick={() =>
                                                setDraft((d) => {
                                                  const qtys = { ...d.qtys }
                                                  delete qtys[p.id]
                                                  return {
                                                    ...d,
                                                    qtys,
                                                    formats: {
                                                      ...d.formats,
                                                      [b.key]: (d.formats[b.key] || []).filter(
                                                        (sku) => sku !== p.id,
                                                      ),
                                                    },
                                                  }
                                                })
                                              }
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
                    value={draft.notes}
                    placeholder="Anything the driver or the customer needs to know"
                    onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  />
                </div>
                <div className={`note${problem ? ' warning-note' : ''}`}>
                  {problem ||
                    'Nothing is held back when you save — the stock is checked the moment you dispatch, and if any line falls short the whole order is refused rather than half of it going out.'}
                </div>
              </div>
            ),
          },
        ]}
        footer={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={!!problem}
            >
              {editing ? `Save ${editing.id}` : 'Raise order'}
            </button>
            {editing ? (
              <button type="button" className="btn btn-light" onClick={startRaise}>
                Cancel edit
              </button>
            ) : null}
          </div>
        }
      />
    </div>
  )
}
