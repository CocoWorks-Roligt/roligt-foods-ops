import { useState } from 'react'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { useApp, type TestCategoryInput } from '../context/AppContext'
import { categoryParameters, isActiveCategory, isLegacyTest, testCategories } from '../lib/qcCategories'
import {
  CRITICAL_BELOW,
  DEFAULT_MINOR_SCORE,
  DEFAULT_PASS_SCORE,
  SCORING_GUIDE,
  SENSORY_KEY,
} from '../lib/sensory'
import { fmtQty } from '../lib/utils'
import type { ReportFormat, SensoryProductGroup, TestCategoryDef, TestParameter } from '../types'

interface ParamForm {
  name: string
  method: string
  unit: string
  section: string
  weight: number | ''
  critical: boolean
}

const blankParam: ParamForm = { name: '', method: '', unit: '', section: '', weight: '', critical: false }

interface TypeForm {
  title: string
  format: ReportFormat
  requiredForRelease: boolean
  hint: string
  signatory: string
  passScore: number | ''
  minorScore: number | ''
}

const blankType: TypeForm = {
  title: '',
  format: 'results',
  requiredForRelease: true,
  hint: '',
  signatory: 'Authorised Signatory',
  passScore: DEFAULT_PASS_SCORE,
  minorScore: DEFAULT_MINOR_SCORE,
}

const blankCheck: SensoryProductGroup = { name: '', checkpoints: '', defects: '', focus: '' }

/** A report type as the save action takes it, so changing one part of it keeps the rest. */
const asInput = (def: TestCategoryDef): TestCategoryInput => ({
  title: def.title,
  format: def.format,
  requiredForRelease: def.requiredForRelease,
  hint: def.hint,
  signatory: def.signatory,
  passScore: def.passScore,
  minorScore: def.minorScore,
  productGroups: def.productGroups,
})

export function TestParameters() {
  const {
    state,
    showToast,
    saveTestCategory,
    setTestCategoryStatus,
    deleteTestCategory,
    addTestParameter,
    updateTestParameter,
    deleteTestParameter,
  } = useApp()
  const categories = testCategories(state)
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  const [paramOpen, setParamOpen] = useState(false)
  const [paramId, setParamId] = useState<string | null>(null)
  const [paramCat, setParamCat] = useState('')
  const [paramForm, setParamForm] = useState<ParamForm>(blankParam)

  const [typeOpen, setTypeOpen] = useState(false)
  const [typeKey, setTypeKey] = useState<string | null>(null)
  const [typeForm, setTypeForm] = useState<TypeForm>(blankType)

  const [checkOpen, setCheckOpen] = useState(false)
  const [checkCat, setCheckCat] = useState('')
  const [checkIdx, setCheckIdx] = useState<number | null>(null)
  const [checkForm, setCheckForm] = useState<SensoryProductGroup>(blankCheck)

  const paramDef = categories.find((c) => c.key === paramCat)
  const paramScored = paramDef?.format === 'scored'
  const sections = [
    ...new Set(categoryParameters(state, paramCat).map((p) => p.section || '').filter(Boolean)),
  ]

  const openAddParam = (cat: TestCategoryDef) => {
    const rows = categoryParameters(state, cat.key)
    setParamId(null)
    setParamCat(cat.key)
    // A new attribute most often belongs under the last section somebody was filling in.
    setParamForm({ ...blankParam, section: rows[rows.length - 1]?.section || '' })
    setParamOpen(true)
  }

  const openEditParam = (tp: TestParameter) => {
    setParamId(tp.id)
    setParamCat(tp.category)
    setParamForm({
      name: tp.name,
      method: tp.method,
      unit: tp.unit,
      section: tp.section || '',
      weight: tp.weight ?? '',
      critical: !!tp.critical,
    })
    setParamOpen(true)
  }

  const openAddType = () => {
    setTypeKey(null)
    setTypeForm(blankType)
    setTypeOpen(true)
  }

  const openEditType = (def: TestCategoryDef) => {
    setTypeKey(def.key)
    setTypeForm({
      title: def.title,
      format: def.format,
      requiredForRelease: def.requiredForRelease,
      hint: def.hint || '',
      signatory: def.signatory || '',
      passScore: def.passScore ?? DEFAULT_PASS_SCORE,
      minorScore: def.minorScore ?? DEFAULT_MINOR_SCORE,
    })
    setTypeOpen(true)
  }

  /** Parameters and reports are written in their type's format, so it is fixed once used. */
  const formatLocked =
    !!typeKey &&
    (isLegacyTest(typeKey) ||
      typeKey === SENSORY_KEY ||
      state.testParameters.some((tp) => tp.category === typeKey) ||
      state.labReports.some((r) => r.category === typeKey))

  const openCheck = (def: TestCategoryDef, idx: number | null) => {
    setCheckCat(def.key)
    setCheckIdx(idx)
    setCheckForm(idx == null ? blankCheck : { ...(def.productGroups || [])[idx] })
    setCheckOpen(true)
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div>
            <h3>Report types</h3>
            <span>The tests a product is judged on, and what each one tests</span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" type="button" onClick={openAddType}>
              + Add Report Type
            </button>
          </div>
        </div>
        <div className="note">
          A <b>results table</b> type is a lab certificate — parameter, method and unit, with the
          result written in on each report. A <b>scored evaluation</b> scores weighted attributes 1–5
          and reaches a decision from the total, like the sensory evaluation. A type marked{' '}
          <b>needed to release</b> has to read Pass on a product&apos;s QC record before the product can
          be released. A product already released keeps the tests it was released on, and an inactive
          type takes no new reports and holds nothing back.
        </div>
      </div>

      {categories.map((cat) => {
        const rows = categoryParameters(state, cat.key)
        const isOpen = !closed[cat.key]
        const scored = cat.format === 'scored'
        const active = isActiveCategory(cat)
        const totalWeight = rows.reduce((a, r) => a + (Number(r.weight) || 0), 0)
        const noun = scored ? 'attribute' : 'test parameter'
        return (
          <div className="card" style={{ marginBottom: 16 }} key={cat.key}>
            <div className="section-head">
              <button
                type="button"
                className="collapsible-toggle"
                onClick={() => setClosed((c) => ({ ...c, [cat.key]: isOpen }))}
                aria-expanded={isOpen}
              >
                <span className={`metric-chevron ${isOpen ? 'open' : ''}`}>⌄</span>
                <div>
                  <h3>{cat.title}</h3>
                  <span className="small">
                    {scored ? 'Scored evaluation' : 'Results table'} · {rows.length} {noun}
                    {rows.length === 1 ? '' : 's'} ·{' '}
                    {cat.requiredForRelease ? 'needed to release a product' : 'not needed to release'}
                    {active ? '' : ' · inactive'}
                  </span>
                </div>
              </button>
              <div className="section-head-actions">
                <button className="btn btn-light" type="button" onClick={() => openEditType(cat)}>
                  Edit Type
                </button>
                <button
                  className="btn btn-light"
                  type="button"
                  onClick={() => setTestCategoryStatus(cat.key, active ? 'Inactive' : 'Active')}
                >
                  {active ? 'Deactivate' : 'Reactivate'}
                </button>
                {isLegacyTest(cat.key) ? null : (
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete the ${cat.title} report type and its ${noun}s? This cannot be undone.`)) {
                        deleteTestCategory(cat.key)
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
                <button className="btn btn-primary" type="button" onClick={() => openAddParam(cat)}>
                  {scored ? '+ Add Attribute' : '+ Add Test Parameter'}
                </button>
              </div>
            </div>
            {!isOpen ? null : scored ? (
              <>
                {!rows.length ? (
                  <div className="empty">No attributes yet for {cat.title}.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Section</th>
                          <th>Attribute</th>
                          <th>Weight %</th>
                          <th>Critical</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((tp) => (
                          <tr key={tp.id}>
                            <td data-label="Section">{tp.section}</td>
                            <td data-label="Attribute">
                              <b>{tp.name}</b>
                            </td>
                            <td data-label="Weight %">{fmtQty(tp.weight || 0)}</td>
                            <td data-label="Critical">{tp.critical ? 'Yes' : 'No'}</td>
                            <td className="cell-actions">
                              <ParamActions
                                onEdit={() => openEditParam(tp)}
                                onDelete={() => {
                                  if (confirm(`Delete ${tp.name}? This cannot be undone.`)) deleteTestParameter(tp.id)
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div
                  className={`note${Math.abs(totalWeight - 100) > 0.001 ? ' warning-note' : ''}`}
                  style={{ marginTop: 12 }}
                >
                  Weights total <b>{fmtQty(totalWeight)}%</b>
                  {Math.abs(totalWeight - 100) > 0.001
                    ? ' — keep them at 100, so each weight reads as its share of the score.'
                    : '.'}{' '}
                  A product passes at <b>{cat.passScore ?? DEFAULT_PASS_SCORE}</b>/100 and passes with
                  minor modification from <b>{cat.minorScore ?? DEFAULT_MINOR_SCORE}</b>; below that it
                  goes to R&amp;D review. A critical attribute scored below {CRITICAL_BELOW} holds the
                  product whatever the total.
                </div>

                <div className="section-head" style={{ marginTop: 18 }}>
                  <div>
                    <h4 style={{ margin: 0 }}>Product-specific checks</h4>
                    <span className="small">Shown on an evaluation for the product category it picks</span>
                  </div>
                  <div className="section-head-actions">
                    <button className="btn btn-light" type="button" onClick={() => openCheck(cat, null)}>
                      + Add Product Check
                    </button>
                  </div>
                </div>
                {!(cat.productGroups || []).length ? (
                  <div className="empty">No product checks yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Critical checkpoints</th>
                          <th>Defects to watch</th>
                          <th>R&amp;D focus</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(cat.productGroups || []).map((g, i) => (
                          <tr key={g.name}>
                            <td data-label="Product">
                              <b>{g.name}</b>
                            </td>
                            <td data-label="Critical checkpoints">{g.checkpoints}</td>
                            <td data-label="Defects to watch">{g.defects}</td>
                            <td data-label="R&D focus">{g.focus}</td>
                            <td className="cell-actions">
                              <ParamActions
                                onEdit={() => openCheck(cat, i)}
                                onDelete={() => {
                                  if (confirm(`Delete the ${g.name} checks?`)) {
                                    saveTestCategory(
                                      {
                                        ...asInput(cat),
                                        productGroups: (cat.productGroups || []).filter((_, x) => x !== i),
                                      },
                                      cat.key,
                                    )
                                  }
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <details className="sensory-guide" style={{ marginTop: 14 }}>
                  <summary>Scoring guide</summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Score</th>
                          <th>Meaning</th>
                          <th>QA / QC reading</th>
                        </tr>
                      </thead>
                      <tbody>
                        {SCORING_GUIDE.map((g) => (
                          <tr key={g.score}>
                            <td data-label="Score">
                              <b>{g.score}</b>
                            </td>
                            <td data-label="Meaning">{g.meaning}</td>
                            <td data-label="QA / QC reading">{g.reading}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : !rows.length ? (
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
                          <ParamActions
                            onEdit={() => openEditParam(tp)}
                            onDelete={() => {
                              if (confirm(`Delete ${tp.name}? This cannot be undone.`)) deleteTestParameter(tp.id)
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      <Modal
        open={paramOpen}
        title={
          paramId
            ? paramScored
              ? 'Edit Attribute'
              : 'Edit Test Parameter'
            : `${paramScored ? 'Add Attribute' : 'Add Test Parameter'} · ${paramDef?.title || ''}`
        }
        saveLabel="Save"
        onClose={() => setParamOpen(false)}
        onSave={() => {
          const patch = {
            name: paramForm.name,
            method: paramForm.method,
            unit: paramForm.unit,
            section: paramForm.section,
            weight: Number(paramForm.weight) || 0,
            critical: paramForm.critical,
          }
          const ok = paramId
            ? updateTestParameter(paramId, patch)
            : addTestParameter({ category: paramCat, ...patch })
          if (ok) setParamOpen(false)
        }}
      >
        {paramScored ? (
          <div className="form-grid">
            <div className="field">
              <label>Section</label>
              <input
                list="sensory-sections"
                value={paramForm.section}
                placeholder="e.g. Aroma"
                onChange={(e) => setParamForm((f) => ({ ...f, section: e.target.value }))}
              />
              <datalist id="sensory-sections">
                {sections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="field span-2">
              <label>Attribute</label>
              <input
                value={paramForm.name}
                placeholder="e.g. Coconut aroma"
                onChange={(e) => setParamForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Weight %</label>
              <input
                type="number"
                min={0}
                step="any"
                value={paramForm.weight}
                onChange={(e) =>
                  setParamForm((f) => ({ ...f, weight: e.target.value === '' ? '' : Number(e.target.value) }))
                }
              />
            </div>
            <div className="field">
              <label>Critical?</label>
              <Select
                value={paramForm.critical ? 'Yes' : 'No'}
                onChange={(e) => setParamForm((f) => ({ ...f, critical: e.target.value === 'Yes' }))}
              >
                <option value="Yes">Yes — a score below {CRITICAL_BELOW} holds the product</option>
                <option value="No">No</option>
              </Select>
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <div className="field span-3">
              <label>Test Parameter</label>
              <input
                value={paramForm.name}
                placeholder="e.g. Aerobic Plate count"
                onChange={(e) => setParamForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="field span-2">
              <label>Test Method</label>
              <input
                value={paramForm.method}
                placeholder="e.g. IS 5402-1:2021"
                onChange={(e) => setParamForm((f) => ({ ...f, method: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Unit of Measurement</label>
              <input
                value={paramForm.unit}
                placeholder="e.g. Cfu/mL"
                onChange={(e) => setParamForm((f) => ({ ...f, unit: e.target.value }))}
              />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={typeOpen}
        title={typeKey ? `Edit Report Type · ${typeForm.title}` : 'Add Report Type'}
        saveLabel="Save"
        onClose={() => setTypeOpen(false)}
        onSave={() => {
          const existing = typeKey ? categories.find((c) => c.key === typeKey) : undefined
          const ok = saveTestCategory(
            {
              title: typeForm.title,
              format: typeForm.format,
              requiredForRelease: typeForm.requiredForRelease,
              hint: typeForm.hint,
              signatory: typeForm.signatory,
              passScore: Number(typeForm.passScore),
              minorScore: Number(typeForm.minorScore),
              productGroups: existing?.productGroups ?? [],
            },
            typeKey || undefined,
          )
          if (ok) setTypeOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field span-2">
            <label>Name</label>
            <input
              value={typeForm.title}
              placeholder="e.g. Shelf-life Study"
              onChange={(e) => setTypeForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Format</label>
            <Select
              value={typeForm.format}
              disabled={formatLocked}
              onChange={(e) => setTypeForm((f) => ({ ...f, format: e.target.value as ReportFormat }))}
            >
              <option value="results">Results table</option>
              <option value="scored">Scored evaluation</option>
            </Select>
          </div>
          <div className="field">
            <label>Needed to release a product?</label>
            <Select
              value={typeForm.requiredForRelease ? 'Yes' : 'No'}
              onChange={(e) => setTypeForm((f) => ({ ...f, requiredForRelease: e.target.value === 'Yes' }))}
            >
              <option value="Yes">Yes — it has to Pass</option>
              <option value="No">No — recorded, not required</option>
            </Select>
          </div>
          <div className="field span-2">
            <label>QC note hint</label>
            <input
              value={typeForm.hint}
              placeholder="What to write in the QC note, e.g. lab and report number"
              onChange={(e) => setTypeForm((f) => ({ ...f, hint: e.target.value }))}
            />
          </div>
          {typeForm.format === 'scored' ? (
            <>
              <div className="field">
                <label>Pass score (/100)</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={typeForm.passScore}
                  onChange={(e) =>
                    setTypeForm((f) => ({ ...f, passScore: e.target.value === '' ? '' : Number(e.target.value) }))
                  }
                />
              </div>
              <div className="field">
                <label>Pass with minor modification from</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={typeForm.minorScore}
                  onChange={(e) =>
                    setTypeForm((f) => ({ ...f, minorScore: e.target.value === '' ? '' : Number(e.target.value) }))
                  }
                />
              </div>
            </>
          ) : (
            <div className="field span-3">
              <label>Signature line on the report</label>
              <input
                value={typeForm.signatory}
                placeholder="e.g. Authorised Signatory - Biology"
                onChange={(e) => setTypeForm((f) => ({ ...f, signatory: e.target.value }))}
              />
            </div>
          )}
        </div>
        {formatLocked ? (
          <div className="note">
            The format is fixed — this type already has parameters or reports written in it. Add a new
            report type for a different format.
          </div>
        ) : null}
      </Modal>

      <Modal
        open={checkOpen}
        title={checkIdx == null ? 'Add Product Check' : `Edit Product Check · ${checkForm.name}`}
        saveLabel="Save"
        onClose={() => setCheckOpen(false)}
        onSave={() => {
          const def = categories.find((c) => c.key === checkCat)
          if (!def) return
          if (!checkForm.name.trim()) {
            showToast('Name the product category these checks are for.')
            return
          }
          const groups = [...(def.productGroups || [])]
          if (checkIdx == null) groups.push(checkForm)
          else groups[checkIdx] = checkForm
          if (saveTestCategory({ ...asInput(def), productGroups: groups }, def.key)) setCheckOpen(false)
        }}
      >
        <div className="form-grid">
          <div className="field span-3">
            <label>Product category</label>
            <input
              value={checkForm.name}
              placeholder="e.g. Coconut Water"
              onChange={(e) => setCheckForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Critical checkpoints</label>
            <textarea
              value={checkForm.checkpoints}
              onChange={(e) => setCheckForm((f) => ({ ...f, checkpoints: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>Defects to watch</label>
            <textarea
              value={checkForm.defects}
              onChange={(e) => setCheckForm((f) => ({ ...f, defects: e.target.value }))}
            />
          </div>
          <div className="field span-3">
            <label>R&amp;D focus</label>
            <textarea
              value={checkForm.focus}
              onChange={(e) => setCheckForm((f) => ({ ...f, focus: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

function ParamActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="row-actions">
      <button className="btn btn-light" type="button" onClick={onEdit}>
        Edit
      </button>
      <button className="btn btn-danger" type="button" onClick={onDelete}>
        Delete
      </button>
    </div>
  )
}
