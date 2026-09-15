/**
 * Stock Issues — everything that leaves without being sold.
 *
 * Lab samples, BTL activities, breakage, expiry write-offs. The page is deliberately
 * plain: pick the stock, say why it went, and it goes. There is no customer, no
 * challan and no dispatch label, and nothing here reaches sales or delivery reporting.
 *
 * The picker offers stock in *any* status on purpose — writing off rejected or
 * expired stock is the whole point of half the reasons, so what is on offer is what
 * is physically there, and the reason is what says why it left.
 */

import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { useApp } from '../context/AppContext'
import { DocLink } from '../components/DocLink'
import { RecordTrail } from '../components/RecordTrail'
import { describeIssue, type IssueLineInput } from '../lib/issues'
import { useLinkedView } from '../lib/linkedView'
import { itemName as lookupItemName, locationLabel, stockRowKey } from '../lib/stock'
import { fmtDate, fmtQty, inr, QTY_EPSILON, toLocalInputValue, statusLabel } from '../lib/utils'
import { ISSUE_REASONS, type IssueReason, type StockIssue } from '../types'
import { keyed, keyedAll, bareAll, type Keyed } from '../lib/rows'

const blankLine: IssueLineInput = {
  item: '',
  lot: '',
  location: '',
  status: '',
  qty: 0,
  expiry: '',
}

/** Everything that makes one row of stock distinct from another, as one string. */
const rowRef = (r: { lot: string; location: string; status: string; expiry?: string }) =>
  JSON.stringify([r.lot, r.location, r.status, r.expiry || ''])

export function StockIssues() {
  const { state, rows, createStockIssue, updateStockIssue, deleteStockIssue } = useApp()

  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [viewId, setViewId, closeView] = useLinkedView((id) =>
    (state.stockIssues || []).some((i) => i.id === id),
  )
  const [date, setDate] = useState(toLocalInputValue())
  const [reason, setReason] = useState<IssueReason>('Lab / testing')
  const [recipient, setRecipient] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Keyed<IssueLineInput>[]>([keyed(blankLine)])

  const itemName = (id: string) => lookupItemName(state, id)

  /**
   * An edit re-draws its own stock, so what this issue already took has to stay on
   * offer — measured as it stood before the issue was posted. Anything else and
   * correcting a quantity downwards is refused for want of stock the issue itself
   * is holding down.
   */
  const editing = editId ? state.stockIssues.find((i) => i.id === editId) : undefined
  const formRows = useMemo(() => {
    if (!editing) return rows
    const back = new Map<string, number>()
    for (const l of editing.lines) {
      const key = `${l.item}${rowRef(l)}`
      back.set(key, (back.get(key) || 0) + l.qty)
    }
    const merged = rows.map((r) => {
      const key = `${r.item}${rowRef(r)}`
      const add = back.get(key)
      if (!add) return r
      back.delete(key)
      return { ...r, qty: r.qty + add }
    })
    // A line that emptied its row entirely leaves no row to add back on to.
    for (const l of editing.lines) {
      const key = `${l.item}${rowRef(l)}`
      const add = back.get(key)
      if (!add) continue
      back.delete(key)
      merged.push({
        item: l.item,
        itemType: l.itemType,
        lot: l.lot,
        location: l.location,
        status: l.status,
        uom: l.uom,
        qty: add,
        value: add * l.unitCost,
        unitCost: l.unitCost,
        expiry: l.expiry,
      })
    }
    return merged
  }, [editing, rows])

  /** Everything physically on hand, whatever its status. */
  const issuable = useMemo(() => formRows.filter((r) => r.qty > QTY_EPSILON), [formRows])

  const issuableItems = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of issuable) if (!seen.has(r.item)) seen.set(r.item, r.itemType)
    return [...seen.entries()].map(([id, itemType]) => ({ id, itemType, name: itemName(id) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuable, state.items])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const all = state.stockIssues
    if (!q) return all
    return all.filter((i) =>
      [i.id, i.reason, i.recipient || '', i.notes || '', describeIssue(state, i.lines), ...i.lines.map((l) => l.lot)]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [search, state])

  const reset = () => {
    setEditId('')
    setDate(toLocalInputValue())
    setReason('Lab / testing')
    setRecipient('')
    setNotes('')
    setLines([keyed(blankLine)])
  }

  const openNew = () => {
    reset()
    setOpen(true)
  }

  const openEdit = (issue: StockIssue) => {
    setEditId(issue.id)
    setDate(toLocalInputValue(new Date(issue.date)))
    setReason(issue.reason)
    setRecipient(issue.recipient || '')
    setNotes(issue.notes || '')
    setLines(
      keyedAll(
        issue.lines.map((l) => ({
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
    const input = { date, reason, recipient, notes, lines: bareAll(lines) }
    const ok = editId ? updateStockIssue(editId, input) : createStockIssue(input)
    if (ok) {
      setOpen(false)
      reset()
    }
  }

  const viewing = viewId ? state.stockIssues.find((i) => i.id === viewId) : undefined
  const postable = lines.filter((l) => l.item && l.lot && l.qty > 0)
  const total = postable.reduce((a, l) => a + (Number(l.qty) || 0), 0)

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Everything issued</h3>
          <span>What left, why it left and who it went to, newest first</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={openNew}>
            + New Issue
          </button>
        </div>
      </div>

      <div className="note">
        Stock comes off the books the moment an issue is saved. Any status can go — writing off
        rejected or expired stock is what half these reasons are for.
      </div>

      <div className="toolbar">
        <input
          placeholder="Search issue, reason, recipient or lot"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Date</th>
              <th>Reason</th>
              <th>Issued to</th>
              <th>What went</th>
              <th>Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!shown.length ? (
              <tr>
                <td colSpan={7} className="empty">
                  <EmptyState
                    filtered={!!search.trim()}
                    empty="No stock has been issued yet."
                    onClear={() => setSearch('')}
                  />
                </td>
              </tr>
            ) : (
              shown.map((i) => (
                <tr key={i.id}>
                  <td data-label="Issue" className="cell-id">
                    <b>{i.id}</b>
                    <div className="cell-sub">
                      {i.lines.length} line{i.lines.length === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td data-label="Date" className="cell-tight">
                    {fmtDate(i.date)}
                  </td>
                  <td data-label="Reason" className="cell-tight">
                    {i.reason}
                  </td>
                  <td data-label="Issued to">{i.recipient || '—'}</td>
                  <td data-label="What went">{describeIssue(state, i.lines)}</td>
                  <td data-label="Value" className="cell-tight">
                    {inr(i.value)}
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <button className="btn btn-light" type="button" onClick={() => setViewId(i.id)}>
                        View
                      </button>
                      <button className="btn btn-light" type="button" onClick={() => openEdit(i)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => deleteStockIssue(i.id)}
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
        title={editId ? `Edit ${editId}` : 'Issue stock'}
        saveLabel={editId ? 'Save changes' : 'Issue stock'}
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
            <label>Reason</label>
            <Select value={reason} onChange={(e) => setReason(e.target.value as IssueReason)}>
              {ISSUE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Issued to (optional)</label>
            <input
              value={recipient}
              placeholder="Lab, event, person"
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
          <div className="field span-3">
            <label>Notes</label>
            <textarea
              value={notes}
              placeholder="What it was for, who authorised it, reference numbers"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="subform" style={{ marginTop: 14 }}>
          <div className="section-head">
            <div>
              <h3>What is going</h3>
              <span>Any stock on hand, whatever its status — the reason says why it left</span>
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
              const forItem = issuable.filter((r) => r.item === line.item)
              const picked = forItem.find((r) => rowRef(r) === rowRef(line))
              return (
                <div className="subform-row" key={line.rowId}>
                  <Select
                    value={line.item}
                    onChange={(e) =>
                      setLine(idx, { item: e.target.value, lot: '', location: '', status: '', expiry: '' })
                    }
                  >
                    <option value="">Select item</option>
                    {issuableItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={line.item ? rowRef(line) : ''}
                    disabled={!line.item}
                    onChange={(e) => {
                      const r = forItem.find((x) => rowRef(x) === e.target.value)
                      if (!r) return
                      setLine(idx, {
                        lot: r.lot,
                        location: r.location,
                        status: r.status,
                        expiry: r.expiry || '',
                      })
                    }}
                  >
                    <option value="">{forItem.length ? 'Select lot' : 'No stock'}</option>
                    {forItem.map((r) => (
                      <option key={rowRef(r)} value={rowRef(r)}>
                        {r.lot} · {locationLabel(state, r.location)} · {statusLabel(r.status)} ·{' '}
                        {fmtQty(r.qty)} {r.uom}
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
                    {picked ? `${fmtQty(picked.qty)} ${picked.uom} on hand` : ''}
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
          {total > 0
            ? `Issuing ${Number(total.toFixed(3))} across ${postable.length} line(s). Stock comes off the books the moment this is saved.`
            : 'Pick what is going and how much of it.'}
        </div>
      </Modal>

      <Modal
        open={!!viewing}
        readOnly
        title={viewing ? `${viewing.id} · ${viewing.reason}` : ''}
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
                <label>Reason</label>
                <div className="field-fixed">{viewing.reason}</div>
              </div>
              <div className="field">
                <label>Issued to</label>
                <div className="field-fixed">{viewing.recipient || '—'}</div>
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Lot</th>
                    <th>From</th>
                    <th>Status</th>
                    <th>Qty</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {viewing.lines.map((l) => (
                    <tr key={stockRowKey(l)}>
                      <td data-label="Item">
                        {itemName(l.item)}
                        {l.expiry ? <div className="small">exp {fmtDate(l.expiry)}</div> : null}
                      </td>
                      <td data-label="Lot">
                        <DocLink doc={l.lot} />
                      </td>
                      <td data-label="From">{locationLabel(state, l.location)}</td>
                      <td data-label="Status" className="cell-tight">
                        {statusLabel(l.status)}
                      </td>
                      <td data-label="Qty" className="cell-tight">
                        {Number(l.qty.toFixed(3))} {l.uom}
                      </td>
                      <td data-label="Value" className="cell-tight">
                        {inr(l.qty * l.unitCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {viewing.notes ? (
              <div className="note" style={{ marginTop: 12 }}>
                {viewing.notes}
              </div>
            ) : null}
            <div className="note" style={{ marginTop: 10 }}>
              Total value issued: <b>{inr(viewing.value)}</b>. This is not a sale — no customer, no
              challan, no dispatch label.
            </div>
            <RecordTrail record={viewing.id} />
          </>
        ) : null}
      </Modal>
    </div>
  )
}
