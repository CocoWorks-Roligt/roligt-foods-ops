import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BatchLotField } from '../components/BatchLotField'
import { DocLink } from '../components/DocLink'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { SensoryForm, type SensoryDraft } from '../components/SensoryForm'
import {
  SortHeader,
  SortSelect,
  sortRows,
  useTableSort,
  type SortAccessors,
} from '../components/tableSort'
import { StatusBadge } from '../components/StatusBadge'
import { useApp, type LabReportInput } from '../context/AppContext'
import { categoryParameters, isActiveCategory, testCategories } from '../lib/qcCategories'
import { blankScores, scoreSensory } from '../lib/sensory'
import { fmtDate, fmtQty, toLocalInputValue } from '../lib/utils'
import type { Config, LabReport, LabReportResult, TestCategoryDef } from '../types'

const today = () => toLocalInputValue().slice(0, 10)

const blankForm = (config: Config) => ({
  issueDate: today(),
  customerName: config.reportCustomerName,
  customerAddress: config.reportCustomerAddress,
  labTechnician: config.defaultLabTechnician,
  sampleQtyAmount: 0,
  sampleQtyUnit: 'mL',
  sampleName: '',
  batchLotDetails: '',
  sampleDate: today(),
})

const blankSensory = (config: Config): SensoryDraft => ({
  productGroup: '',
  sampleName: '',
  batchLotDetails: '',
  sampleDate: today(),
  labTechnician: config.defaultLabTechnician,
  servingTemp: '',
  storageCondition: '',
  comments: '',
  scores: [],
})

export function Reports() {
  const { state, generateReport, updateReport, deleteReport, showToast } = useApp()
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [category, setCategory] = useState('')
  const [form, setForm] = useState(() => blankForm(state.config))
  const [results, setResults] = useState<LabReportResult[]>([])
  const [sensory, setSensory] = useState<SensoryDraft>(() => blankSensory(state.config))

  const toggleCat = (key: string) => setOpenCats((o) => ({ ...o, [key]: !o[key] }))

  /** Active types, plus any inactive one that still has reports to read. */
  const categories = testCategories(state).filter(
    (c) => isActiveCategory(c) || state.labReports.some((r) => r.category === c.key),
  )
  const def = testCategories(state).find((c) => c.key === category)
  const scored = def?.format === 'scored'
  const editing = editId ? state.labReports.find((r) => r.id === editId) : undefined

  // One sort for every category's table — the columns mean the same thing in each,
  // and a key one table lacks (Score, in a certificate) is simply ignored there.
  const { sort, toggle, setSort } = useTableSort()
  const sortBy: SortAccessors<LabReport> = {
    id: (r) => r.id,
    date: (r) => (r.scores ? r.sampleDate : r.issueDate),
    product: (r) => r.sampleName,
    batch: (r) => r.batchId || r.batchLotDetails,
    evaluator: (r) => r.labTechnician,
    customer: (r) => r.customerName,
    score: (r) => (r.scores ? scoreSensory(r.scores, r).score : null),
    decision: (r) => (r.scores ? scoreSensory(r.scores, r).decision : null),
  }

  const openEdit = (report: LabReport, cat: TestCategoryDef) => {
    setEditId(report.id)
    setCategory(report.category)
    if (cat.format === 'scored') {
      setSensory({
        productGroup: report.productGroup || '',
        sampleName: report.sampleName,
        batchLotDetails: report.batchLotDetails,
        sampleDate: report.sampleDate,
        labTechnician: report.labTechnician,
        servingTemp: report.servingTemp || '',
        storageCondition: report.storageCondition || '',
        comments: report.comments || '',
        // What was scored is the report — attributes re-weighted since must not change it.
        scores: (report.scores || []).map((s) => ({ ...s })),
      })
    } else {
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
    }
    setOpen(true)
  }

  const openGenerate = (cat: TestCategoryDef) => {
    const params = categoryParameters(state, cat.key)
    if (!params.length) {
      showToast(`Add ${cat.format === 'scored' ? 'attributes' : 'test parameters'} for ${cat.title} on the Test Parameters page first.`)
      return
    }
    setEditId('')
    setCategory(cat.key)
    if (cat.format === 'scored') {
      setSensory({ ...blankSensory(state.config), scores: blankScores(params) })
    } else {
      setForm(blankForm(state.config))
      setResults(params.map((p) => ({ name: p.name, method: p.method, unit: p.unit, result: '' })))
    }
    setOpen(true)
  }

  const setResult = (idx: number, value: string) =>
    setResults((rs) => rs.map((r, i) => (i === idx ? { ...r, result: value } : r)))

  const close = () => {
    setOpen(false)
    setEditId('')
  }

  return (
    <div>
      <div className="note" style={{ marginBottom: 16 }}>
        Generate a formatted lab test report from your saved test parameters, or score a sensory
        evaluation for a batch, then attach it to the matching test in Quality Control. The report
        types and what each one tests are set by an admin on the Test Parameters page.
      </div>

      {categories.map((cat) => {
        const params = categoryParameters(state, cat.key)
        const reports = state.labReports
          .filter((r) => r.category === cat.key)
          .slice()
          .reverse()
        const isOpen = !!openCats[cat.key]
        const active = isActiveCategory(cat)
        const noun = cat.format === 'scored' ? 'attribute' : 'test parameter'
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
                  <h3>
                    {cat.title}
                    {active ? null : <span className="small"> · inactive</span>}
                  </h3>
                  <span className="small">
                    {params.length === 1 ? `1 ${noun}` : `${params.length} ${noun}s`} ·{' '}
                    {reports.length === 1 ? '1 report' : `${reports.length} reports`}
                  </span>
                </div>
              </button>
              <div className="section-head-actions">
                {/* With nothing to test there is nothing to put on the report, so the
                    button used to open and immediately refuse. Say why up front instead. */}
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!params.length || !active}
                  title={
                    !active
                      ? `${cat.title} is inactive — an admin can reactivate it on the Test Parameters page`
                      : params.length
                        ? undefined
                        : `Add ${cat.title} ${noun}s on the Test Parameters page first`
                  }
                  onClick={() => openGenerate(cat)}
                >
                  {cat.format === 'scored' ? '+ New Evaluation' : '+ Generate Report'}
                </button>
              </div>
            </div>
            {isOpen ? (
              <>
                <div
                  className={`note${params.length ? '' : ' warning-note'}`}
                  style={{ marginBottom: 14 }}
                >
                  <b>{cat.format === 'scored' ? 'Attributes scored:' : 'Tests included:'}</b>{' '}
                  {params.length
                    ? params.map((p) => p.name).join(', ')
                    : `None yet — add ${cat.title} ${noun}s on the Test Parameters page before a report can be made.`}
                </div>
                {!reports.length ? (
                  <div className="empty">No reports yet for {cat.title}.</div>
                ) : cat.format === 'scored' ? (
                  <>
                    <SortSelect
                      sort={sort}
                      onPick={setSort}
                      columns={[
                        { k: 'id', label: 'Report no', kind: 'text' },
                        { k: 'date', label: 'Date', kind: 'date' },
                        { k: 'product', label: 'Product' },
                        { k: 'batch', label: 'Batch / trial' },
                        { k: 'score', label: 'Score', kind: 'num' },
                        { k: 'decision', label: 'Decision' },
                      ]}
                    />
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <SortHeader label="Report No" k="id" first="desc" sort={sort} onToggle={toggle} />
                            <SortHeader label="Date" k="date" first="desc" sort={sort} onToggle={toggle} />
                            <SortHeader label="Product" k="product" sort={sort} onToggle={toggle} />
                            <SortHeader label="Batch / Trial" k="batch" sort={sort} onToggle={toggle} />
                            <SortHeader label="Evaluator" k="evaluator" sort={sort} onToggle={toggle} />
                            <SortHeader label="Score" k="score" first="desc" sort={sort} onToggle={toggle} />
                            <SortHeader label="Decision" k="decision" sort={sort} onToggle={toggle} />
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortRows(reports, sort, sortBy).map((r) => {
                          const summary = scoreSensory(r.scores || [], r)
                          return (
                            <tr key={r.id}>
                              <td data-label="Report No">
                                <b>{r.id}</b>
                              </td>
                              <td data-label="Date">{fmtDate(r.sampleDate)}</td>
                              <td data-label="Product">{r.sampleName}</td>
                              <td data-label="Batch / Trial">{r.batchId ? <DocLink doc={r.batchId} /> : r.batchLotDetails || '—'}</td>
                              <td data-label="Evaluator">{r.labTechnician || '—'}</td>
                              <td data-label="Score">
                                {summary.score == null ? '—' : `${fmtQty(summary.score)} / 100`}
                              </td>
                              <td data-label="Decision">
                                <StatusBadge value={summary.decision} />
                              </td>
                              <td className="cell-actions">
                                <ReportActions report={r} onEdit={() => openEdit(r, cat)} onDelete={deleteReport} />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  </>
                ) : (
                  <>
                    <SortSelect
                      sort={sort}
                      onPick={setSort}
                      columns={[
                        { k: 'id', label: 'Report no', kind: 'text' },
                        { k: 'customer', label: 'Issued to' },
                        { k: 'date', label: 'Issue date', kind: 'date' },
                        { k: 'product', label: 'Sample' },
                        { k: 'batch', label: 'Batch / lot' },
                      ]}
                    />
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <SortHeader label="Report No" k="id" first="desc" sort={sort} onToggle={toggle} />
                            <SortHeader label="Report issued to" k="customer" sort={sort} onToggle={toggle} />
                            <SortHeader label="Issue Date" k="date" first="desc" sort={sort} onToggle={toggle} />
                            <SortHeader label="Sample Name" k="product" sort={sort} onToggle={toggle} />
                            <SortHeader label="Batch / Lot" k="batch" sort={sort} onToggle={toggle} />
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortRows(reports, sort, sortBy).map((r) => (
                          <tr key={r.id}>
                            <td data-label="Report No">
                              <b>{r.id}</b>
                            </td>
                            <td data-label="Report issued to">{r.customerName}</td>
                            <td data-label="Issue Date">{fmtDate(r.issueDate)}</td>
                            <td data-label="Sample Name">{r.sampleName}</td>
                              <td data-label="Batch / Lot">{r.batchId ? <DocLink doc={r.batchId} /> : r.batchLotDetails || '—'}</td>
                            <td className="cell-actions">
                              <ReportActions report={r} onEdit={() => openEdit(r, cat)} onDelete={deleteReport} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  </>
                )}
              </>
            ) : null}
          </div>
        )
      })}

      <Modal
        open={open && !!def}
        title={
          editing
            ? `Edit ${editing.id} · ${def?.title}`
            : `${scored ? 'New Evaluation' : 'Generate Report'} · ${def?.title}`
        }
        saveLabel={editing ? 'Save Changes' : scored ? 'Save Evaluation' : 'Generate'}
        onClose={close}
        onSave={() => {
          const input: LabReportInput = scored
            ? {
                category,
                customerName: editing?.customerName || '',
                customerAddress: editing?.customerAddress || '',
                issueDate: sensory.sampleDate,
                labTechnician: sensory.labTechnician,
                sampleQtyAmount: 0,
                sampleQtyUnit: '',
                sampleName: sensory.sampleName,
                batchLotDetails: sensory.batchLotDetails,
                sampleDate: sensory.sampleDate,
                results: [],
                scores: sensory.scores,
                productGroup: sensory.productGroup,
                servingTemp: sensory.servingTemp,
                storageCondition: sensory.storageCondition,
                comments: sensory.comments,
              }
            : { category, ...form, results }
          const ok = editing ? updateReport(editing.id, input) : generateReport(input)
          if (ok) close()
        }}
      >
        {def && scored ? (
          <SensoryForm
            def={def}
            value={sensory}
            onChange={setSensory}
            thresholds={{
              passScore: editing?.passScore ?? def.passScore,
              minorScore: editing?.minorScore ?? def.minorScore,
            }}
          />
        ) : (
          <>
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
          </>
        )}
      </Modal>
    </div>
  )
}

function ReportActions({
  report,
  onEdit,
  onDelete,
}: {
  report: LabReport
  onEdit: () => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="row-actions">
      <Link className="btn btn-light" to={`/reports/${report.id}`}>
        View
      </Link>
      <button className="btn btn-light" onClick={onEdit}>
        Edit
      </button>
      <button
        className="btn btn-danger"
        onClick={() => {
          if (confirm(`Delete ${report.id}? This cannot be undone.`)) onDelete(report.id)
        }}
      >
        Delete
      </button>
    </div>
  )
}
