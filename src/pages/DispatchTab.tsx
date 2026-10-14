/**
 * The Dispatch stage form (WORKFLOW W15, behind the pipeline flag) — a
 * "Dispatch" tab on Orders. The queue is the desk's own openOrderRows (overdue
 * first), and the write is the SAME dispatchOrder the register's Dispatch modal
 * posts: every line is checked against live stock all-or-nothing, and one
 * challan carries the whole order out. The picks start from seedAllocations —
 * the oldest released stock, which should go first anyway — and the fold that
 * turns them into allocations (allocationsFromPicks) is the modal's own, so
 * nothing here re-derives a rule the write would not stamp.
 *
 * dispatchOrder's refusals are its own toasts (a short line, a lot that only
 * has N left, stock set aside in a hold area); the client checks below only
 * mirror its own all-or-nothing question so the button is not offered dead,
 * and a null return leaves this form open.
 *
 * Cartons are NOT decided here: BOXED/LOOSE needs a carton master that does
 * not exist yet (AUDIT: PARTIAL), so the §3.3-9 packaging step stays
 * SHIPMENT-era and this form writes exactly what the Classic modal writes.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import { useDraft } from '../lib/useDraft'
import { lotDates } from '../lib/productionDates'
import { locationLabel, rowKey } from '../lib/stock'
import {
  allottedFor,
  allocationsFromPicks,
  releasedPacksBySku,
  seedAllocations,
  shortLineOf,
} from '../lib/ordersView'
import { openOrderRows } from '../lib/orderStage'
import { formatSize } from '../lib/packs'
import { fmtDate, fmtQty, QTY_EPSILON, toDateKey } from '../lib/utils'

export function DispatchTab() {
  const { state, rows, getItemName, dispatchOrder } = useApp()
  const today = toDateKey()
  const [params] = useSearchParams()
  // Data-entry reduction: it is usually the same van — the last vehicle is
  // remembered, everything else starts blank per dispatch.
  const remembered = useDraft('roligt_dispatch_desk', { vehicle: '' })
  const [picked, setPicked] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [picks, setPicks] = useState<Record<string, Record<string, number>>>({})
  const [vehicle, setVehicle] = useState('')

  const queue = useMemo(() => openOrderRows(state, today), [state, today])
  const current = queue.find((q) => q.order.id === picked)

  /** Released packs on hand, by SKU — the dispatch path's own pool. */
  const availableFor = useMemo(() => releasedPacksBySku(state, rows), [rows, state])

  const packLabel = (sku: string) => {
    const p = state.products.find((x) => x.id === sku)
    return p ? `${p.name} · ${formatSize(p.size, p.unit)}` : getItemName(sku)
  }

  const pick = (id: string) => {
    setPicked(id)
    setScanNote('')
    // Pre-fill from the oldest stock, which is what should go first anyway —
    // the register modal's own seeding, never re-derived here.
    const o = queue.find((q) => q.order.id === id)?.order
    setPicks(o ? seedAllocations(o.lines, availableFor) : {})
  }

  // A link from the order desk lands here with ?id= while the form may already
  // be open on another order — the select follows the address as well as the
  // click. The queue/pick closures are read once per id change: a state update
  // under an open form must never re-seed the operator's edits away.
  const linkedId = params.get('id')
  useEffect(() => {
    if (linkedId) pick(linkedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedId])

  // A remembered vehicle lands after mount; a vehicle already typed is never
  // overwritten.
  useEffect(() => {
    const last = remembered.value.vehicle
    if (remembered.restored && last && !vehicle) setVehicle(last)
  }, [remembered.restored, remembered.value.vehicle, vehicle])

  const scanOrder = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = queue.find(
      (q) => q.order.id.toLowerCase() === wanted || q.order.customerName.toLowerCase() === wanted,
    )
    if (!found) {
      setScanNote(
        queue.length
          ? `No open order reads ${code}.`
          : `No open orders — nothing is waiting to go out.`,
      )
      return
    }
    pick(found.order.id)
  }

  const shortLine = current ? shortLineOf(current.order.lines, picks) : undefined

  const submit = () => {
    if (!current || shortLine) return
    // dispatchOrder re-checks against live stock and toasts its own refusals;
    // on one it returns null and the form stays put, picks intact.
    const ok = dispatchOrder(
      current.order.id,
      allocationsFromPicks(current.order.lines, picks),
      vehicle,
    )
    if (!ok) return
    if (vehicle) remembered.set({ vehicle })
    // The dispatched order has left the queue — the form is ready for the next
    // one, seeded exactly as a manual pick seeds it.
    const next = queue.find((q) => q.order.id !== current.order.id)
    pick(next ? next.order.id : '')
  }

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Dispatch</h2>
          <span className="cell-sub">
            Open orders in ship-by order — the overdue ones first — picked from the released lots
            that should go out, in one challan
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'queue',
            title: 'Waiting to go out',
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
                    No open orders — nothing is waiting to go out. Orders are raised at the desk
                    once the goods are packed and cleared.
                  </p>
                )}
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
              </div>
            ),
          },
          {
            id: 'dispatch',
            title: current ? `Dispatch ${current.order.id}` : 'Dispatch an order',
            hint: current ? current.order.customerName : 'Pick an order above',
            children: current ? (
              <div>
                <div className="form-grid">
                  <div className="field">
                    <label>Customer</label>
                    <div className="field-fixed">{current.order.customerName}</div>
                  </div>
                  <div className="field">
                    <label>Ship by</label>
                    <div className="field-fixed">
                      {current.order.dueDate
                        ? `${fmtDate(current.order.dueDate)}${current.overdue ? ' · OVERDUE' : ''}`
                        : '—'}
                    </div>
                  </div>
                </div>

                {current.order.lines.map((line) => {
                  const lots = availableFor.get(line.sku) || []
                  const allotted = allottedFor(picks, line.sku)
                  return (
                    <div className="subform" key={line.sku} style={{ marginTop: 12 }}>
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
                                {(() => {
                                  const dates = lotDates(state, r.lot, {
                                    sku: r.item,
                                    expiry: r.expiry,
                                    location: r.location,
                                  })
                                  return dates ? <div className="small">{dates}</div> : null
                                })()}
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

                <div className="form-grid" style={{ marginTop: 12 }}>
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
                    ? `${packLabel(shortLine.sku)} is ${allottedFor(picks, shortLine.sku)} of ${shortLine.qty}. An order goes out complete, so every line has to be filled before it can be dispatched.`
                    : 'Every line is checked against live stock again as it posts, and all of them are written together — the order cannot end up half sent.'}
                </div>
              </div>
            ) : (
              <p className="cell-sub">
                Pick an order from the queue — its lines come up seeded from the oldest released
                stock, which should go first anyway.
              </p>
            ),
          },
        ]}
        footer={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={!current || !!shortLine}
            >
              {current ? `Dispatch ${current.order.id}` : 'Dispatch order'}
            </button>
          </div>
        }
      />
    </div>
  )
}
