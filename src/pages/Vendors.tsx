import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'

type TypeFilter = '' | 'VT-FARMER' | 'VT-VENDOR'

export function Vendors() {
  const { state, vendorTypeName, addVendor, setVendorStatus, updateVendor, deleteVendor } = useApp()
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [vendorOpen, setVendorOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [vendor, setVendor] = useState({
    name: '',
    vendorTypeId: 'VT-FARMER',
    phone: '',
    area: '',
    payment: 'Bank Transfer',
    email: '',
    notes: '',
  })

  const farmers = state.vendors.filter((v) => v.vendorTypeId === 'VT-FARMER')
  const materialVendors = state.vendors.filter((v) => v.vendorTypeId === 'VT-VENDOR')

  const rows = useMemo(() => {
    const q = search.toLowerCase()
    return state.vendors.filter(
      (v) =>
        (!typeFilter || v.vendorTypeId === typeFilter) &&
        [v.id, v.name, v.area, v.phone, vendorTypeName(v.vendorTypeId)]
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
  }, [search, state.vendors, typeFilter, vendorTypeName])

  const openAdd = (typeId: TypeFilter = 'VT-FARMER') => {
    setEditId(null)
    setVendor({
      name: '',
      vendorTypeId: typeId || 'VT-FARMER',
      phone: '',
      area: '',
      payment: 'Bank Transfer',
      email: '',
      notes: '',
    })
    setVendorOpen(true)
  }

  const openEdit = (v: (typeof state.vendors)[number]) => {
    setEditId(v.id)
    setVendor({
      name: v.name,
      vendorTypeId: v.vendorTypeId,
      phone: v.phone,
      area: v.area,
      payment: v.payment,
      email: v.email || '',
      notes: v.notes || '',
    })
    setVendorOpen(true)
  }

  return (
    <div className="vendors-page">
      <div className="grid grid-3 vendors-stats">
        <div className="card metric">
          <div className="label">Total</div>
          <div className="value">{state.vendors.length}</div>
          <div className="sub">All sources</div>
        </div>
        <div className="card metric">
          <div className="label">Farmers</div>
          <div className="value">{farmers.length}</div>
          <div className="sub">Produce suppliers</div>
        </div>
        <div className="card metric">
          <div className="label">Vendors</div>
          <div className="value">{materialVendors.length}</div>
          <div className="sub">Material suppliers</div>
        </div>
      </div>

      <div className="card vendors-panel">
        <div className="section-head">
          <div>
            <h3>Supplier directory</h3>
            <span>Only two types — Farmer or Vendor</span>
          </div>
          <div className="vendors-actions">
            <button className="btn btn-light" type="button" onClick={() => openAdd('VT-FARMER')}>
              + Farmer
            </button>
            <button className="btn btn-primary" type="button" onClick={() => openAdd('VT-VENDOR')}>
              + Vendor
            </button>
          </div>
        </div>

        <div className="vendors-toolbar">
          <div className="type-tabs" role="tablist" aria-label="Filter by type">
            {(
              [
                ['', 'All'],
                ['VT-FARMER', 'Farmers'],
                ['VT-VENDOR', 'Vendors'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id || 'all'}
                type="button"
                role="tab"
                aria-selected={typeFilter === id}
                className={`type-tab ${typeFilter === id ? 'active' : ''}`}
                onClick={() => setTypeFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="vendors-search"
            placeholder="Search by name, area or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {!rows.length ? (
          <div className="empty vendors-empty">
            <EmptyState
              filtered={!!search || !!typeFilter}
              empty="No suppliers yet. Add a farmer or vendor to get started."
              onClear={() => {
                setSearch('')
                setTypeFilter('')
              }}
            />
          </div>
        ) : (
          <div className="vendor-grid">
            {rows.map((v) => {
              const isFarmer = v.vendorTypeId === 'VT-FARMER'
              return (
                <article className={`vendor-card ${isFarmer ? 'is-farmer' : 'is-vendor'}`} key={v.id}>
                  <div className="vendor-card-top">
                    <div className={`vendor-avatar ${isFarmer ? 'farmer' : 'vendor'}`}>
                      {isFarmer ? 'F' : 'V'}
                    </div>
                    <div className="vendor-card-title">
                      <h4>{v.name}</h4>
                      <div className="small">{v.id}</div>
                    </div>
                    <span className={`type-chip ${isFarmer ? 'farmer' : 'vendor'}`}>
                      {vendorTypeName(v.vendorTypeId)}
                    </span>
                  </div>
                  <div className="vendor-meta">
                    <div>
                      <span className="meta-label">Area</span>
                      <b>{v.area || '—'}</b>
                    </div>
                    <div>
                      <span className="meta-label">Phone</span>
                      <b>{v.phone || '—'}</b>
                    </div>
                    <div>
                      <span className="meta-label">Payment</span>
                      <b>{v.payment}</b>
                    </div>
                    <div>
                      <span className="meta-label">Status</span>
                      <StatusBadge value={v.status} />
                    </div>
                  </div>
                  {v.notes ? <p className="vendor-notes">{v.notes}</p> : null}
                  <div className="vendor-card-actions">
                    <button className="btn btn-light" type="button" onClick={() => openEdit(v)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-light"
                      type="button"
                      onClick={() =>
                        setVendorStatus(v.id, v.status === 'Inactive' ? 'Active' : 'Inactive')
                      }
                    >
                      {v.status === 'Inactive' ? 'Reactivate' : 'Deactivate'}
                    </button>
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete ${v.name}? This cannot be undone.`)) deleteVendor(v.id)
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <Modal
        open={vendorOpen}
        title={`${editId ? 'Edit' : 'Add'} ${
          vendor.vendorTypeId === 'VT-FARMER' ? 'Farmer' : 'Vendor'
        }`}
        saveLabel="Save"
        onClose={() => setVendorOpen(false)}
        onSave={() => {
          const ok = editId ? updateVendor(editId, vendor) : addVendor(vendor)
          if (ok) setVendorOpen(false)
        }}
      >
        <div className="field span-3" style={{ marginBottom: 14 }}>
          <label>
            Source type
            {editId ? (
              <span className="small" style={{ fontWeight: 400 }}>
                {' '}
                — fixed once saved, because receipts already filed against this record
                depend on it
              </span>
            ) : null}
          </label>
          <div className="kind-picker" role="radiogroup" aria-label="Source type">
            <button
              type="button"
              disabled={!!editId}
              className={`kind-option ${vendor.vendorTypeId === 'VT-FARMER' ? 'active farmer' : ''}`}
              onClick={() => setVendor((v) => ({ ...v, vendorTypeId: 'VT-FARMER' }))}
            >
              <strong>Farmer</strong>
              <span>Produce supplier</span>
            </button>
            <button
              type="button"
              disabled={!!editId}
              className={`kind-option ${vendor.vendorTypeId === 'VT-VENDOR' ? 'active vendor' : ''}`}
              onClick={() => setVendor((v) => ({ ...v, vendorTypeId: 'VT-VENDOR' }))}
            >
              <strong>Vendor</strong>
              <span>Packing / material supplier</span>
            </button>
          </div>
        </div>
        <div className="form-grid">
          <div className="field span-2">
            <label>Name</label>
            <input
              value={vendor.name}
              placeholder={
                vendor.vendorTypeId === 'VT-FARMER'
                  ? 'e.g. Mandya Green Farms'
                  : 'e.g. PackRight Supplies'
              }
              onChange={(e) => setVendor((v) => ({ ...v, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Phone</label>
            <input
              value={vendor.phone}
              onChange={(e) => setVendor((v) => ({ ...v, phone: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              value={vendor.email}
              onChange={(e) => setVendor((v) => ({ ...v, email: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Area / district / state</label>
            <input
              value={vendor.area}
              onChange={(e) => setVendor((v) => ({ ...v, area: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Payment mode</label>
            <Select
              value={vendor.payment}
              onChange={(e) => setVendor((v) => ({ ...v, payment: e.target.value }))}
            >
              <option>Bank Transfer</option>
              <option>UPI</option>
              <option>Cash</option>
              <option>Credit</option>
            </Select>
          </div>
          <div className="field span-3">
            <label>Notes</label>
            <textarea
              value={vendor.notes}
              placeholder="Optional notes"
              onChange={(e) => setVendor((v) => ({ ...v, notes: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
