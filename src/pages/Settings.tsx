import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { useApp } from '../context/AppContext'
import { planCleanup } from '../lib/cleanup'
import {
  DATE_TOKENS,
  SERIES_GROUPS,
  SHAPE_CHOICES,
  checkNumbering,
  formatDocNo,
  highestIssued,
  ruleFor,
  type SeriesDef,
} from '../lib/numbering'
import { toDateKey } from '../lib/utils'
import type { AppState, NumberingRule } from '../types'

/**
 * One numbering series, as a row the admin can rewrite. The row keeps its own draft
 * and saves on its own button, because renaming receipts has no business also
 * committing a half-typed change to the challan series two rows down.
 */
function NumberingRow({
  def,
  state,
  onSave,
}: {
  def: SeriesDef
  state: AppState
  onSave: (key: string, rule: NumberingRule, next: number) => string | null
}) {
  const saved = ruleFor(state.config, def.key)
  const used = Number(state.counters[def.key]) || 0
  const [rule, setRule] = useState<NumberingRule>(saved)
  const [next, setNext] = useState(String(used + 1))
  const [typing, setTyping] = useState(false)
  /**
   * Set by any edit to this row, so a background state change cannot discard it.
   * The counter moves whenever anyone anywhere posts a document in this series, and
   * without this an operator halfway through typing a new prefix loses it the moment
   * a receipt is raised on another screen.
   */
  const edited = useRef(false)

  // The stored rule arrives from the database a moment after the first paint, and
  // another operator may renumber while this page is open; either way the row
  // re-reads what is stored — but never over the top of an unsaved edit.
  useEffect(() => {
    if (edited.current) return
    setRule(saved)
    setNext(String(used + 1))
    setTyping(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.prefix, saved.pattern, saved.pad, used])

  const edit = (fn: (r: NumberingRule) => NumberingRule) => {
    edited.current = true
    setRule(fn)
  }

  const start = Math.max(1, Math.round(Number(next) || 0))
  const dirty =
    rule.prefix !== saved.prefix ||
    rule.pattern !== saved.pattern ||
    Number(rule.pad) !== saved.pad ||
    start !== used + 1
  /**
   * Both of these walk every code the series has ever issued, so they are memoised
   * rather than recomputed on each keystroke — nineteen rows scanning thousands of
   * documents on every render is a page that stops responding as the plant fills up.
   */
  const error = useMemo(
    () => (dirty ? checkNumbering(state, def.key, rule, start) : null),
    [dirty, state, def.key, rule, start],
  )
  const issued = useMemo(
    () => highestIssued(state, def.key, rule),
    [state, def.key, rule],
  )

  // Each shape is offered as the code it would actually produce for this series, so
  // picking a format is reading `RFTC20260001` off a list rather than knowing what
  // `{P}{YYYY}{N}` means. The row's own shape is always among them, even if typed.
  const shapes = [...new Set([...SHAPE_CHOICES, rule.pattern])]

  return (
    <tr>
      <td data-label="Series">
        <b>{def.label}</b>
        <div className="small">{def.blurb}</div>
      </td>
      <td data-label="Prefix" className="cell-tight">
        <input
          value={rule.prefix}
          placeholder={def.prefix}
          onChange={(e) => edit((r) => ({ ...r, prefix: e.target.value }))}
        />
      </td>
      <td data-label="Format">
        <Select
          value={typing ? 'custom' : rule.pattern}
          onChange={(e) => {
            edited.current = true
            if (e.target.value === 'custom') return setTyping(true)
            setTyping(false)
            setRule((r) => ({ ...r, pattern: e.target.value }))
          }}
        >
          {shapes.map((p) => (
            <option key={p} value={p}>
              {formatDocNo({ ...rule, pattern: p }, start)}
            </option>
          ))}
          <option value="custom">Something else…</option>
        </Select>
        {typing ? (
          <input
            value={rule.pattern}
            placeholder="{P}{YYYY}{N}"
            style={{ marginTop: 6 }}
            onChange={(e) => edit((r) => ({ ...r, pattern: e.target.value }))}
          />
        ) : null}
      </td>
      <td data-label="Digits" className="cell-tight">
        <input
          type="number"
          min={1}
          max={9}
          value={rule.pad}
          onChange={(e) => edit((r) => ({ ...r, pad: Number(e.target.value) }))}
        />
      </td>
      <td data-label="Next number" className="cell-tight">
        <input
          type="number"
          min={1}
          value={next}
          onChange={(e) => {
            edited.current = true
            setNext(e.target.value)
          }}
        />
      </td>
      <td data-label="Next code">
        <b>{formatDocNo(rule, start)}</b>
        {/* Said in the row, not in a tooltip on the Save button — a disabled button
            swallows the hover in most browsers, so the reason never appeared. */}
        <div className={`small${error ? ' warning-text' : ''}`}>
          {error || (issued ? `last issued ${formatDocNo(rule, issued)}` : 'none issued yet')}
        </div>
      </td>
      <td className="cell-tight">
        <button
          className="btn btn-primary"
          type="button"
          disabled={!dirty || !!error}
          onClick={() => {
            if (!onSave(def.key, rule, start)) edited.current = false
          }}
        >
          Save
        </button>
      </td>
    </tr>
  )
}

export function Settings() {
  const { state, saveConfig, saveNumbering, exportData, clearRecordsFrom } = useApp()
  const navigate = useNavigate()
  const [config, setConfig] = useState(state.config)
  useEffect(() => setConfig(state.config), [state.config])

  const [resetOpen, setResetOpen] = useState(false)
  const [resetPhrase, setResetPhrase] = useState('')
  const [backedUp, setBackedUp] = useState(false)
  const [cutoff, setCutoff] = useState(() => toDateKey())

  /**
   * Each block has its own Save button, so each one must save its own fields and
   * nothing else. Passing the whole draft made any button commit every edit on the
   * page — tolerances you had thought better of went in the moment you saved the
   * label wording.
   */
  const saveSection = (keys: (keyof typeof config)[]) => {
    const patch = Object.fromEntries(keys.map((k) => [k, config[k]]))
    saveConfig({ ...state.config, ...patch })
  }

  const plan = useMemo(() => planCleanup(state, cutoff), [state, cutoff])
  const going =
    plan.remove.grns.length +
    plan.remove.batches.length +
    plan.remove.packingRuns.length +
    plan.remove.dispatches.length +
    plan.remove.orders.length
  const staying = plan.keep.grns + plan.keep.batches + plan.keep.packingRuns + plan.keep.dispatches

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Configuration</h3>
          <span>Plant tolerances and alert thresholds</span>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Yield tolerance (%)</label>
          <input
            type="number"
            value={config.yieldTolerance}
            onChange={(e) => setConfig((c) => ({ ...c, yieldTolerance: Number(e.target.value) }))}
          />
        </div>
        <div className="field">
          <label>Packing-material variance tolerance (%)</label>
          <input
            type="number"
            value={config.pmTolerance}
            onChange={(e) => setConfig((c) => ({ ...c, pmTolerance: Number(e.target.value) }))}
          />
        </div>
        <div className="field">
          <label>Near-expiry alert (days)</label>
          <input
            type="number"
            value={config.expiryAlertDays}
            onChange={(e) => setConfig((c) => ({ ...c, expiryAlertDays: Number(e.target.value) }))}
          />
        </div>
        <div className="field">
          <label>Low-stock threshold (packs)</label>
          <input
            type="number"
            value={config.lowStockPacks}
            onChange={(e) => setConfig((c) => ({ ...c, lowStockPacks: Number(e.target.value) }))}
          />
        </div>
        {/* Fixed for this plant. Shown as text, not as a greyed-out box — an empty-looking
            disabled field reads as something the operator failed to fill in. */}
        <div className="field">
          <label>Plant timezone (fixed)</label>
          <div className="field-fixed">Asia/Kolkata</div>
        </div>
        <div className="field">
          <label>Currency (fixed)</label>
          <div className="field-fixed">Indian Rupee (₹)</div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <button
          className="btn btn-primary"
          onClick={() =>
            saveSection(['yieldTolerance', 'pmTolerance', 'expiryAlertDays', 'lowStockPacks'])
          }
        >
          Save Tolerances
        </button>
      </div>

      <div className="section-head" style={{ marginTop: 28 }}>
        <div>
          <h3>Lab Report Defaults</h3>
          <span>Pre-fills every new lab report — still editable per report</span>
        </div>
      </div>
      <div className="form-grid">
        <div className="field span-2">
          <label>Report customer name</label>
          <input
            value={config.reportCustomerName}
            onChange={(e) => setConfig((c) => ({ ...c, reportCustomerName: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Default lab technician</label>
          <input
            value={config.defaultLabTechnician}
            onChange={(e) => setConfig((c) => ({ ...c, defaultLabTechnician: e.target.value }))}
          />
        </div>
        <div className="field span-3">
          <label>Report customer address</label>
          <textarea
            value={config.reportCustomerAddress}
            onChange={(e) => setConfig((c) => ({ ...c, reportCustomerAddress: e.target.value }))}
          />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <button
          className="btn btn-primary"
          onClick={() =>
            saveSection(['reportCustomerName', 'defaultLabTechnician', 'reportCustomerAddress'])
          }
        >
          Save Report Defaults
        </button>
      </div>

      {/* The plant's own wording. Food-safety copy is not something the app should be
          inventing on anyone's behalf. */}
      <div className="section-head" style={{ marginTop: 28 }}>
        <div>
          <h3>Label Wording</h3>
          <span>The fixed lines printed at the foot of each sticker</span>
        </div>
      </div>
      <div className="form-grid">
        <div className="field span-3">
          <label>Storage line — production label (frozen)</label>
          <input
            value={config.frozenStorageLine || ''}
            placeholder="Always store in Cool (-18°C) Dry and Hygiene Place"
            onChange={(e) => setConfig((c) => ({ ...c, frozenStorageLine: e.target.value }))}
          />
        </div>
        <div className="field span-3">
          <label>Storage line — dispatch label (chilled)</label>
          <input
            value={config.chilledStorageLine || ''}
            placeholder="Always store in Cool (4°C) Dry & Hygiene Place"
            onChange={(e) => setConfig((c) => ({ ...c, chilledStorageLine: e.target.value }))}
          />
        </div>
        <div className="field span-3">
          <label>Once-opened line — dispatch label</label>
          <input
            value={config.consumeWithinLine || ''}
            placeholder="Consume within 3 days of opening"
            onChange={(e) => setConfig((c) => ({ ...c, consumeWithinLine: e.target.value }))}
          />
        </div>
      </div>
      <div className="note">
        Each pack carries its own two shelf lives and its MRP — set those on{' '}
        <b>Products &amp; Materials</b>. These three lines are the same on every label.
      </div>
      <div style={{ marginTop: 14 }}>
        <button
          className="btn btn-primary"
          onClick={() =>
            saveSection(['frozenStorageLine', 'chilledStorageLine', 'consumeWithinLine'])
          }
        >
          Save Label Wording
        </button>
      </div>

      {/* Document codes are the plant's, not the app's. A receipt filed as
          RFTC20260007 and a challan as DC0007/2026 have to read that way on the paper
          they are filed against — note the year on opposite sides of the number —
          so the format is set here, and the running number carries on from whatever
          the admin says it starts at. */}
      <div className="section-head" style={{ marginTop: 28 }}>
        <div>
          <h3>Document Numbering</h3>
          <span>
            The prefix and the number every auto-numbered document starts from — receipts,
            batches, challans, vendors and the rest
          </span>
        </div>
      </div>
      <div className="note">
        Pick a <b>format</b> and it shows you the code it would mint. Change the format and the
        series starts again at 1; keep it and the number must carry on past what is already
        filed, because reissuing a code would leave two documents answering to the same id.
        Nothing already printed or posted is renamed — a change only affects the next document
        written.
        <div className="small" style={{ marginTop: 6 }}>
          Under <b>Something else…</b> the parts are <code>{'{P}'}</code> the prefix,{' '}
          <code>{'{N}'}</code> the running number, and{' '}
          {Object.entries(DATE_TOKENS).map(([t, d], i) => (
            <span key={t}>
              {i ? ', ' : ''}
              <code>{`{${t}}`}</code> {d.label.split('—')[1].trim()}
            </span>
          ))}
          . Anything else prints as typed — <code>{'{P}{N}/{YYYY}'}</code> is DC0001/2026.
        </div>
      </div>
      {SERIES_GROUPS.map((g) => (
        <div key={g.group} style={{ marginTop: 14 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{g.group}</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Series</th>
                  <th>Prefix</th>
                  <th>Format</th>
                  <th>Digits</th>
                  <th>Next number</th>
                  <th>Next code</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.series.map((def) => (
                  <NumberingRow key={def.key} def={def} state={state} onSave={saveNumbering} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Areas moved to their own page — adding a chest freezer belongs next to the
          stock it will hold, not three screens below the yield tolerance. */}
      <div className="section-head" style={{ marginTop: 28 }}>
        <div>
          <h3>Storage areas</h3>
          <span>One list — cold rooms, dry stores and hold areas</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={() => navigate('/storage')}>
            Open Storage
          </button>
        </div>
      </div>
      <div className="note">
        Storage areas live on the <b>Storage</b> page now, alongside what each one is holding and
        every move between them. You have{' '}
        {state.storageLocations.filter((s) => s.status === 'Active').length} active area
        {state.storageLocations.filter((s) => s.status === 'Active').length === 1 ? '' : 's'}.
      </div>

      {/* A tested app handed to a live plant carries the test run's records and its
          numbering. There is no author on a record to filter by, so the split is by
          date — see planCleanup. Everything is shown before anything is deleted. */}
      <div className="section-head" style={{ marginTop: 28 }}>
        <div>
          <h3>Clear the test run</h3>
          <span>Remove records entered from a date onwards and keep everything before it</span>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Delete records dated on or after</label>
          <input type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
        </div>
      </div>

      <div className={`note${going ? ' warning-note' : ''}`} style={{ marginTop: 12 }}>
        {going ? (
          <>
            <b>Would delete {going} document{going === 1 ? '' : 's'}</b> dated {cutoff} or later —{' '}
            {plan.remove.grns.length} receipt{plan.remove.grns.length === 1 ? '' : 's'},{' '}
            {plan.remove.batches.length} batch{plan.remove.batches.length === 1 ? '' : 'es'},{' '}
            {plan.remove.packingRuns.length} packing run
            {plan.remove.packingRuns.length === 1 ? '' : 's'}, {plan.remove.dispatches.length}{' '}
            dispatch{plan.remove.dispatches.length === 1 ? '' : 'es'}, {plan.remove.orders.length}{' '}
            order{plan.remove.orders.length === 1 ? '' : 's'} — plus{' '}
            {plan.remove.stockIssues.length} stock issue
            {plan.remove.stockIssues.length === 1 ? '' : 's'}, {plan.remove.qcs.length} QC record
            {plan.remove.qcs.length === 1 ? '' : 's'} and{' '}
            {plan.remove.ledgerRows} stock ledger line
            {plan.remove.ledgerRows === 1 ? '' : 's'} behind them.
            {plan.remove.grns.length + plan.remove.batches.length ? (
              <div className="small" style={{ marginTop: 6 }}>
                {[...plan.remove.grns, ...plan.remove.batches].join(', ')}
              </div>
            ) : null}
          </>
        ) : (
          <>Nothing is dated {cutoff} or later. Pick an earlier date to see what would go.</>
        )}
      </div>
      <div className="note" style={{ marginTop: 10 }}>
        <b>Keeps</b> the {staying} document{staying === 1 ? '' : 's'} dated before {cutoff}, their
        stock and their audit trail — and every master: items, bulks, melanges, packs, packing
        materials, suppliers, customers, storage locations and test parameters. Numbering carries
        on from the highest number still in use, so no live document code is ever reissued.
      </div>
      {plan.blockers.length ? (
        <div className="note warning-note" style={{ marginTop: 10 }}>
          <b>Blocked.</b> Something you are keeping was built from something this cutoff would
          delete, so removing it would leave its stock wrong: {plan.blockers.slice(0, 3).join('; ')}
          {plan.blockers.length > 3 ? `, and ${plan.blockers.length - 3} more` : ''}. Move the date
          later, or delete those records individually first.
        </div>
      ) : null}

      <div className="row-actions" style={{ marginTop: 12 }}>
        <button
          className="btn btn-light"
          type="button"
          onClick={() => {
            exportData()
            setBackedUp(true)
          }}
        >
          Back up all data first
        </button>
        <button
          className="btn btn-danger"
          type="button"
          disabled={!going || plan.blockers.length > 0}
          onClick={() => {
            setResetPhrase('')
            setResetOpen(true)
          }}
        >
          Delete {going} document{going === 1 ? '' : 's'}
        </button>
      </div>

      <Modal
        open={resetOpen}
        title={`Delete ${going} document${going === 1 ? '' : 's'} from ${cutoff}`}
        saveLabel="Delete them"
        saveDisabled={resetPhrase.trim().toUpperCase() !== 'DELETE'}
        onClose={() => setResetOpen(false)}
        onSave={() => {
          clearRecordsFrom(cutoff)
          setResetOpen(false)
        }}
      >
        <div className="note warning-note">
          Going: {[...plan.remove.grns, ...plan.remove.batches, ...plan.remove.packingRuns, ...plan.remove.dispatches].join(', ') || 'nothing'}.
          <br />
          Staying: the {staying} document{staying === 1 ? '' : 's'} dated before {cutoff}. There is
          no undo — the only way back is the backup file.
        </div>
        {!backedUp ? (
          <div className="note" style={{ marginTop: 12 }}>
            You have not downloaded a backup in this session.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                exportData()
                setBackedUp(true)
              }}
            >
              Download one now
            </button>
            .
          </div>
        ) : (
          <div className="note" style={{ marginTop: 12 }}>
            Backup downloaded. Keep that file somewhere safe before going on.
          </div>
        )}
        <div className="field" style={{ marginTop: 14 }}>
          <label>Type DELETE to confirm</label>
          <input
            value={resetPhrase}
            placeholder="DELETE"
            onChange={(e) => setResetPhrase(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  )
}
