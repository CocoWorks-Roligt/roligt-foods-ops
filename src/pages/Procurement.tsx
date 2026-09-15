/**
 * Procurement — everything that arrives at the gate.
 *
 * Produce and packing material are both goods received, so they are both received
 * here. Packing material used to be booked in from a button on the Packing Materials
 * page, which meant the plant had two receiving screens with two vocabularies, and the
 * one page that was supposed to say what packing stock you have spent half its height
 * on how it got there.
 */

import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DetailView, type DetailSection } from '../components/DetailView'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { EmptyState } from '../components/EmptyState'
import { useApp } from '../context/AppContext'
import { COCONUT_ITEM } from '../lib/batches'
import { useLinkedView } from '../lib/linkedView'
import { defaultPackingStore, defaultRawStore, postedLocation } from '../lib/posting'
import { itemName as lookupItemName, locationLabel, areaChoices } from '../lib/stock'
import { fmtDate, fmtQty, inr, toLocalInputValue } from '../lib/utils'
import type { Grn } from '../types'

/** Line under the source name: the grower when a vendor is named above it, plus the area. */
function sourceNote(g: Grn) {
  return [g.farmerName ? g.farmer : 'Direct farmer purchase', g.area].filter(Boolean).join(' · ')
}

/** Number inputs start empty so nothing is ever posted that the operator did not type. */
type NumValue = number | ''

const blankForm = {
  date: toLocalInputValue(),
  purchaseProductId: '',
  location: '',
  farmerId: '',
  farmer: '',
  area: '',
  harvestedOn: '',
  total: '' as NumValue,
  free: '' as NumValue,
  rate: '' as NumValue,
  a: '' as NumValue,
  b: '' as NumValue,
  c: '' as NumValue,
  reject: '' as NumValue,
  transport: '' as NumValue,
  notes: '',
}

const num = (v: NumValue) => Number(v) || 0

/** `unit` is the product's own unit — pieces of coconut, kilograms of beetroot. */
const numberFields = (unit: string) =>
  [
    ['total', `Total received (incl. free), in ${unit}`],
    ['free', `Free ${unit} (not charged)`],
    ['rate', `Common rate / ${unit.replace(/s$/, '')}`],
    ['a', 'Grade A'],
    ['b', 'Grade B'],
    ['c', 'Grade C'],
    ['reject', 'Rejected'],
    ['transport', 'Transport cost'],
  ] as const

/** A packing-material receipt as the form holds it. */
const blankPm = {
  date: toLocalInputValue(),
  purchaseProductId: '',
  qty: '' as NumValue,
  unitCost: '' as NumValue,
  lot: '',
  location: '',
  vendorId: '',
}

export function Procurement() {
  const {
    state,
    createGrn,
    updateGrn,
    deleteGrn,
    addPackingStock,
    updatePackingStock,
    deletePackingStock,
  } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  // Opens from a link as well as a click: a batch's source lot lands here on its receipt,
  // and a packing run's material lands on the packing-material receipt it drew.
  const [viewId, setViewId, closeView] = useLinkedView(
    (id) =>
      state.grns.some((g) => g.id === id) ||
      state.ledger.some((l) => l.type === 'PM Receipt' && l.doc === id),
  )
  const [form, setForm] = useState(blankForm)
  const [pmOpen, setPmOpen] = useState(false)
  const [pmEditDoc, setPmEditDoc] = useState('')
  const [pmForm, setPmForm] = useState(blankPm)
  const [pmSearch, setPmSearch] = useState('')

  /**
   * Which sort of receipt is on screen. Held in the URL so the Packing Materials page
   * can link straight to the one it means, and so a reload does not drop back to
   * produce with a half-typed form behind it.
   */
  const tab = params.get('tab') === 'packing' ? 'packing' : 'produce'
  const setTab = (next: 'produce' | 'packing') =>
    setParams(next === 'packing' ? { tab: 'packing' } : {}, { replace: true })

  const rows = useMemo(() => {
    const q = search.toLowerCase()
    return state.grns
      .filter(
        (g) =>
          (!status || g.status === status) &&
          [g.id, g.lot, g.farmerName, g.farmer || '', g.area || '']
            .join(' ')
            .toLowerCase()
            .includes(q),
      )
      .slice()
      .reverse()
  }, [search, state.grns, status])

  /** Lots already issued to production are costed into a batch — their numbers are frozen. */
  const lockedLots = useMemo(
    () => new Set(state.ledger.filter((l) => l.qtyOut > 0).map((l) => l.lot)),
    [state.ledger],
  )
  const editing = editId ? state.grns.find((g) => g.id === editId) : undefined
  const locked = !!editing && lockedLots.has(editing.lot)

  const set = (key: string, value: string | number) =>
    setForm((f) => ({ ...f, [key]: value }))

  const payload = () => ({
    date: form.date,
    purchaseProductId: form.purchaseProductId,
    itemId: buying?.itemId,
    uom: buying?.uom || 'Piece',
    location: form.location,
    farmerId: form.farmerId,
    farmer: form.farmer,
    area: form.area,
    harvestedOn: form.harvestedOn,
    total: num(form.total),
    free: num(form.free),
    rate: num(form.rate),
    a: num(form.a),
    b: num(form.b),
    c: num(form.c),
    reject: num(form.reject),
    transport: num(form.transport),
    notes: form.notes,
  })

  const openNew = () => {
    setEditId('')
    setForm({ ...blankForm, date: toLocalInputValue(), location: defaultRawStore(state) || '' })
    setOpen(true)
  }

  const openEdit = (g: Grn) => {
    setEditId(g.id)
    setForm({
      date: toLocalInputValue(new Date(g.date)),
      purchaseProductId: g.purchaseProductId || '',
      location: g.location || postedLocation(state, g.id, 'Raw Material') || '',
      farmerId: g.farmerId,
      farmer: g.farmer || '',
      area: g.area || '',
      harvestedOn: g.harvestedOn || '',
      total: g.total,
      free: g.free || 0,
      rate: g.rate,
      a: g.a,
      b: g.b,
      c: g.c,
      reject: g.reject,
      transport: g.transport,
      notes: g.notes || '',
    })
    setOpen(true)
  }

  // An older receipt can point at a vendor that has since been unapproved; keep it
  // listed so editing the notes does not silently drop the vendor off the GRN.
  const vendorOptions = state.vendors.filter(
    (v) => v.status === 'Active' || v.id === form.farmerId,
  )

  const itemName = (id: string) => lookupItemName(state, id)
  /** Produce the plant can receive; packing material is received on the other tab. */
  const produce = state.purchaseProducts.filter(
    (p) => p.status === 'Active' && p.category !== 'Packing Material',
  )
  const buying = produce.find((p) => p.id === form.purchaseProductId)
  // The unit reads off the product, so the quantity labels stay blank-friendly until
  // one is picked rather than promising pieces of something measured in kilograms.
  const unit = (buying?.uom || 'Piece').toLowerCase()
  // The suppliers a product is actually linked to, so a beetroot receipt does not offer
  // the coconut farmers.
  const sourceOptions = buying?.vendorIds.length
    ? vendorOptions.filter((v) => buying.vendorIds.includes(v.id) || v.id === form.farmerId)
    : vendorOptions

  /**
   * Packing material the plant can receive. Every packing item has a purchase-product
   * row — the migration mints one for any that predates the master — so this list is
   * the whole of what can be bought.
   */
  const packingProducts = state.purchaseProducts.filter(
    (p) => p.status === 'Active' && p.category === 'Packing Material',
  )
  const pmBuying = packingProducts.find((p) => p.id === pmForm.purchaseProductId)
  const pmItemId = pmBuying?.itemId || ''

  /**
   * Every packing-material receipt, newest first. They are one ledger line each, so
   * the ledger is the record — there is no second list to keep in step with it.
   */
  const pmReceipts = useMemo(() => {
    const q = pmSearch.trim().toLowerCase()
    return state.ledger
      .filter((l) => l.type === 'PM Receipt')
      .filter(
        (l) =>
          !q ||
          [l.doc, l.item, l.lot, lookupItemName(state, l.item)]
            .join(' ')
            .toLowerCase()
            .includes(q),
      )
      .slice()
      .sort((a, b) => b.time.localeCompare(a.time))
  }, [pmSearch, state])

  /** Whether a packing run has already drawn on what a receipt brought in. */
  const pmConsumed = (doc: string) => {
    const line = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
    if (!line) return false
    return state.ledger.some(
      (l) => l.doc !== doc && l.item === line.item && l.lot === line.lot && l.qtyOut > 0,
    )
  }

  // Suppliers this material is linked to on Products & Materials, then everyone else —
  // the link is a convenience, not a rule, because a one-off box of caps can come from
  // anywhere.
  const pmSuppliers = useMemo(() => {
    const linked = new Set(pmBuying?.vendorIds || [])
    const active = state.vendors.filter((v) => v.status === 'Active' || v.id === pmForm.vendorId)
    return [...active.filter((v) => linked.has(v.id)), ...active.filter((v) => !linked.has(v.id))]
  }, [pmBuying, pmForm.vendorId, state.vendors])

  const pmPayload = () => ({
    date: pmForm.date,
    purchaseProductId: pmForm.purchaseProductId,
    itemId: pmItemId,
    qty: num(pmForm.qty),
    unitCost: num(pmForm.unitCost),
    lot: pmForm.lot,
    location: pmForm.location,
    vendorId: pmForm.vendorId,
  })

  const openPmNew = () => {
    setPmEditDoc('')
    setPmForm({
      ...blankPm,
      date: toLocalInputValue(),
      purchaseProductId: packingProducts[0]?.id || '',
      location: defaultPackingStore(state) || '',
    })
    setPmOpen(true)
  }

  const openPmEdit = (doc: string) => {
    const line = state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === doc)
    if (!line) return
    setPmEditDoc(doc)
    setPmForm({
      date: toLocalInputValue(new Date(line.time)),
      // A receipt posted before packing material was bought by product carries only the
      // stock item, so the product is found back through it.
      purchaseProductId: state.purchaseProducts.find((p) => p.itemId === line.item)?.id || '',
      qty: line.qtyIn,
      unitCost: line.unitCost,
      lot: line.lot,
      location: line.location,
      vendorId: line.vendorId || '',
    })
    setPmOpen(true)
  }

  const viewing = viewId ? state.grns.find((g) => g.id === viewId) : undefined
  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Receipt',
          fields: [
            { label: 'GRN', value: viewing.id },
            { label: 'Lot', value: viewing.lot },
            {
              label: 'Product',
              value: viewing.productName || itemName(viewing.itemId || COCONUT_ITEM),
            },
            { label: 'Received on', value: fmtDate(viewing.date) },
            { label: 'Storage area', value: viewing.location ? locationLabel(state, viewing.location) : '—' },
            { label: 'Status', value: viewing.status },
            { label: 'Vendor', value: viewing.farmerName || 'Direct farmer purchase' },
            { label: 'Vendor code', value: viewing.farmerId },
          ],
        },
        {
          title: 'Source',
          fields: [
            { label: 'Farmer', value: viewing.farmer },
            { label: 'Area', value: viewing.area },
            { label: 'Harvested on', value: viewing.harvestedOn ? fmtDate(viewing.harvestedOn) : '' },
          ],
        },
        {
          title: 'Quantity',
          fields: [
            { label: 'Unit', value: viewing.uom || 'Piece' },
            { label: 'Total received', value: viewing.total },
            { label: 'Free (not charged)', value: viewing.free || 0 },
            { label: 'Chargeable', value: viewing.total - (viewing.free || 0) },
            { label: 'Grade A', value: viewing.a },
            { label: 'Grade B', value: viewing.b },
            { label: 'Grade C', value: viewing.c },
            { label: 'Rejected', value: viewing.reject },
            { label: 'Accepted into stock', value: viewing.accepted },
          ],
        },
        {
          title: 'Cost',
          fields: [
            { label: `Rate / ${(viewing.uom || 'Piece').toLowerCase()}`, value: inr(viewing.rate) },
            { label: 'Material value', value: inr(viewing.materialValue) },
            { label: 'Transport', value: inr(viewing.transport) },
            { label: 'Landed cost', value: inr(viewing.landed) },
            { label: 'Gross cost / unit', value: inr(viewing.grossCost) },
            { label: 'Usable cost / unit', value: inr(viewing.usableCost) },
          ],
        },
        {
          title: 'Notes',
          fields: [{ label: 'Receiving inspection', value: viewing.notes, wide: true }],
        },
      ]
    : []

  /** A packing-material receipt is a document too, with its own view, links and history. */
  const viewingPm = viewId
    ? state.ledger.find((l) => l.type === 'PM Receipt' && l.doc === viewId)
    : undefined
  const pmViewSections: DetailSection[] = viewingPm
    ? [
        {
          title: 'Receipt',
          fields: [
            { label: 'Receipt', value: viewingPm.doc },
            { label: 'Received on', value: fmtDate(viewingPm.time) },
            { label: 'Material', value: lookupItemName(state, viewingPm.item) },
            {
              label: 'Supplier',
              value: state.vendors.find((v) => v.id === viewingPm.vendorId)?.name || 'Not recorded',
            },
            { label: 'Supplier lot', value: viewingPm.lot },
            { label: 'Storage area', value: locationLabel(state, viewingPm.location) },
          ],
        },
        {
          title: 'Quantity and cost',
          fields: [
            { label: 'Quantity', value: `${fmtQty(viewingPm.qtyIn)} ${viewingPm.uom}` },
            { label: 'Rate / unit', value: inr(viewingPm.unitCost) },
            { label: 'Value', value: inr(viewingPm.qtyIn * viewingPm.unitCost) },
          ],
        },
      ]
    : []

  const chargeable = Math.max(0, num(form.total) - num(form.free))
  const previewLanded = chargeable * num(form.rate) + num(form.transport)
  const previewAccepted = num(form.a) + num(form.b) + num(form.c)
  // Every piece received has to land in a grade or in rejected. Posting enforces it;
  // without this the operator only found out after filling the whole form.
  const graded = previewAccepted + num(form.reject)
  const ungraded = num(form.total) - graded

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Goods received</h3>
          <span>
            Everything that arrives at the gate — produce from the farm, and the BiBs, bottles,
            caps and cartons the packing line runs on
          </span>
        </div>
        <div className="section-head-actions">
          <button
            className="btn btn-primary"
            onClick={tab === 'packing' ? openPmNew : openNew}
          >
            {tab === 'packing' ? '+ Receive Packing Material' : '+ New Receipt'}
          </button>
        </div>
      </div>

      <div className="type-tabs" role="tablist" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={`type-tab ${tab === 'produce' ? 'active' : ''}`}
          onClick={() => setTab('produce')}
        >
          Farm produce
        </button>
        <button
          type="button"
          className={`type-tab ${tab === 'packing' ? 'active' : ''}`}
          onClick={() => setTab('packing')}
        >
          Packing material
        </button>
      </div>
      {tab === 'produce' ? (
        <>
          <div className="toolbar">
            <input
              placeholder="Search GRN, lot, product, farmer or area"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option>Posted</option>
            </Select>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Receipt / Lot</th>
                  <th>Product</th>
                  <th>Received</th>
                  <th>Source</th>
                  <th className="cell-num cell-tight">Quantity</th>
                  <th>Grades</th>
                  <th className="cell-num cell-tight">Landed Cost</th>
                  <th className="cell-tight">Status</th>
                  <th className="cell-actions">Action</th>
                </tr>
              </thead>
              <tbody>
                {!rows.length ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      <EmptyState
                        filtered={!!search || !!status}
                        empty="No receipts yet."
                        onClear={() => {
                          setSearch('')
                          setStatus('')
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  rows.map((g) => (
                    <tr key={g.id}>
                      <td data-label="Receipt / Lot" className="cell-id">
                        <b>{g.id}</b>
                        <div className="cell-sub">{g.lot}</div>
                      </td>
                      <td data-label="Product">
                        {g.productName || itemName(g.itemId || COCONUT_ITEM)}
                        <div className="cell-sub">{g.uom || 'Piece'}</div>
                      </td>
                      <td data-label="Received">
                        {fmtDate(g.date)}
                        {g.harvestedOn && (
                          <div className="cell-sub">Harvested {fmtDate(g.harvestedOn)}</div>
                        )}
                    </td>
                    <td data-label="Source">
                      {g.farmerName || g.farmer || '—'}
                      {sourceNote(g) && <div className="cell-sub">{sourceNote(g)}</div>}
                    </td>
                    <td data-label="Quantity" className="cell-num cell-tight">
                      {g.accepted} accepted
                      <div className="cell-sub">
                        {g.total} received{g.free ? ` · ${g.free} free` : ''}
                      </div>
                    </td>
                    <td data-label="Grades">
                      A {g.a} · B {g.b} · C {g.c}
                      {!!g.reject && <div className="cell-sub">{g.reject} rejected</div>}
                    </td>
                    <td data-label="Landed Cost" className="cell-num cell-tight">
                      {inr(g.landed)}
                      <div className="cell-sub">
                        {inr(g.usableCost)} / usable {(g.uom || 'Piece').toLowerCase()}
                      </div>
                    </td>
                    <td data-label="Status" className="cell-tight">
                      <StatusBadge value={g.status} />
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        <button className="btn btn-light" onClick={() => setViewId(g.id)}>
                          View
                        </button>
                        <button className="btn btn-light" onClick={() => openEdit(g)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-light"
                          onClick={() => navigate(`/stickers?stage=raw&ref=${encodeURIComponent(g.lot)}`)}
                        >
                          Sticker
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => {
                            if (confirm(`Delete ${g.id}? This reverses the raw material ${g.lot} put into store.`)) {
                              deleteGrn(g.id)
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
        </>
      ) : (
        <>
          <div className="note">
            Packing material is received the same way produce is: pick what arrived, say who it
            came from, and it is booked into the packaging store at the rate you paid. A receipt
            can be corrected or removed right up until a packing run draws on it — after that a
            run has already costed itself at this rate, and only the supplier can still change.
          </div>

          <div className="toolbar">
            <input
              placeholder="Search receipt, material or lot"
              value={pmSearch}
              onChange={(e) => setPmSearch(e.target.value)}
            />
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Material</th>
                  <th>Lot</th>
                  <th>Supplier</th>
                  <th className="cell-num cell-tight">Quantity</th>
                  <th className="cell-num cell-tight">Rate</th>
                  <th className="cell-num cell-tight">Value</th>
                  <th>Storage area</th>
                  <th className="cell-actions">Action</th>
                </tr>
              </thead>
              <tbody>
                {!pmReceipts.length ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      <EmptyState
                        filtered={!!pmSearch}
                        empty="No packing material has been received yet."
                        onClear={() => setPmSearch('')}
                      />
                    </td>
                  </tr>
                ) : (
                  pmReceipts.map((l) => {
                    const drawn = pmConsumed(l.doc)
                    return (
                      <tr key={l.doc}>
                        <td data-label="Receipt" className="cell-id">
                          <b>{l.doc}</b>
                          <div className="cell-sub">{fmtDate(l.time)}</div>
                        </td>
                        <td data-label="Material">
                          {lookupItemName(state, l.item)}
                          <div className="cell-sub cell-id">{l.item}</div>
                        </td>
                        <td data-label="Lot">{l.lot}</td>
                        <td data-label="Supplier">
                          {state.vendors.find((v) => v.id === l.vendorId)?.name || 'Not recorded'}
                        </td>
                        <td data-label="Quantity" className="cell-num cell-tight">
                          {fmtQty(l.qtyIn)} {l.uom}
                        </td>
                        <td data-label="Rate" className="cell-num cell-tight">{inr(l.unitCost)}</td>
                        <td data-label="Value" className="cell-num cell-tight">
                          {inr(l.qtyIn * l.unitCost)}
                        </td>
                        <td data-label="Storage area">{locationLabel(state, l.location)}</td>
                        <td className="cell-actions">
                          <div className="row-actions">
                            <button className="btn btn-light" onClick={() => setViewId(l.doc)}>
                              View
                            </button>
                            <button className="btn btn-light" onClick={() => openPmEdit(l.doc)}>
                              Edit
                            </button>
                            <button
                              className="btn btn-light"
                              onClick={() =>
                                // The material stage keys a sticker by item·lot·location,
                                // not by lot alone, so the list is searched rather than
                                // pre-selected.
                                navigate(
                                  `/stickers?stage=material&q=${encodeURIComponent(l.lot)}`,
                                )
                              }
                            >
                              Sticker
                            </button>
                            <button
                              className="btn btn-danger"
                              disabled={drawn}
                              title={drawn ? 'Already drawn on by a packing run' : undefined}
                              onClick={() => {
                                if (confirm(`Delete ${l.doc}? This reverses the stock it added.`)) {
                                  deletePackingStock(l.doc)
                                }
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        open={pmOpen}
        title={pmEditDoc ? `Edit receipt · ${pmEditDoc}` : 'Receive packing material'}
        saveLabel={pmEditDoc ? 'Save Changes' : 'Post Receipt'}
        onClose={() => setPmOpen(false)}
        onSave={() => {
          const ok = pmEditDoc
            ? updatePackingStock(pmEditDoc, pmPayload())
            : addPackingStock(pmPayload())
          if (ok) setPmOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Receipt date/time</label>
            <input
              type="datetime-local"
              value={pmForm.date}
              onChange={(e) => setPmForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>
          <div className="field span-2">
            <label>Material received</label>
            <Select
              value={pmForm.purchaseProductId}
              onChange={(e) => {
                const next = e.target.value
                const product = packingProducts.find((p) => p.id === next)
                // A supplier that does not sell the new material would post a receipt
                // nobody can trace, so it is cleared rather than quietly carried over.
                setPmForm((f) => ({
                  ...f,
                  purchaseProductId: next,
                  vendorId:
                    product && product.vendorIds.length && !product.vendorIds.includes(f.vendorId)
                      ? ''
                      : f.vendorId,
                }))
              }}
            >
              <option value="">
                {packingProducts.length
                  ? 'Select packing material'
                  : 'No packing material yet — add one on the Products & Materials page'}
              </option>
              {packingProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.uom}
                </option>
              ))}
            </Select>
          </div>
          <div className="field span-2">
            <label>Supplier (optional)</label>
            <Select
              value={pmForm.vendorId}
              onChange={(e) => setPmForm((f) => ({ ...f, vendorId: e.target.value }))}
            >
              <option value="">Not recorded</option>
              {pmSuppliers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id} · {v.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Storage area</label>
            <Select
              value={pmForm.location}
              onChange={(e) => setPmForm((f) => ({ ...f, location: e.target.value }))}
            >
              <option value="">Select storage area</option>
              {areaChoices(state, 'Packing Material', 'Available', pmForm.location).map((c) => (
                <option key={c.area.id} value={c.value}>
                  {c.text}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Quantity{pmBuying ? ` (${pmBuying.uom})` : ''}</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={pmForm.qty}
              onChange={(e) =>
                setPmForm((f) => ({ ...f, qty: e.target.value === '' ? '' : Number(e.target.value) }))
              }
            />
          </div>
          <div className="field">
            <label>Rate / unit</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={pmForm.unitCost}
              onChange={(e) =>
                setPmForm((f) => ({
                  ...f,
                  unitCost: e.target.value === '' ? '' : Number(e.target.value),
                }))
              }
            />
          </div>
          <div className="field">
            <label>Supplier lot / batch ref</label>
            <input
              value={pmForm.lot}
              placeholder="e.g. PM5L-0803"
              onChange={(e) => setPmForm((f) => ({ ...f, lot: e.target.value }))}
            />
          </div>
        </div>
        {num(pmForm.qty) > 0 ? (
          <div className="note">
            Booking {fmtQty(num(pmForm.qty))} {pmBuying?.uom || 'units'} at{' '}
            <b>{inr(num(pmForm.unitCost))}</b> each — <b>{inr(num(pmForm.qty) * num(pmForm.unitCost))}</b>{' '}
            into {pmForm.location ? locationLabel(state, pmForm.location) : 'the storage area you pick'}. This is the
            rate every packing run that draws on this lot will cost itself at.
          </div>
        ) : null}
        <div className={`note${pmEditDoc && pmConsumed(pmEditDoc) ? ' warning-note' : ''}`}>
          {pmEditDoc && pmConsumed(pmEditDoc)
            ? 'A packing run has already drawn on this stock and costed itself at the rate below, so only the supplier can still be changed.'
            : 'Posting adds this material to packing stock straight away. You can edit or remove the receipt until a packing run draws on it.'}
        </div>
      </Modal>

      <DetailView
        open={!!viewing}
        title={viewing ? `${viewing.id} · ${viewing.lot}` : 'Receipt'}
        sections={viewSections}
        onClose={closeView}
        record={viewing?.id}
      />

      <DetailView
        open={!!viewingPm}
        title={
          viewingPm
            ? `${viewingPm.doc} · ${lookupItemName(state, viewingPm.item)}`
            : 'Packing material receipt'
        }
        sections={pmViewSections}
        onClose={closeView}
        record={viewingPm?.doc}
      />

      <Modal
        open={open}
        title={editing ? `Edit ${editing.id} · ${editing.lot}` : 'New goods receipt'}
        saveLabel={editing ? 'Save Changes' : 'Post Receipt'}
        onClose={() => setOpen(false)}
        onSave={() => {
          const ok = editing ? updateGrn(editing.id, payload()) : createGrn(payload())
          if (ok) setOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Receipt date/time</label>
            <input
              type="datetime-local"
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
            />
          </div>
          <div className="field">
            <label>Product received</label>
            <Select
              value={form.purchaseProductId}
              disabled={locked}
              onChange={(e) => {
                const next = e.target.value
                const product = produce.find((p) => p.id === next)
                // A source that does not supply the new product would post a receipt
                // nobody can trace, so it is cleared rather than quietly carried over.
                setForm((f) => ({
                  ...f,
                  purchaseProductId: next,
                  farmerId:
                    product && product.vendorIds.length && !product.vendorIds.includes(f.farmerId)
                      ? ''
                      : f.farmerId,
                }))
              }}
            >
              <option value="">
                {produce.length ? 'Select produce' : 'No produce yet — add one on the Products & Materials page'}
              </option>
              {produce.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.uom}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Storage area</label>
            <Select value={form.location} onChange={(e) => set('location', e.target.value)}>
              <option value="">Select storage area</option>
              {areaChoices(state, 'Raw Material', 'Available', form.location).map((c) => (
                <option key={c.area.id} value={c.value}>
                  {c.text}
                </option>
              ))}
            </Select>
          </div>
          <div className="field span-2">
            <label>Approved supplier (optional for a one-off farmer)</label>
            <Select value={form.farmerId} onChange={(e) => set('farmerId', e.target.value)}>
              <option value="">Direct farmer purchase — no vendor</option>
              {sourceOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id} · {f.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Farmer name{form.farmerId ? '' : ' (required)'}</label>
            <input
              value={form.farmer}
              onChange={(e) => set('farmer', e.target.value)}
              placeholder="Who grew / harvested this lot"
            />
          </div>
          <div className="field">
            <label>Area</label>
            <input
              value={form.area}
              onChange={(e) => set('area', e.target.value)}
              placeholder="Village / farm / block"
            />
          </div>
          <div className="field">
            <label>Harvested on</label>
            <input
              type="date"
              value={form.harvestedOn}
              onChange={(e) => set('harvestedOn', e.target.value)}
            />
          </div>
          {numberFields(buying?.uom || 'Piece').map(([key, label]) => (
            <div className="field" key={key}>
              <label>{label}</label>
              <input
                type="number"
                min="0"
                step={key === 'rate' || key === 'transport' || unit !== 'piece' ? '0.01' : '1'}
                placeholder="0"
                value={form[key]}
                disabled={locked}
                onChange={(e) => set(key, e.target.value === '' ? '' : Number(e.target.value))}
              />
            </div>
          ))}
        </div>

        {/* Both summaries sit with the numbers they are reading, not below the notes box —
            pushed under the textarea they fell past the bottom of the modal, so the grading
            and the cost only appeared to someone who scrolled for them. */}
        {num(form.total) > 0 && (
          <div className={`note${ungraded === 0 ? '' : ' warning-note'}`}>
            {ungraded === 0 ? (
              <>
                Graded all {num(form.total)} {unit} — A {num(form.a)} · B {num(form.b)} · C{' '}
                {num(form.c)} · rejected {num(form.reject)}.
              </>
            ) : (
              <>
                Grades A + B + C + rejected come to {graded} of {num(form.total)} {unit} —{' '}
                <b>
                  {ungraded > 0
                    ? `${ungraded} still to grade`
                    : `${-ungraded} more than were received`}
                </b>
                .
              </>
            )}
          </div>
        )}
        {num(form.total) > 0 && (
          <div className="note">
            Charging {chargeable} of {num(form.total)} {unit}
            {num(form.free) > 0 ? ` — ${num(form.free)} free` : ''} · landed{' '}
            <b>{inr(previewLanded)}</b> · {previewAccepted} accepted at{' '}
            <b>{inr(previewAccepted ? previewLanded / previewAccepted : 0)}</b>/usable{' '}
            {unit.replace(/s$/, '')}
          </div>
        )}

        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field span-3">
            <label>Notes / receiving inspection</label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Photos, challan details, inspection findings"
            />
          </div>
        </div>
        {locked ? (
          <div className="note warning-note">
            {editing?.lot} is already issued to production, so the product, quantities, rate and
            transport are frozen. Farmer, area, harvest date and notes can still be corrected.
          </div>
        ) : (
          <div className="note warning-note">
            {editing
              ? 'Saving re-prices this lot and updates its raw-material stock line. Free quantity counts towards received and accepted quantity but is never charged.'
              : 'Posting creates a unique lot and adds only accepted quantity to raw-material stock. Free quantity counts towards received and accepted quantity but is never charged. Buying once from a small farmer needs no vendor master — leave the vendor blank and the farmer name, area and harvest date carry the traceability.'}
          </div>
        )}
      </Modal>
    </div>
  )
}
