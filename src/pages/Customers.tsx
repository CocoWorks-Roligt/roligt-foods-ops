import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'

export function Customers() {
  const { state, addCustomer, setCustomerStatus, updateCustomer, deleteCustomer } = useApp()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    shipTo: '',
    gst: '',
    phone: '',
    email: '',
    contactPerson: '',
    notes: '',
  })

  const openEdit = (c: (typeof state.customers)[number]) => {
    setEditId(c.id)
    setForm({
      name: c.name,
      shipTo: c.shipTo,
      gst: c.gst,
      phone: c.phone || '',
      email: c.email || '',
      contactPerson: c.contactPerson || '',
      notes: c.notes || '',
    })
    setOpen(true)
  }

  const rows = useMemo(() => {
    const q = search.toLowerCase()
    return state.customers.filter((c) =>
      [c.id, c.name, c.shipTo, c.gst, c.phone, c.contactPerson].join(' ').toLowerCase().includes(q),
    )
  }, [search, state.customers])

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Customers</h3>
          <span>Ship-to accounts used in dispatch</span>
        </div>
        <div className="section-head-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditId(null)
              setForm({
                name: '',
                shipTo: '',
                gst: '',
                phone: '',
                email: '',
                contactPerson: '',
                notes: '',
              })
              setOpen(true)
            }}
          >
            + Add Customer
          </button>
        </div>
      </div>
      <div className="toolbar">
        <input
          placeholder="Search customer, GST, phone or address"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Contact</th>
              <th>Phone</th>
              <th>Ship-to</th>
              <th>GSTIN</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={8} className="empty">
                  <EmptyState
                    filtered={!!search}
                    empty="No customers yet."
                    onClear={() => setSearch('')}
                  />
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id}>
                  <td data-label="ID">
                    <b>{c.id}</b>
                  </td>
                  <td data-label="Name">
                    {c.name}
                    {c.notes ? <div className="small">{c.notes}</div> : null}
                  </td>
                  <td data-label="Contact">{c.contactPerson || '—'}</td>
                  <td data-label="Phone">{c.phone || '—'}</td>
                  <td data-label="Ship-to">{c.shipTo || '—'}</td>
                  <td data-label="GSTIN">{c.gst || '—'}</td>
                  <td data-label="Status">
                    <StatusBadge value={c.status} />
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <button className="btn btn-light" onClick={() => openEdit(c)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-light"
                        onClick={() =>
                          setCustomerStatus(c.id, c.status === 'Inactive' ? 'Active' : 'Inactive')
                        }
                      >
                        {c.status === 'Inactive' ? 'Reactivate' : 'Deactivate'}
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          if (confirm(`Delete ${c.name}? This cannot be undone.`)) deleteCustomer(c.id)
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

      <Modal
        open={open}
        title={editId ? 'Edit Customer' : 'Add Customer'}
        saveLabel="Save Customer"
        onClose={() => setOpen(false)}
        onSave={() => {
          const ok = editId ? updateCustomer(editId, form) : addCustomer(form)
          if (ok) setOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field span-2">
            <label>Customer name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Contact person</label>
            <input
              value={form.contactPerson}
              onChange={(e) => setForm((f) => ({ ...f, contactPerson: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Phone</label>
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>GSTIN</label>
            <input
              value={form.gst}
              onChange={(e) => setForm((f) => ({ ...f, gst: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Ship-to address</label>
            <textarea
              value={form.shipTo}
              onChange={(e) => setForm((f) => ({ ...f, shipTo: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
