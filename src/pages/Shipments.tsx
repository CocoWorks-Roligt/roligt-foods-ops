/**
 * Shipment Tracking (SHIPMENT S1, behind the `shipments` flag): the board of
 * everything that left the gate — one row per trip, out to the signed
 * challan. The list is the server's own (/api/shipments; shipments are not a
 * Classic state key), refetched on the SSE revision tick so the board never
 * shows a trip the PWA just closed; the same fetch parks the list in the
 * module store so the sidebar badge counts live trips with the board closed.
 *
 * The board's writes are exactly PATCH's two jobs — reassignment on an active
 * trip and the Failed→Rescheduled retry — plus creating tomorrow's trips off
 * dispatch rows nothing carries yet. Outcomes at the door belong to the
 * delivery PWA's submit; the board only reads them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { DataTable, type Column } from '../components/shell/DataTable'
import { KpiCard } from '../components/shell/KpiCard'
import { useApp } from '../context/AppContext'
import { useKpis } from '../lib/useKpis'
import { useRevisionFeed } from '../lib/useRevisionFeed'
import {
  challanFileUrl,
  fetchShipment,
  fetchShipments,
  patchShipmentCall,
  createShipmentCall,
  PoApiError,
} from '../lib/shipmentApi'
import { setShipments } from '../lib/shipmentStore'
import {
  BOARD_FILTERS,
  boardRow,
  canReassign,
  canReschedule,
  filterRows,
  freeDispatches,
  type ShipmentBoardRow,
} from '../lib/shipmentView'
import { exportCsv } from '../lib/export'
import { fmtDate } from '../lib/utils'
import type { DeliveryEvent, ShipmentDetail, ShipmentStatus } from '../lib/contracts'
import type { Dispatch } from '../types'

/** The last word on why a trip failed — the failed event's own reason. */
const failureReason = (events: readonly DeliveryEvent[]): string => {
  const failed = [...events].reverse().find((e) => e.type === 'failed')
  const reason = failed?.payload?.reason
  return typeof reason === 'string' ? reason : ''
}

export function Shipments() {
  const { state } = useApp()
  const kpis = useKpis('shipment-tracking')

  const [details, setDetails] = useState<ShipmentDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<ShipmentStatus | 'All'>('All')
  const [q, setQ] = useState('')

  // The board's one data door: the server's list, whole, on every revision
  // tick — the same feed every Classic page already rides.
  const load = useCallback(async () => {
    try {
      const list = await fetchShipments()
      setDetails(list)
      setShipments(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load shipments.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useRevisionFeed(useCallback(() => void load(), [load]))

  const rows = useMemo(() => details.map(boardRow), [details])
  const shown = useMemo(() => filterRows(rows, { status, q }), [rows, status, q])

  // The drawer's own subject: the trip with its event history.
  const [openId, setOpenId] = useState<string | null>(null)
  const [events, setEvents] = useState<DeliveryEvent[]>([])
  const [drawerError, setDrawerError] = useState<string | null>(null)
  useEffect(() => {
    if (!openId) return
    setEvents([])
    setDrawerError(null)
    void fetchShipment(openId)
      .then((d) => setEvents(d.events))
      .catch((e: unknown) => setDrawerError(e instanceof Error ? e.message : 'Could not open this trip.'))
  }, [openId])
  const openDetail = details.find((d) => d.shipment.id === openId) ?? null

  // Reassignment / reschedule — PATCH's own fields, CAS on the row's version.
  const [agent, setAgent] = useState('')
  const [eta, setEta] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    setAgent(openDetail?.shipment.agentUserId ?? '')
    setEta(openDetail?.shipment.eta?.slice(0, 10) ?? '')
    setActionError(null)
  }, [openDetail])

  const patch = async (body: Record<string, unknown>) => {
    if (!openDetail) return
    setBusy(true)
    setActionError(null)
    try {
      await patchShipmentCall(openDetail.shipment.id, {
        expectedVersion: openDetail.shipment.version,
        ...body,
      })
      setOpenId(null)
      await load()
    } catch (e) {
      setActionError(e instanceof PoApiError ? e.message : 'That change did not go through — try again.')
    } finally {
      setBusy(false)
    }
  }

  // The create form — dispatch rows no active trip carries, grouped per order.
  const [creating, setCreating] = useState(false)
  const freeOrders = useMemo(() => freeDispatches(state.dispatches, details), [state.dispatches, details])

  const columns: Column<ShipmentBoardRow>[] = [
    { key: 'order', label: 'Order', sort: (r) => r.orderId },
    { key: 'customer', label: 'Customer', render: (r) => r.customers, sort: (r) => r.customers },
    { key: 'dispatched', label: 'Dispatched', render: (r) => fmtDate(r.dispatchDate) || '—', sort: (r) => r.dispatchDate },
    { key: 'agent', label: 'Agent', render: (r) => r.agent, sort: (r) => r.agent },
    { key: 'vehicle', label: 'Vehicle', sort: (r) => r.vehicle },
    { key: 'packaging', label: 'Packaging', sort: (r) => r.packaging },
    { key: 'items', label: 'Items', sort: (r) => r.items },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} />, sort: (r) => r.status },
    { key: 'eta', label: 'ETA', render: (r) => (r.eta ? fmtDate(r.eta) : '—'), sort: (r) => r.eta ?? '' },
    {
      key: 'delivered',
      label: 'Delivered at',
      render: (r) => (r.deliveredAt ? fmtDate(r.deliveredAt) : '—'),
      sort: (r) => r.deliveredAt ?? '',
    },
    {
      key: 'challan',
      label: 'Challan',
      render: (r) =>
        r.challans.length ? (
          r.challans.map((c) => (
            <a
              key={c.id}
              className="challan-link"
              href={challanFileUrl(c.id)}
              target="_blank"
              rel="noreferrer"
              // the row itself opens the drawer; the PDF opens alone
              onClick={(e) => e.stopPropagation()}
            >
              {c.number}
              {c.status === 'Superseded' ? ' (old)' : ''}
            </a>
          ))
        ) : (
          '—'
        ),
      sort: (r) => r.challans[0]?.number ?? '',
    },
  ]

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Shipment Tracking</h3>
          <span>Everything that left the gate, out to the signed challan</span>
        </div>
        <div className="section-head-actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              exportCsv('shipments', [
                { header: 'Order', value: (r) => r.orderId },
                { header: 'Customer', value: (r) => r.customers },
                { header: 'Dispatched', value: (r) => r.dispatchDate },
                { header: 'Agent', value: (r) => r.agent },
                { header: 'Vehicle', value: (r) => r.vehicle },
                { header: 'Packaging', value: (r) => r.packaging },
                { header: 'Items', value: (r) => r.items },
                { header: 'Status', value: (r) => r.status },
                { header: 'ETA', value: (r) => r.eta ?? '' },
                { header: 'Delivered at', value: (r) => r.deliveredAt ?? '' },
                { header: 'Challans', value: (r) => r.challans.map((c) => c.number).join(' ') },
              ], shown)
            }
          >
            Export CSV
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New trip
          </button>
        </div>
      </div>

      {kpis.data?.cards?.length ? (
        <div className="kpi-row" aria-label="Shipment figures">
          {kpis.data.cards.map((c) => (
            <KpiCard key={c.key} card={c} />
          ))}
        </div>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="toolbar">
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as ShipmentStatus | 'All')}>
          {BOARD_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === 'All' ? 'All statuses' : s}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Order, customer, agent, vehicle, DC number…"
          aria-label="Search shipments"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <p>Loading trips…</p>
      ) : shown.length === 0 ? (
        <EmptyState
          filtered={status !== 'All' || q.trim().length > 0}
          empty="No trips yet — board dispatch rows onto one with New trip."
          onClear={() => {
            setStatus('All')
            setQ('')
          }}
        />
      ) : (
        <DataTable
          id="shipments-board"
          columns={columns}
          rows={shown}
          rowKey={(r) => r.id}
          empty=""
          onRowClick={(r) => setOpenId(r.id)}
        />
      )}

      {openDetail ? (
        <Modal
          title={`Trip ${openDetail.shipment.id} · ${openDetail.shipment.status}`}
          open
          readOnly
          onClose={() => setOpenId(null)}
          onSave={() => setOpenId(null)}
        >
          <div className="shipment-drawer">
            <dl className="detail-grid">
              <div>
                <dt>Order</dt>
                <dd>{openDetail.shipment.orderId}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{openDetail.shipment.agentUserId ?? '—'}</dd>
              </div>
              <div>
                <dt>Vehicle</dt>
                <dd>{openDetail.shipment.vehicle}</dd>
              </div>
              <div>
                <dt>Packaging</dt>
                <dd>{openDetail.shipment.packaging}</dd>
              </div>
              <div>
                <dt>Dispatched</dt>
                <dd>{fmtDate(openDetail.shipment.times.dispatched) || '—'}</dd>
              </div>
              <div>
                <dt>Delivered at</dt>
                <dd>{fmtDate(openDetail.shipment.times.delivered) || '—'}</dd>
              </div>
            </dl>

            {failureReason(events) ? <p className="form-error">Failed: {failureReason(events)}</p> : null}
            {drawerError ? <p className="cell-sub">{drawerError}</p> : null}

            <h4>Lines</h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Lot</th>
                    <th>Qty</th>
                    <th>Customer</th>
                    <th>DC</th>
                  </tr>
                </thead>
                <tbody>
                  {openDetail.lines.map((l) => (
                    <tr key={l.dispatchId}>
                      <td>{l.sku}</td>
                      <td>{l.lot}</td>
                      <td>{l.qty}</td>
                      <td>{l.customerName}</td>
                      <td>{l.challan}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {events.length ? (
              <>
                <h4>History</h4>
                <ul className="event-list">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="event-type">{e.type}</span> {fmtDate(e.at)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {canReassign(openDetail.shipment.status) ? (
              <form
                className="form-grid"
                onSubmit={(e) => {
                  e.preventDefault()
                  void patch({
                    // A Failed trip's save IS the reschedule arrow; any other
                    // active trip saves as a plain reassignment.
                    ...(canReschedule(openDetail.shipment.status) ? { status: 'Rescheduled' as const } : {}),
                    ...(agent.trim() && agent !== openDetail.shipment.agentUserId ? { agentUserId: agent.trim() } : {}),
                    ...(eta && eta !== openDetail.shipment.eta?.slice(0, 10) ? { eta } : {}),
                  })
                }}
              >
                <h4>{canReschedule(openDetail.shipment.status) ? 'Reschedule the retry' : 'Reassign'}</h4>
                <label>
                  Agent (email)
                  <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="driver@roligt.local" />
                </label>
                <label>
                  ETA
                  <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
                </label>
                {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {canReschedule(openDetail.shipment.status) ? 'Reschedule trip' : 'Save changes'}
                </button>
              </form>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {creating ? (
        <NewTripModal orders={freeOrders} onClose={() => setCreating(false)} onCreated={() => setCreating(false)} reload={load} />
      ) : null}
    </div>
  )
}

/** The create form: one order's free dispatch rows boarded onto one trip. */
function NewTripModal({
  orders,
  onClose,
  onCreated,
  reload,
}: {
  orders: { orderId: string; customerName: string; rows: Dispatch[] }[]
  onClose: () => void
  onCreated: () => void
  reload: () => Promise<void>
}) {
  const { state } = useApp()
  const [orderId, setOrderId] = useState(orders[0]?.orderId ?? '')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [vehicle, setVehicle] = useState('')
  const [agent, setAgent] = useState('')
  const [eta, setEta] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const order = orders.find((o) => o.orderId === orderId)
  useEffect(() => {
    setPicked(new Set())
    // The vehicle the dispatch already named is the trip's best first guess.
    setVehicle(order?.rows[0]?.vehicle ?? '')
  }, [orderId, order])

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const save = async () => {
    if (!order || picked.size === 0) {
      setFormError('Pick at least one dispatch row.')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      // Multi-customer trips spell their stops out (the server demands it);
      // single-customer ones let the server derive the stop off the customer
      // master — same rule the create endpoint enforces.
      const customerIds = [...new Set(order.rows.filter((r) => picked.has(r.id)).map((r) => r.customerId))]
      const stops =
        customerIds.length > 1
          ? customerIds.map((cid) => ({
              customerId: cid,
              address: state.customers.find((c) => c.id === cid)?.shipTo,
              dispatchIds: order.rows.filter((r) => picked.has(r.id) && r.customerId === cid).map((r) => r.id),
            }))
          : undefined
      await createShipmentCall({
        orderId,
        dispatchIds: [...picked],
        vehicle: vehicle.trim(),
        ...(agent.trim() ? { agentUserId: agent.trim() } : {}),
        ...(eta ? { eta } : {}),
        ...(stops ? { stops } : {}),
      })
      onCreated()
      await reload()
    } catch (e) {
      setFormError(e instanceof PoApiError ? e.message : 'The trip was not created — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="New trip" open onClose={onClose} onSave={() => void save()} saveLabel="Create trip" saveDisabled={busy || !orderId}>
      {orders.length === 0 ? (
        <p>No dispatch rows are waiting for a trip — dispatch an order first.</p>
      ) : (
        <div className="form-grid">
          <label>
            Order
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              {orders.map((o) => (
                <option key={o.orderId} value={o.orderId}>
                  {o.orderId} · {o.customerName} · {o.rows.length} row{o.rows.length === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Dispatch rows</legend>
            {order?.rows.map((r) => (
              <label key={r.id} className="check-row">
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                {r.sku} × {r.qty} ({r.id})
              </label>
            ))}
          </fieldset>
          <label>
            Vehicle
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="AP-07-1234" required />
          </label>
          <label>
            Agent (email)
            <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="driver@roligt.local" />
          </label>
          <label>
            ETA
            <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
          </label>
          {formError ? <p className="form-error" role="alert">{formError}</p> : null}
        </div>
      )}
    </Modal>
  )
}
