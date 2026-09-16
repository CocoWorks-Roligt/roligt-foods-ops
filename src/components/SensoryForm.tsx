import { useApp } from '../context/AppContext'
import { mainOutput } from '../lib/batches'
import {
  CRITICAL_BELOW,
  DEFAULT_MINOR_SCORE,
  DEFAULT_PASS_SCORE,
  SCORING_GUIDE,
  STORAGE_CONDITIONS,
  scoreSensory,
  weightedScore,
} from '../lib/sensory'
import { itemName } from '../lib/stock'
import { fmtQty } from '../lib/utils'
import type { SensoryScore, TestCategoryDef } from '../types'
import { BatchLotField } from './BatchLotField'
import { Select } from './Select'
import { StatusBadge } from './StatusBadge'

/** Everything a sensory evaluation form holds before it is saved as a report. */
export interface SensoryDraft {
  productGroup: string
  /** Product / variant. */
  sampleName: string
  /** Batch / trial no. */
  batchLotDetails: string
  sampleDate: string
  /** Evaluator. */
  labTechnician: string
  servingTemp: string
  storageCondition: string
  comments: string
  scores: SensoryScore[]
}

/**
 * The sensory evaluation sheet, filled in on screen. Details once per evaluation, a
 * score and notes per attribute, and the summary working itself out as the scores go in
 * — the same three bands of fields as the plant's spreadsheet.
 */
export function SensoryForm({
  def,
  value,
  thresholds,
  onChange,
}: {
  def: TestCategoryDef
  value: SensoryDraft
  thresholds: { passScore?: number; minorScore?: number }
  onChange: (fn: (d: SensoryDraft) => SensoryDraft) => void
}) {
  const { state } = useApp()
  const set = (patch: Partial<SensoryDraft>) => onChange((d) => ({ ...d, ...patch }))
  const setScore = (idx: number, patch: Partial<SensoryScore>) =>
    onChange((d) => ({ ...d, scores: d.scores.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }))

  const summary = scoreSensory(value.scores, thresholds)
  const pass = thresholds.passScore ?? DEFAULT_PASS_SCORE
  const minor = thresholds.minorScore ?? DEFAULT_MINOR_SCORE
  const totalWeight = value.scores.reduce((a, s) => a + (Number(s.weight) || 0), 0)
  const groups = def.productGroups || []
  const groupNames = [
    ...new Set([...groups.map((g) => g.name), 'Other', ...(value.productGroup ? [value.productGroup] : [])]),
  ]
  const checks = groups.find((g) => g.name === value.productGroup)

  return (
    <div className="sensory-form">
      <div className="form-grid">
        <div className="field">
          <label>Product category</label>
          <Select value={value.productGroup} onChange={(e) => set({ productGroup: e.target.value })}>
            <option value="">Select category</option>
            {groupNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div className="field span-2">
          <label>Product / variant</label>
          <input
            value={value.sampleName}
            placeholder="e.g. Tender Coconut Water"
            onChange={(e) => set({ sampleName: e.target.value })}
          />
        </div>
        <div className="field span-2">
          <label>Batch / trial no.</label>
          <BatchLotField
            value={value.batchLotDetails}
            placeholder="Pick a batch, or type a trial number"
            batchIds={state.batches.map((b) => b.id).reverse()}
            onChange={(v) => {
              // Picking a batch names what it made, unless somebody already typed a product.
              const batch = state.batches.find((b) => b.id === v.trim())
              const main = batch ? mainOutput(batch) : undefined
              set({
                batchLotDetails: v,
                ...(main && !value.sampleName.trim() ? { sampleName: itemName(state, main.item) } : {}),
              })
            }}
          />
        </div>
        <div className="field">
          <label>Date</label>
          <input type="date" value={value.sampleDate} onChange={(e) => set({ sampleDate: e.target.value })} />
        </div>
        <div className="field span-2">
          <label>Evaluator</label>
          <input value={value.labTechnician} onChange={(e) => set({ labTechnician: e.target.value })} />
        </div>
        <div className="field">
          <label>Serving temperature (°C)</label>
          <input
            inputMode="decimal"
            value={value.servingTemp}
            placeholder="e.g. 4"
            onChange={(e) => set({ servingTemp: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Storage condition</label>
          <Select value={value.storageCondition} onChange={(e) => set({ storageCondition: e.target.value })}>
            <option value="">Select condition</option>
            {STORAGE_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {checks ? (
        <div className="note">
          <b>{checks.name} — what to check.</b> {checks.checkpoints ? <>Critical checkpoints: {checks.checkpoints}. </> : null}
          {checks.defects ? <>Defects to watch: {checks.defects}. </> : null}
          {checks.focus ? <>R&amp;D focus: {checks.focus}.</> : null}
        </div>
      ) : null}

      <div className="subform">
        <div className="subform-head">
          <span>Attributes</span>
          <span className="small" style={{ fontWeight: 400 }}>
            Score each 1–5 · tap a score again to clear it
          </span>
        </div>
        <div className="subform-body">
          <div className="table-wrap">
            <table className="sensory-table">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Attribute</th>
                  <th>Weight %</th>
                  <th>Score (1–5)</th>
                  <th>Weighted</th>
                  <th>Critical?</th>
                  <th>Observation / defect</th>
                  <th>Action required</th>
                </tr>
              </thead>
              <tbody>
                {value.scores.map((s, i) => {
                  const weighted = weightedScore(s)
                  return (
                    <tr key={`${s.section}-${s.name}`}>
                      <td data-label="Section">
                        {i === 0 || value.scores[i - 1].section !== s.section ? <b>{s.section}</b> : null}
                      </td>
                      <td data-label="Attribute">{s.name}</td>
                      <td data-label="Weight %">{fmtQty(s.weight)}</td>
                      <td data-label="Score">
                        <div className="score-picker" role="group" aria-label={`Score for ${s.name}`}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={`score-btn${s.score === n ? ' active' : ''}${
                                s.critical && n < CRITICAL_BELOW ? ' low' : ''
                              }`}
                              aria-pressed={s.score === n}
                              onClick={() => setScore(i, { score: s.score === n ? null : n })}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td data-label="Weighted">{weighted == null ? '—' : fmtQty(weighted)}</td>
                      <td data-label="Critical?">{s.critical ? <b>Yes</b> : 'No'}</td>
                      <td data-label="Observation / defect">
                        <input
                          className="table-cell-input"
                          value={s.observation}
                          onChange={(e) => setScore(i, { observation: e.target.value })}
                        />
                      </td>
                      <td data-label="Action required">
                        <input
                          className="table-cell-input"
                          value={s.action}
                          onChange={(e) => setScore(i, { action: e.target.value })}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="sensory-summary">
        <div>
          <span className="meta-label">Weighted score</span>
          <b>{summary.score == null ? '—' : fmtQty(summary.score)} / 100</b>
        </div>
        <div>
          <span className="meta-label">Average raw score</span>
          <b>{summary.average == null ? '—' : fmtQty(summary.average)} / 5</b>
        </div>
        <div>
          <span className="meta-label">Critical below {CRITICAL_BELOW}</span>
          <b>{summary.criticalBelow}</b>
        </div>
        <div>
          <span className="meta-label">Critical at {CRITICAL_BELOW}</span>
          <b>{summary.criticalAt}</b>
        </div>
        <div>
          <span className="meta-label">Missing scores</span>
          <b>{summary.missing}</b>
        </div>
        <div>
          <span className="meta-label">Final decision</span>
          <StatusBadge value={summary.decision} />
        </div>
      </div>
      <div className="small">
        Passes at {pass}/100; from {minor} it passes with minor modification; below {minor} it goes to
        R&amp;D review. A critical attribute scored below {CRITICAL_BELOW} holds the product whatever the
        total. Every attribute has to be scored before there is a decision.
        {Math.abs(totalWeight - 100) > 0.001
          ? ` The weights on this sheet add up to ${fmtQty(totalWeight)}, not 100 — the score is still taken out of 100 against that total.`
          : ''}
      </div>

      <div className="field">
        <label>R&amp;D / QA comments &amp; corrective action</label>
        <textarea value={value.comments} onChange={(e) => set({ comments: e.target.value })} />
      </div>

      <details className="sensory-guide">
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
    </div>
  )
}
