/**
 * NPD — new product development's own page.
 *
 * Production hands stock over with "Send to NPD" (Inventory, or a batch's record view);
 * it lands in an NPD area under the NPD status, out of production's reach. This page
 * is where NPD sees what it is holding, records what it used — how much, for what, and
 * why — and reads the month back as one report.
 *
 * A use record is a stock issue with reason 'NPD use' (see lib/npd.ts), so an NPD role
 * needs this page and nothing else: page.npd carries the writes.
 */

import { useMemo, useState } from 'react'
import { detailRowProps } from '../components/detailRow'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { ExportButtons } from '../components/ExportButtons'
import { Modal } from '../components/Modal'
import { RecordTrail } from '../components/RecordTrail'
import { Select } from '../components/Select'
import { useApp } from '../context/AppContext'
import { describeIssue, type IssueLineInput, type StockIssueInput } from '../lib/issues'
import { useLinkedView } from '../lib/linkedView'
import { isNpdUse, monthOf, npdAreas, npdMonthReport, npdRows } from '../lib/npd'
import { fmtRowTotal, itemName as lookupItemName, locationLabel, NPD_STATUS, stockRowKey } from '../lib/stock'
import { fmtDate, fmtQty, inr, nowISO, QTY_EPSILON, toLocalInputValue } from '../lib/utils'
import { keyed, keyedAll, bareAll, type Keyed } from '../lib/rows'
import { NPD_PURPOSES, NPD_USE, type NpdPurpose, type StockIssue, type StockRow } from '../types'

const blankLine: IssueLineInput = { item: '', lot: '', location: '', status: NPD_STATUS, qty: 0, expiry: '' }

/** Everything that makes one NPD row distinct from another, as one string. */
const rowRef = (r: { lot: string; location: string; expiry?: string }) =>
  JSON.stringify([r.lot, r.location, r.expiry || ''])

/** "October 2026" for "2026-10". */
const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

export function Npd() {
  const { state, createStockIssue, updateStockIssue, deleteStockIssue } = useApp()
  const itemName = (id: string) => lookupItemName(state, id)

  const held = useMemo(() => npdRows(state), [state])
  const uses = useMemo(
    () => state.stockIssues.filter(isNpdUse).sort((a, b) => b.date.localeCompare(a.date)),
    [state.stockIssues],
  )
  const areas = npdAreas(state)

  const [viewId, setViewId, closeView] = useLinkedView((id) =>
    state.stockIssues.some((i) => i.id === id && isNpdUse(i)),
  )
  const viewing = viewId ? uses.find((i) => i.id === viewId) : undefined

  // ── the record-use form ──────────────────────────────────────────────────────────
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [date, setDate] = useState(toLocalInputValue())
  const [purpose, setPurpose] = useState<NpdPurpose | ''>('')
  const [project, setProject] = useState('')
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<Keyed<IssueLineInput>[]>([keyed(blankLine)])

  const editing = editId ? uses.find((i) => i.id === editId) : undefined
  /**
   * An edit re-draws its own stock, so what the record already used stays on offer —
   * otherwise correcting a quantity down would be refused for want of the very stock
   * the record is holding down.
   */
  const formRows = useMemo(() => {
    const back = new Map<string, StockRow>()
    for (const l of editing?.lines || []) {
      const key = `${l.item}${rowRef(l)}`
      const was = back.get(key)
      if (was) was.qty += l.qty
      else back.set(key, { ...l, qty: l.qty, value: 0 })
    }
    const merged = held.map((r) => {
      const add = back.get(`${r.item}${rowRef(r)}`)
      if (!add) return r
      back.delete(`${r.item}${rowRef(r)}`)
      return { ...r, qty: r.qty + add.qty }
    })
    return [...merged, ...back.values()].filter((r) => r.qty > QTY_EPSILON)
  }, [editing, held])
  const formItems = useMemo(() => [...new Set(formRows.map((r) => r.item))], [formRows])

  const reset = () => {
    setEditId('')
    setDate(toLocalInputValue())
    setPurpose('')
    setProject('')
    setReason('')
    setLines([keyed(blankLine)])
  }

  const openNew = (from?: StockRow) => {
    reset()
    if (from) {
      setLines([
        keyed({ item: from.item, lot: from.lot, location: from.location, status: NPD_STATUS, qty: 0, expiry: from.expiry || '' }),
      ])
    }
    setOpen(true)
  }

  const openEdit = (use: StockIssue) => {
    setEditId(use.id)
    setDate(toLocalInputValue(new Date(use.date)))
    setPurpose(use.npdPurpose || 'Other')
    setProject(use.recipient || '')
    setReason(use.notes || '')
    setLines(
      keyedAll(
        use.lines.map((l) => ({
          item: l.item,
          lot: l.lot,
          location: l.location,
          status: l.status,
          qty: l.qty,
          expiry: l.expiry || '',
        })),
      ),
    )
    setOpen(true)
  }

  const setLine = (idx: number, patch: Partial<IssueLineInput>) =>
    setLines((all) => all.map((l, i) => (i === idx ? { ...l, ...patch } : l)))

  const save = () => {
    const input: StockIssueInput = {
      date,
      reason: NPD_USE,
      npdPurpose: purpose || undefined,
      recipient: project,
      notes: reason,
      lines: bareAll(lines),
    }
    const ok = editId ? updateStockIssue(editId, input) : createStockIssue(input)
    if (ok) {
      setOpen(false)
      reset()
    }
  }

  // ── the monthly report ───────────────────────────────────────────────────────────
  const [month, setMonth] = useState(() => monthOf(nowISO()))
  const report = useMemo(() => npdMonthReport(state, month), [month, state])

  const heldValue = held.reduce((a, r) => a + r.value, 0)

  return (
    <>
      <div className="card metric-strip">
        <div className="metric">
          <div className="label">Held by NPD now</div>
          <div className="value">{inr(heldValue)}</div>
          <div className="sub">{fmtRowTotal(held, 'Nothing held')}</div>
        </div>
        <div className="metric">
          <div className="label">Received in {monthLabel(month)}</div>
          <div className="value">{inr(report.receivedValue)}</div>
          <div className="sub">{report.received.length} send{report.received.length === 1 ? '' : 's'}</div>
        </div>
        <div className="metric">
          <div className="label">Used in {monthLabel(month)}</div>
          <div className="value">{inr(report.usedValue)}</div>
          <div className="sub">
            {report.uses.length} record{report.uses.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head">
          <div>
            <h3>Held by NPD</h3>
            <span>What production has sent to NPD and NPD has not recorded as used yet</span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" type="button" disabled={!held.length} onClick={() => openNew()}>
              + Record use
            </button>
          </div>
        </div>
        {!areas.length ? (
          <div className="note warning-note">
            There is no NPD area yet. Add one on the Storage page with the type “NPD area” — that is
            where stock sent to NPD is kept.
          </div>
        ) : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Lot</th>
                <th>Kept in</th>
                <th className="cell-num cell-tight">On hand</th>
                <th className="cell-num cell-tight">Value</th>
                <th className="cell-actions">Action</th>
              </tr>
            </thead>
            <tbody>
              {!held.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Nothing is held by NPD. Production sends stock here with “Send” on the Inventory
                    page or from a batch’s record.
                  </td>
                </tr>
              ) : (
                held.map((r) => (
                  <tr key={stockRowKey(r)}>
                    <td data-label="Item">
                      <b>{itemName(r.item)}</b>
                      {r.expiry ? <div className="cell-sub">best before {fmtDate(r.expiry)}</div> : null}
                    </td>
                    <td data-label="Lot">
                      <DocLink doc={r.lot} />
                    </td>
                    <td data-label="Kept in">{locationLabel(state, r.location)}</td>
                    <td data-label="On hand" className="cell-num cell-tight">
                      {fmtQty(r.qty)} {r.uom}
                    </td>
                    <td data-label="Value" className="cell-num cell-tight">
                      {inr(r.value)}
                    </td>
                    <td className="cell-actions">
                      <button className="btn btn-light" type="button" onClick={() => openNew(r)}>
                        Record use
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head">
          <div>
            <h3>Use records</h3>
            <span>What NPD used, how much, what for and why — newest first</span>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>Date</th>
                <th>Used for</th>
                <th>What was used</th>
                <th>Reason</th>
                <th className="cell-num cell-tight">Value</th>
                <th className="cell-actions">Action</th>
              </tr>
            </thead>
            <tbody>
              {!uses.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    <EmptyState filtered={false} empty="NPD has not recorded any use yet." onClear={() => {}} />
                  </td>
                </tr>
              ) : (
                uses.map((u) => (
                  <tr key={u.id} {...detailRowProps(() => setViewId(u.id))}>
                    <td data-label="Record" className="cell-id">
                      <b>{u.id}</b>
                    </td>
                    <td data-label="Date" className="cell-tight">
                      {fmtDate(u.date)}
                    </td>
                    <td data-label="Used for">
                      {u.npdPurpose || 'Other'}
                      {u.recipient ? <div className="cell-sub">{u.recipient}</div> : null}
                    </td>
                    <td data-label="What was used">{describeIssue(state, u.lines)}</td>
                    <td data-label="Reason">{u.notes || '—'}</td>
                    <td data-label="Value" className="cell-num cell-tight">
                      {inr(u.value)}
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        <button className="btn btn-light" type="button" onClick={() => openEdit(u)}>
                          Edit
                        </button>
                        <button className="btn btn-danger" type="button" onClick={() => deleteStockIssue(u.id)}>
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
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head">
          <div>
            <h3>Monthly report</h3>
            <span>What NPD received, what it used and for what, and what it still held at month end</span>
          </div>
          <div className="section-head-actions">
            <input
              type="month"
              value={month}
              aria-label="Month"
              onChange={(e) => e.target.value && setMonth(e.target.value)}
            />
            <ExportButtons
              name={`npd-usage-${month}`}
              title={`NPD use — ${monthLabel(month)}`}
              subtitle={`Used ${inr(report.usedValue)} across ${report.uses.length} record(s); received ${inr(report.receivedValue)}; held at month end ${inr(report.heldValue)}`}
              columns={[
                { header: 'Record', value: (u: StockIssue) => u.id },
                { header: 'Date', value: (u: StockIssue) => fmtDate(u.date) },
                { header: 'Used for', value: (u: StockIssue) => u.npdPurpose || 'Other' },
                { header: 'Project', value: (u: StockIssue) => u.recipient || '' },
                { header: 'What was used', value: (u: StockIssue) => describeIssue(state, u.lines) },
                { header: 'Reason', value: (u: StockIssue) => u.notes || '' },
                { header: 'Value', value: (u: StockIssue) => Number(u.value.toFixed(2)) },
              ]}
              rows={report.uses}
            />
          </div>
        </div>

        <h4 style={{ margin: '12px 0 6px' }}>Used for</h4>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Purpose</th>
                <th className="cell-num cell-tight">Records</th>
                <th>What was used</th>
                <th className="cell-num cell-tight">Value</th>
              </tr>
            </thead>
            <tbody>
              {!report.byPurpose.length ? (
                <tr>
                  <td colSpan={4} className="empty">
                    No use recorded in {monthLabel(month)}.
                  </td>
                </tr>
              ) : (
                report.byPurpose.map((p) => (
                  <tr key={p.purpose}>
                    <td data-label="Purpose">
                      <b>{p.purpose}</b>
                    </td>
                    <td data-label="Records" className="cell-num cell-tight">
                      {p.records}
                    </td>
                    <td data-label="What was used">
                      {p.items.map((t) => `${fmtQty(t.qty, 3)} ${t.uom} ${t.name}`).join(', ')}
                    </td>
                    <td data-label="Value" className="cell-num cell-tight">
                      {inr(p.value)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <h4 style={{ margin: '16px 0 6px' }}>By item</h4>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="cell-num cell-tight">Received</th>
                <th className="cell-num cell-tight">Used</th>
                <th className="cell-num cell-tight">Held at month end</th>
                <th className="cell-num cell-tight">Value used</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const keys = new Map<string, { item: string; name: string; uom: string }>()
                const add = (t: { item: string; name: string; uom: string }) =>
                  keys.set(`${t.item}|${t.uom}`, { item: t.item, name: t.name, uom: t.uom })
                report.received.forEach(add)
                report.byItem.forEach(add)
                report.heldAtClose.forEach(add)
                if (!keys.size) {
                  return (
                    <tr>
                      <td colSpan={5} className="empty">
                        NPD neither received, used nor held anything in {monthLabel(month)}.
                      </td>
                    </tr>
                  )
                }
                return [...keys.entries()].map(([key, k]) => {
                  const match = (t: { item: string; uom: string }) => t.item === k.item && t.uom === k.uom
                  const received = report.received.filter(match).reduce((a, r) => a + r.qty, 0)
                  const used = report.byItem.find(match)
                  const left = report.heldAtClose.find(match)
                  return (
                    <tr key={key}>
                      <td data-label="Item">
                        <b>{k.name}</b>
                      </td>
                      <td data-label="Received" className="cell-num cell-tight">
                        {received ? `${fmtQty(received, 3)} ${k.uom}` : '—'}
                      </td>
                      <td data-label="Used" className="cell-num cell-tight">
                        {used ? `${fmtQty(used.qty, 3)} ${k.uom}` : '—'}
                      </td>
                      <td data-label="Held at month end" className="cell-num cell-tight">
                        {left ? `${fmtQty(left.qty, 3)} ${k.uom}` : '—'}
                      </td>
                      <td data-label="Value used" className="cell-num cell-tight">
                        {used ? inr(used.value) : '—'}
                      </td>
                    </tr>
                  )
                })
              })()}
            </tbody>
          </table>
        </div>

        <h4 style={{ margin: '16px 0 6px' }}>Received from production</h4>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th>Lot</th>
                <th>From</th>
                <th>Into</th>
                <th className="cell-num cell-tight">Qty</th>
                <th className="cell-num cell-tight">Value</th>
              </tr>
            </thead>
            <tbody>
              {!report.received.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    Nothing was sent to NPD in {monthLabel(month)}.
                  </td>
                </tr>
              ) : (
                report.received.map((r) => (
                  <tr key={r.doc}>
                    <td data-label="Date" className="cell-tight">
                      {fmtDate(r.time)}
                    </td>
                    <td data-label="Item">{r.name}</td>
                    <td data-label="Lot">
                      <DocLink doc={r.lot} />
                    </td>
                    <td data-label="From">
                      {r.from}
                      <div className="cell-sub">{r.fromStatus === 'Quarantine' ? 'Awaiting QC' : r.fromStatus}</div>
                    </td>
                    <td data-label="Into">{r.to}</td>
                    <td data-label="Qty" className="cell-num cell-tight">
                      {fmtQty(r.qty, 3)} {r.uom}
                    </td>
                    <td data-label="Value" className="cell-num cell-tight">
                      {inr(r.value)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={open}
        title={editId ? `Edit ${editId}` : 'Record NPD use'}
        saveLabel={editId ? 'Save changes' : 'Record use'}
        onClose={() => {
          setOpen(false)
          reset()
        }}
        onSave={save}
      >
        <div className="form-grid">
          <div className="field">
            <label>Date / time</label>
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Used for</label>
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value as NpdPurpose | '')}>
              <option value="">Select purpose</option>
              {NPD_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Project / product (optional)</label>
            <input
              value={project}
              placeholder="e.g. Mango-coconut smoothie trial"
              onChange={(e) => setProject(e.target.value)}
            />
          </div>
          <div className="field span-3">
            <label>Reason</label>
            <textarea
              value={reason}
              placeholder="What was made or tried with it, and why this much"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <div className="subform" style={{ marginTop: 14 }}>
          <div className="section-head">
            <div>
              <h3>What was used</h3>
              <span>Only stock NPD holds</span>
            </div>
            <button
              className="btn btn-light"
              type="button"
              onClick={() => setLines((all) => [...all, keyed(blankLine)])}
            >
              + Add line
            </button>
          </div>
          <div className="subform-body">
            {lines.map((line, idx) => {
              const forItem = formRows.filter((r) => r.item === line.item)
              const picked = forItem.find((r) => rowRef(r) === rowRef(line))
              return (
                <div className="subform-row" key={line.rowId}>
                  <Select
                    value={line.item}
                    onChange={(e) =>
                      setLine(idx, { item: e.target.value, lot: '', location: '', status: NPD_STATUS, expiry: '' })
                    }
                  >
                    <option value="">Select item</option>
                    {formItems.map((id) => (
                      <option key={id} value={id}>
                        {itemName(id)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={line.lot ? rowRef(line) : ''}
                    disabled={!line.item}
                    onChange={(e) => {
                      const r = forItem.find((x) => rowRef(x) === e.target.value)
                      if (r) setLine(idx, { lot: r.lot, location: r.location, status: NPD_STATUS, expiry: r.expiry || '' })
                    }}
                  >
                    <option value="">{forItem.length ? 'Select lot' : 'No stock'}</option>
                    {forItem.map((r) => (
                      <option key={rowRef(r)} value={rowRef(r)}>
                        {r.lot} · {locationLabel(state, r.location)} · {fmtQty(r.qty)} {r.uom}
                        {r.expiry ? ` · exp ${fmtDate(r.expiry)}` : ''}
                      </option>
                    ))}
                  </Select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Qty"
                    value={line.qty || ''}
                    onChange={(e) => setLine(idx, { qty: Number(e.target.value) })}
                  />
                  <span className={`subform-unit${picked && line.qty > picked.qty ? ' off-recipe' : ''}`}>
                    {picked ? `${fmtQty(picked.qty)} ${picked.uom} held` : ''}
                  </span>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={lines.length === 1}
                    onClick={() => setLines((all) => all.filter((_, i) => i !== idx))}
                  >
                    Remove
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        <div className="note" style={{ marginTop: 12 }}>
          What is recorded here comes out of NPD’s stock the moment it is saved, and counts in the
          month’s report under the purpose picked.
        </div>
      </Modal>

      <Modal
        open={!!viewing}
        readOnly
        title={viewing ? `${viewing.id} · ${viewing.npdPurpose || 'Other'}` : ''}
        onClose={closeView}
        onSave={closeView}
      >
        {viewing ? (
          <>
            <div className="form-grid">
              <div className="field">
                <label>Date</label>
                <div className="field-fixed">{fmtDate(viewing.date)}</div>
              </div>
              <div className="field">
                <label>Used for</label>
                <div className="field-fixed">{viewing.npdPurpose || 'Other'}</div>
              </div>
              <div className="field">
                <label>Project / product</label>
                <div className="field-fixed">{viewing.recipient || '—'}</div>
              </div>
              <div className="field span-3">
                <label>Reason</label>
                <div className="field-fixed">{viewing.notes || '—'}</div>
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Lot</th>
                    <th>From</th>
                    <th>Qty</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {viewing.lines.map((l) => (
                    <tr key={stockRowKey(l)}>
                      <td data-label="Item">{itemName(l.item)}</td>
                      <td data-label="Lot">
                        <DocLink doc={l.lot} />
                      </td>
                      <td data-label="From">{locationLabel(state, l.location)}</td>
                      <td data-label="Qty" className="cell-tight">
                        {fmtQty(l.qty, 3)} {l.uom}
                      </td>
                      <td data-label="Value" className="cell-tight">
                        {inr(l.qty * l.unitCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="note" style={{ marginTop: 10 }}>
              Total value used: <b>{inr(viewing.value)}</b>.
            </div>
            <RecordTrail record={viewing.id} />
          </>
        ) : null}
      </Modal>
    </>
  )
}
