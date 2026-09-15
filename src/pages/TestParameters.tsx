import { useState } from 'react'
import { Modal } from '../components/Modal'
import { useApp } from '../context/AppContext'
import { QC_CATEGORIES } from '../lib/qcCategories'
import type { TestCategory, TestParameter } from '../types'

export function TestParameters() {
  const { state, addTestParameter, updateTestParameter, deleteTestParameter } = useApp()
  const [openCats, setOpenCats] = useState<Record<string, boolean>>(
    Object.fromEntries(QC_CATEGORIES.map((c) => [c.key, true])),
  )
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [category, setCategory] = useState<TestCategory>('micro')
  const [form, setForm] = useState({ name: '', method: '', unit: '' })

  const toggleCat = (key: string) => setOpenCats((o) => ({ ...o, [key]: !o[key] }))

  const openAdd = (cat: TestCategory) => {
    setEditId(null)
    setCategory(cat)
    setForm({ name: '', method: '', unit: '' })
    setOpen(true)
  }

  const openEdit = (tp: TestParameter) => {
    setEditId(tp.id)
    setCategory(tp.category)
    setForm({ name: tp.name, method: tp.method, unit: tp.unit })
    setOpen(true)
  }

  return (
    <div>
      <div className="note" style={{ marginBottom: 16 }}>
        Define the fixed test blueprint per category — <b>Test Parameter</b>, <b>Test Method</b> and{' '}
        <b>Unit of Measurement</b> rarely change. These populate the results table whenever a lab
        report is generated on the Lab Reports page.
      </div>

      {QC_CATEGORIES.map((cat) => {
        const rows = state.testParameters.filter((tp) => tp.category === cat.key)
        const isOpen = !!openCats[cat.key]
        return (
          <div className="card" style={{ marginBottom: 16 }} key={cat.key}>
            <div className="section-head">
              <button
                type="button"
                className="collapsible-toggle"
                onClick={() => toggleCat(cat.key)}
                aria-expanded={isOpen}
              >
                <span className={`metric-chevron ${isOpen ? 'open' : ''}`}>⌄</span>
                <div>
                  <h3>{cat.title}</h3>
                  <span className="small">{rows.length} test parameter(s)</span>
                </div>
              </button>
              <div className="section-head-actions">
                <button className="btn btn-primary" type="button" onClick={() => openAdd(cat.key)}>
                  + Add Test Parameter
                </button>
              </div>
            </div>
            {isOpen ? (
              !rows.length ? (
                <div className="empty">No test parameters yet for {cat.title}.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Test Parameter</th>
                        <th>Test Method</th>
                        <th>Unit of Measurement</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((tp) => (
                        <tr key={tp.id}>
                          <td data-label="Test Parameter">
                            <b>{tp.name}</b>
                          </td>
                          <td data-label="Test Method">{tp.method}</td>
                          <td data-label="Unit">{tp.unit}</td>
                          <td className="cell-actions">
                            <div className="row-actions">
                              <button className="btn btn-light" onClick={() => openEdit(tp)}>
                                Edit
                              </button>
                              <button
                                className="btn btn-danger"
                                onClick={() => {
                                  if (confirm(`Delete ${tp.name}? This cannot be undone.`)) {
                                    deleteTestParameter(tp.id)
                                  }
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </div>
        )
      })}

      <Modal
        open={open}
        title={
          editId
            ? 'Edit Test Parameter'
            : `Add Test Parameter · ${QC_CATEGORIES.find((c) => c.key === category)?.title}`
        }
        saveLabel="Save"
        onClose={() => setOpen(false)}
        onSave={() => {
          const ok = editId ? updateTestParameter(editId, form) : addTestParameter({ category, ...form })
          if (ok) setOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field span-3">
            <label>Test Parameter</label>
            <input
              value={form.name}
              placeholder="e.g. Aerobic Plate count"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field span-2">
            <label>Test Method</label>
            <input
              value={form.method}
              placeholder="e.g. IS 5402-1:2021"
              onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Unit of Measurement</label>
            <input
              value={form.unit}
              placeholder="e.g. Cfu/mL"
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
