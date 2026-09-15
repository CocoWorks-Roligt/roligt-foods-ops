import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PhotoStrip } from '../components/Attachments'
import { DetailView, type DetailSection } from '../components/DetailView'
import { DocLink } from '../components/DocLink'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import {
  displayExpiry,
  expiryFor,
  locationLabel,
  parseRowKey,
  rowKey,
  stockRowsExcluding,
} from '../lib/stock'
import { useLinkedView } from '../lib/linkedView'
import { stockIdOfRow } from '../lib/stockIds'
import { uploadAttachment } from '../lib/uploads'
import { fmtDate, toLocalInputValue } from '../lib/utils'
import type { Attachment, Dispatch } from '../types'

export function DispatchPage() {
  const {
    state,
    rows,
    getItemName,
    createDispatch,
    updateDispatch,
    deleteDispatch,
    completeDelivery,
    showToast,
  } = useApp()
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [deliveryId, setDeliveryId] = useState<string | null>(null)
  const [form, setForm] = useState({
    customerId: '',
    stock: '',
    qty: 0,
    vehicle: '',
    expected: '',
    notes: '',
  })
  const [delivery, setDelivery] = useState({
    status: 'Delivered',
    pod: '',
    note: '',
    photos: [] as Attachment[],
  })
  const [uploading, setUploading] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null)
  const [viewId, setViewId, closeView] = useLinkedView((id) => state.dispatches.some((d) => d.id === id))
  const navigate = useNavigate()

  /** Opens the delivery dialog on a dispatch, carrying whatever was recorded before —
   *  so a photograph somebody forgot can be added afterwards without losing the rest. */
  const openDelivery = (d: Dispatch) => {
    setDeliveryId(d.id)
    setDelivery({
      status: ['Dispatched', 'In Transit'].includes(d.status) ? 'Delivered' : d.status,
      pod: d.pod || '',
      note: d.deliveryNote || '',
      photos: d.podPhotos || [],
    })
  }

  /**
   * Photographs taken at the door. They go into the same private bucket the lab
   * reports use and travel on the dispatch as object keys, so the challan carries its
   * own proof rather than a name somebody typed.
   */
  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    try {
      const uploaded: Attachment[] = []
      for (const file of Array.from(files)) {
        uploaded.push(await uploadAttachment(file, `pod-${deliveryId || 'delivery'}`))
      }
      setDelivery((d) => ({ ...d, photos: [...d.photos, ...uploaded] }))
      showToast(`${uploaded.length} photo(s) attached.`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const editing = editId ? state.dispatches.find((d) => d.id === editId) : undefined

  /**
   * Everything packed and cleared by QC, earliest expiry first. Packs are dispatched
   * out of the freezer they were filled into — there is no defrost step in between,
   * so where the stock sits no longer decides whether it may go.
   */
  const packed = useMemo(
    () =>
      rows
        .filter((r) => r.itemType === 'Finished Goods' && r.status === 'Released' && r.qty > 0)
        .map((r) => ({ ...r, shownExpiry: displayExpiry(state, r) }))
        .sort((a, b) => (a.shownExpiry || '').localeCompare(b.shownExpiry || '')),
    [rows, state],
  )

  /**
   * What the dispatch form can pick from. Editing puts the packs this dispatch took
   * back on the shelf first, so the line it went out on stays selectable and its
   * quantity can be raised as well as lowered.
   */
  const options = useMemo(() => {
    if (!editing) return packed
    return stockRowsExcluding(state, editing.id)
      .filter((r) => r.itemType === 'Finished Goods' && r.status === 'Released' && r.qty > 0)
      .map((r) => ({ ...r, shownExpiry: displayExpiry(state, r) }))
      .sort((a, b) => (a.shownExpiry || '').localeCompare(b.shownExpiry || ''))
  }, [editing, packed, state])

  const viewing = viewId ? state.dispatches.find((d) => d.id === viewId) : undefined
  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Dispatch',
          fields: [
            { label: 'Dispatch', value: viewing.id },
            { label: 'Challan', value: viewing.challan },
            { label: 'Dispatched at', value: fmtDate(viewing.dispatchTime) },
            { label: 'Vehicle', value: viewing.vehicle },
            { label: 'Status', value: viewing.status },
            { label: 'Expected delivery', value: viewing.expected ? fmtDate(viewing.expected) : '' },
          ],
        },
        {
          title: 'Customer',
          fields: [
            { label: 'Customer', value: viewing.customerName },
            { label: 'Customer code', value: viewing.customerId },
            {
              label: 'Ship to',
              value: state.customers.find((c) => c.id === viewing.customerId)?.shipTo,
              wide: true,
            },
          ],
        },
        {
          title: 'Goods',
          fields: [
            { label: 'SKU', value: viewing.sku },
            { label: 'Batch', value: <DocLink doc={viewing.batchId} /> },
            { label: 'Quantity', value: viewing.qty },
            { label: 'Expiry', value: viewing.expiry || expiryFor(state, viewing.batchId, viewing.sku) },
          ],
        },
        {
          title: 'Delivery',
          fields: [
            { label: 'Delivered at', value: viewing.deliveredTime ? fmtDate(viewing.deliveredTime) : '' },
            { label: 'Received by', value: viewing.pod },
            {
              label: 'Proof photos',
              // The names lead, so the record's own export carries them — it can only
              // take text, and a strip of images would come out of it blank.
              value: viewing.podPhotos?.length ? (
                <>
                  <div className="small">
                    {viewing.podPhotos.length} photo(s):{' '}
                    {viewing.podPhotos.map((f) => f.fileName).join(', ')}
                  </div>
                  <PhotoStrip files={viewing.podPhotos} />
                </>
              ) : (
                'None attached'
              ),
              wide: true,
            },
            { label: 'Delivery note', value: viewing.deliveryNote, wide: true },
            { label: 'Dispatch notes', value: viewing.notes, wide: true },
          ],
        },
      ]
    : []

  /** Every dispatch raised, newest first. */
  const history = useMemo(
    () => [...state.dispatches].sort((a, b) => b.dispatchTime.localeCompare(a.dispatchTime)),
    [state.dispatches],
  )

  const openForm = (stock = '') => {
    if (!packed.length) {
      showToast('No packed stock has been released yet.')
      return
    }
    setEditId('')
    setForm({
      customerId: '',
      stock,
      qty: 0,
      vehicle: '',
      expected: toLocalInputValue(),
      notes: '',
    })
    setOpen(true)
  }

  const openEdit = (d: Dispatch) => {
    // The dispatch itself does not record where the packs were picked from — its
    // ledger line does, and that is the stock an edit has to point back at.
    const line = state.ledger.find((l) => l.doc === d.id && l.type === 'Dispatch')
    setEditId(d.id)
    setForm({
      customerId: d.customerId,
      stock: line
        ? rowKey({ item: d.sku, lot: d.batchId, location: line.location, expiry: line.expiry })
        : '',
      qty: d.qty,
      vehicle: d.vehicle || '',
      expected: d.expected ? toLocalInputValue(new Date(d.expected)) : '',
      notes: d.notes || '',
    })
    setOpen(true)
  }

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Dispatch & Delivery</h3>
          <span>Released packs only — dispatch deducts stock, delivery does not</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" onClick={() => openForm()}>
            + New Dispatch
          </button>
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 4 }}>
        <div>
          <h4>Packed stock</h4>
          <span className="small">
            Everything packed and cleared by QC, earliest expiry first — dispatched
            straight out of the freezer it was packed into.
          </span>
        </div>
      </div>
      {!packed.length ? (
        <div className="empty">No packed stock has been released yet.</div>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Stock ID</th>
                <th>Batch / Lot</th>
                <th>Location</th>
                <th className="cell-num cell-tight">Available</th>
                <th className="cell-tight">Expiry</th>
                <th className="cell-actions">Action</th>
              </tr>
            </thead>
            <tbody>
              {packed.map((r) => (
                <tr key={rowKey(r)} className="selectable-row">
                  <td data-label="Stock ID">
                    <b className="cell-id">{stockIdOfRow(state, r)}</b>
                    <div className="cell-sub">{getItemName(r.item)}</div>
                  </td>
                  <td data-label="Batch / Lot">{r.lot}</td>
                  <td data-label="Location">{locationLabel(state, r.location)}</td>
                  <td data-label="Available" className="cell-num cell-tight">
                    {r.qty} {r.uom}
                  </td>
                  <td data-label="Expiry" className="cell-tight">{r.shownExpiry || '—'}</td>
                  <td className="cell-actions">
                    <button
                      className="btn btn-light"
                      onClick={() => openForm(rowKey(r))}
                    >
                      Dispatch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="section-head" style={{ marginTop: 4 }}>
        <div>
          <h4>Dispatch history</h4>
          <span className="small">Every dispatch raised, newest first</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Dispatch</th>
              <th>Customer</th>
              <th>Batch</th>
              <th>Qty</th>
              <th>Challan</th>
              <th>Vehicle</th>
              <th>Dispatch Time</th>
              <th>Delivery Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!state.dispatches.length ? (
              <tr>
                <td colSpan={9} className="empty">
                  No dispatches.
                </td>
              </tr>
            ) : (
              history.map((d) => (
                <tr key={d.id}>
                  <td data-label="Dispatch">
                    <b>{d.id}</b>
                  </td>
                  <td data-label="Customer">{d.customerName}</td>
                  <td data-label="Batch">
                    <DocLink doc={d.batchId} />
                    <div className="cell-sub cell-id">{d.sku}</div>
                    {d.notes ? <div className="small">{d.notes}</div> : null}
                    {d.deliveryNote ? <div className="small">Delivery note: {d.deliveryNote}</div> : null}
                  </td>
                  <td data-label="Qty">{d.qty}</td>
                  <td data-label="Challan">{d.challan}</td>
                  <td data-label="Vehicle">{d.vehicle || '—'}</td>
                  <td data-label="Dispatch Time">{fmtDate(d.dispatchTime)}</td>
                  <td data-label="Delivery Status">
                    <StatusBadge value={d.status} />
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <button className="btn btn-light" onClick={() => setViewId(d.id)}>
                        View
                      </button>
                      <button className="btn btn-light" onClick={() => openEdit(d)}>
                        Edit
                      </button>
                      <button className="btn btn-light" onClick={() => openDelivery(d)}>
                        {['Dispatched', 'In Transit'].includes(d.status)
                          ? 'Mark delivered'
                          : 'Delivery proof'}
                      </button>
                      {/* The same shortcut a receipt and a packing run already carry —
                          a carton going out gets its own sticker stage. */}
                      <button
                        className="btn btn-light"
                        onClick={() =>
                          navigate(
                            `/stickers?stage=dispatch&q=${encodeURIComponent(
                              d.id,
                            )}&ref=${encodeURIComponent(d.id)}`,
                          )
                        }
                      >
                        Sticker
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          if (confirm(`Delete ${d.id}? This returns the stock to Released.`)) {
                            deleteDispatch(d.id)
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <DetailView
        open={!!viewing}
        title={viewing ? `${viewing.id} · ${viewing.challan}` : 'Dispatch'}
        sections={viewSections}
        onClose={closeView}
        record={viewing?.id}
      />

      <Modal
        open={open}
        title={editing ? `Edit ${editing.id} · ${editing.challan}` : 'New Dispatch'}
        saveLabel={editing ? 'Save Changes' : 'Confirm Dispatch'}
        onClose={() => {
          setOpen(false)
          setEditId('')
        }}
        onSave={() => {
          const picked = parseRowKey(form.stock)
          const input = {
            customerId: form.customerId,
            sku: picked.item,
            batchId: picked.lot,
            location: picked.location,
            // Two runs off one batch into one freezer are two rows under two dates.
            // Without this the check matched whichever came first and the challan went
            // out carrying that row's date whichever packs actually left.
            expiry: picked.expiry,
            qty: form.qty,
            vehicle: form.vehicle,
            expected: form.expected,
            notes: form.notes,
          }
          const ok = editing ? updateDispatch(editing.id, input) : createDispatch(input)
          if (ok) {
            setOpen(false)
            setEditId('')
          }
        }}
      >
        <div className="form-grid">
          <div className="field span-2">
            <label>Customer / ship-to</label>
            <Select
              value={form.customerId}
              onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            >
              <option value="">Select</option>
              {state.customers
                .filter((c) => c.status === 'Active')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.name}
                  </option>
                ))}
            </Select>
          </div>
          <div className="field">
            <label>Packed item to dispatch (earliest expiry first)</label>
            <Select
              value={form.stock}
              onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
            >
              <option value="">Select packed stock</option>
              {options.map((r) => (
                <option key={rowKey(r)} value={rowKey(r)}>
                  {stockIdOfRow(state, r)} · {getItemName(r.item)} · {locationLabel(state, r.location)} · {r.qty} available · exp{' '}
                  {r.shownExpiry || 'n/a'}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Dispatch quantity</label>
            <input
              type="number"
              min={1}
              value={form.qty || ''}
              onChange={(e) => setForm((f) => ({ ...f, qty: Number(e.target.value) }))}
            />
          </div>
          <div className="field">
            <label>Vehicle number</label>
            <input
              value={form.vehicle}
              placeholder="TS09AB1234"
              onChange={(e) => setForm((f) => ({ ...f, vehicle: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Expected delivery</label>
            <input
              type="datetime-local"
              value={form.expected}
              onChange={(e) => setForm((f) => ({ ...f, expected: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Notes</label>
            <textarea
              value={form.notes}
              placeholder="Driver, transporter, temperature or condition notes"
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
        </div>
        <div className="note warning-note">
          {editing
            ? 'Saving returns the packs this dispatch took and deducts the corrected line instead. The challan number, dispatch time and any recorded delivery stay as they are.'
            : 'Finished-goods stock comes off the books the moment you confirm the dispatch. Marking it Delivered later only closes the trip and records who signed for it.'}
        </div>
      </Modal>

      <Modal
        open={!!deliveryId}
        title={`Delivery · ${deliveryId || ''}`}
        saveLabel="Save Delivery"
        onClose={() => setDeliveryId(null)}
        onSave={() => {
          if (!deliveryId) return
          completeDelivery(deliveryId, {
            status: delivery.status,
            pod: delivery.pod,
            note: delivery.note,
            photos: delivery.photos,
          })
          setDeliveryId(null)
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Status</label>
            <Select
              value={delivery.status}
              onChange={(e) => setDelivery((d) => ({ ...d, status: e.target.value }))}
            >
              <option>Delivered</option>
              <option>Failed</option>
              <option>Returned</option>
              <option>Partially Delivered</option>
            </Select>
          </div>
          <div className="field">
            <label>Received by (name or signed-slip reference)</label>
            <input
              value={delivery.pod}
              placeholder="Who signed for it, or the slip number"
              onChange={(e) => setDelivery((d) => ({ ...d, pod: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Delivery note</label>
            <textarea
              value={delivery.note}
              onChange={(e) => setDelivery((d) => ({ ...d, note: e.target.value }))}
            />
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Proof photos</span>
            <span className="small" style={{ fontWeight: 400 }}>
              The signed slip, the cartons at the door, a temperature reading
            </span>
          </div>
          <div className="subform-body">
            <PhotoStrip
              files={delivery.photos}
              empty="No photos attached yet."
              onRemove={(i) =>
                setDelivery((d) => ({ ...d, photos: d.photos.filter((_, x) => x !== i) }))
              }
            />
            <input
              ref={photoInput}
              type="file"
              accept="image/*,.pdf,application/pdf"
              multiple
              hidden
              onChange={(e) => {
                void addPhotos(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="row-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-light"
                disabled={uploading}
                onClick={() => photoInput.current?.click()}
              >
                {uploading ? 'Uploading…' : '+ Add photos'}
              </button>
            </div>
            <div className="small" style={{ marginTop: 8 }}>
              On a phone this opens the camera. Photos are kept privately and opened through a
              short-lived link, so nobody can reach them by guessing a URL.
            </div>
          </div>
        </div>

        <div className="note">
          No additional inventory deduction occurs when delivery is completed — the stock came
          off the books at dispatch. What this records is who took the goods and the proof of it.
        </div>
      </Modal>
    </div>
  )
}
