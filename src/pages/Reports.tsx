import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { useApp } from '../context/AppContext'
import { QC_CATEGORIES } from '../lib/qcCategories'
import { fmtDate, toLocalInputValue } from '../lib/utils'
import type { LabReport, LabReportResult, TestCategory } from '../types'

const today = () => toLocalInputValue().slice(0, 10)

function BatchLotField({
  value,
  onChange,
  batchIds,
}: {
  value: string
  onChange: (v: string) => void
  batchIds: string[]
}) {
  const [showList, setShowList] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const options = batchIds.filter((id) => id.toLowerCase().includes(value.toLowerCase()))

  const openList = () => {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width })
    setShowList(true)
  }

  return (
    <div className="autocomplete">
      <input
        ref={inputRef}
        value={value}
        placeholder="e.g. B.No: RF28042026 (Day 2 of the product)"
        onChange={(e) => {
          onChange(e.target.value)
          openList()
        }}
        onFocus={openList}
        onBlur={() => setTimeout(() => setShowList(false), 150)}
      />
      {showList && options.length && rect
        ? createPortal(
            <div
              className="autocomplete-list"
              style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
            >
              {options.map((id) => (
                <div
                  key={id}
                  className="autocomplete-option"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(id)
                    setShowList(false)
                  }}
                >
                  {id}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

export function Reports() {
  const { state, generateReport, updateReport, deleteReport, showToast } = useApp()
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [category, setCategory] = useState<TestCategory>('micro')
  const [form, setForm] = useState({
    issueDate: today(),
    customerName: state.config.reportCustomerName,
    customerAddress: state.config.reportCustomerAddress,
    labTechnician: state.config.defaultLabTechnician,
    sampleQtyAmount: 0,
    sampleQtyUnit: 'mL',
    sampleName: '',
    batchLotDetails: '',
    sampleDate: today(),
  })
  const [results, setResults] = useState<LabReportResult[]>([])

  const toggleCat = (key: string) => setOpenCats((o) => ({ ...o, [key]: !o[key] }))

  const editing = editId ? state.labReports.find((r) => r.id === editId) : undefined

  const openEdit = (report: LabReport) => {
    setEditId(report.id)
    setCategory(report.category)
    setForm({
      issueDate: report.issueDate,
      customerName: report.customerName,
      customerAddress: report.customerAddress,
      labTechnician: report.labTechnician,
      sampleQtyAmount: report.sampleQtyAmount,
      sampleQtyUnit: report.sampleQtyUnit,
      sampleName: report.sampleName,
      batchLotDetails: report.batchLotDetails,
      sampleDate: report.sampleDate,
    })
    // The saved results are the report — test parameters may have been edited since,
    // and reissuing this document must not silently change what was measured.
    setResults(report.results.map((r) => ({ ...r })))
    setOpen(true)
  }

  const openGenerate = (cat: TestCategory) => {
    const params = state.testParameters.filter((tp) => tp.category === cat)
    if (!params.length) {
      showToast('Add test parameters for this category first, on the Test Parameters page.')
      return
    }
    setEditId('')
    setCategory(cat)
    setForm({
      issueDate: today(),
      customerName: state.config.reportCustomerName,
      customerAddress: state.config.reportCustomerAddress,
      labTechnician: state.config.defaultLabTechnician,
      sampleQtyAmount: 0,
      sampleQtyUnit: 'mL',
      sampleName: '',
      batchLotDetails: '',
      sampleDate: today(),
    })
    setResults(params.map((p) => ({ name: p.name, method: p.method, unit: p.unit, result: '' })))
    setOpen(true)
  }

  const setResult = (idx: number, value: string) =>
    setResults((rs) => rs.map((r, i) => (i === idx ? { ...r, result: value } : r)))

  return (
    <div>
      <div className="note" style={{ marginBottom: 16 }}>
        Generate a formatted lab test report from your saved test parameters, then attach it
        directly to the matching category in Quality Control.
      </div>

      {QC_CATEGORIES.map((cat) => {
        const params = state.testParameters.filter((tp) => tp.category === cat.key)
        const reports = state.labReports
          .filter((r) => r.category === cat.key)
          .slice()
          .reverse()
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
                  <span className="small">
                    {params.length === 1 ? '1 test parameter' : `${params.length} test parameters`} ·{' '}
                    {reports.length === 1 ? '1 report' : `${reports.length} reports`}
                  </span>
                </div>
              </button>
              <div className="section-head-actions">
                {/* With no parameters there is nothing to put in the results table, so the
                    button used to open and immediately refuse. Say why up front instead. */}
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!params.length}
                  title={
                    params.length
                      ? undefined
                      : `Add ${cat.title} test parameters on the Test Parameters page first`
                  }
                  onClick={() => openGenerate(cat.key)}
                >
                  + Generate Report
                </button>
              </div>
            </div>
            {isOpen ? (
              <>
                <div
                  className={`note${params.length ? '' : ' warning-note'}`}
                  style={{ marginBottom: 14 }}
                >
                  <b>Tests included:</b>{' '}
                  {params.length
                    ? params.map((p) => p.name).join(', ')
                    : `None yet — add ${cat.title} parameters on the Test Parameters page before a report can be generated.`}
                </div>
                {!reports.length ? (
                  <div className="empty">No reports generated yet for {cat.title}.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Report No</th>
                          <th>Report issued to</th>
                          <th>Issue Date</th>
                          <th>Sample Name</th>
                          <th>Batch / Lot</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reports.map((r) => (
                          <tr key={r.id}>
                            <td data-label="Report No">
                              <b>{r.id}</b>
                            </td>
                            <td data-label="Report issued to">{r.customerName}</td>
                            <td data-label="Issue Date">{fmtDate(r.issueDate)}</td>
                            <td data-label="Sample Name">{r.sampleName}</td>
                            <td data-label="Batch / Lot">{r.batchLotDetails || '—'}</td>
                            <td className="cell-actions">
                              <div className="row-actions">
                                <Link className="btn btn-light" to={`/reports/${r.id}`}>
                                  View
                                </Link>
                                <button className="btn btn-light" onClick={() => openEdit(r)}>
                                  Edit
                                </button>
                                <button
                                  className="btn btn-danger"
                                  onClick={() => {
                                    if (confirm(`Delete ${r.id}? This cannot be undone.`)) {
                                      deleteReport(r.id)
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
                )}
              </>
            ) : null}
          </div>
        )
      })}

      <Modal
        open={open}
        title={
          editing
            ? `Edit ${editing.id} · ${QC_CATEGORIES.find((c) => c.key === category)?.title}`
            : `Generate Report · ${QC_CATEGORIES.find((c) => c.key === category)?.title}`
        }
        saveLabel={editing ? 'Save Changes' : 'Generate'}
        onClose={() => {
          setOpen(false)
          setEditId('')
        }}
        onSave={() => {
          const input = { category, ...form, results }
          const ok = editing ? updateReport(editing.id, input) : generateReport(input)
          if (ok) {
            setOpen(false)
            setEditId('')
          }
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Issue date</label>
            <input
              type="date"
              value={form.issueDate}
              onChange={(e) => setForm((f) => ({ ...f, issueDate: e.target.value }))}
            />
          </div>
          <div className="field span-2">
            <label>Report issued to</label>
            <input
              value={form.customerName}
              onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Issued-to address</label>
            <textarea
              value={form.customerAddress}
              onChange={(e) => setForm((f) => ({ ...f, customerAddress: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Lab technician</label>
            <input
              value={form.labTechnician}
              onChange={(e) => setForm((f) => ({ ...f, labTechnician: e.target.value }))}
            />
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Details provided by laboratory</span>
          </div>
          <div className="subform-body">
            <div className="form-grid">
              <div className="field">
                <label>Sample qty</label>
                <input
                  type="number"
                  min={0}
                  value={form.sampleQtyAmount || ''}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sampleQtyAmount: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="field">
                <label>Unit</label>
                <Select
                  value={form.sampleQtyUnit}
                  onChange={(e) => setForm((f) => ({ ...f, sampleQtyUnit: e.target.value }))}
                >
                  <option value="mL">mL</option>
                  <option value="L">L</option>
                </Select>
              </div>
            </div>
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Details you provide</span>
          </div>
          <div className="subform-body">
            <div className="form-grid">
              <div className="field span-2">
                <label>Sample name</label>
                <input
                  value={form.sampleName}
                  placeholder="e.g. Tender Coconut Water"
                  onChange={(e) => setForm((f) => ({ ...f, sampleName: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Sample date</label>
                <input
                  type="date"
                  value={form.sampleDate}
                  onChange={(e) => setForm((f) => ({ ...f, sampleDate: e.target.value }))}
                />
              </div>
              <div className="field span-3">
                <label>Batch / lot / other details</label>
                <BatchLotField
                  value={form.batchLotDetails}
                  onChange={(v) => setForm((f) => ({ ...f, batchLotDetails: v }))}
                  batchIds={state.batches.map((b) => b.id)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Test results</span>
          </div>
          <div className="subform-body">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Test Parameter</th>
                    <th>Test Method</th>
                    <th>Unit</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={r.name}>
                      <td data-label="Test Parameter">{r.name}</td>
                      <td data-label="Test Method">{r.method}</td>
                      <td data-label="Unit">{r.unit}</td>
                      <td data-label="Result">
                        <input
                          className="table-cell-input"
                          value={r.result}
                          onChange={(e) => setResult(i, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
