/**
 * The control sample register — the plant's control sampling tracking sheet on screen.
 *
 * Every row is a line on a packing run: the bottles kept back when it was packed. They
 * are not stock and nothing here moves any; what the page keeps is the record the sheet
 * kept — who collected them, the day they expire, the day they were destroyed.
 */

import { useMemo, useState } from 'react'
import { DetailView, type DetailSection } from '../components/DetailView'
import { detailRowProps } from '../components/detailRow'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import {
  SortHeader,
  SortSelect,
  sortRows,
  useTableSort,
  type SortAccessors,
} from '../components/tableSort'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { fmtBulk, itemUom, runBulkItem } from '../lib/batches'
import {
  controlSampleRows,
  retentionDays,
  type ControlSampleRow,
  type ControlSampleStatus,
} from '../lib/controlSamples'
import { fmtDate, toDateKey } from '../lib/utils'

const TABS: [ControlSampleStatus | '', string][] = [
  ['', 'All'],
  ['Retained', 'Retained'],
  ['Expired', 'Expired — to destroy'],
  ['Destroyed', 'Destroyed'],
]

export function ControlSamples() {
  const { state, updateControlSample } = useApp()
  const today = toDateKey()
  const all = useMemo(() => controlSampleRows(state, today), [state, today])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ControlSampleStatus | ''>('')
  const [viewKey, setViewKey] = useState('')
  const [editKey, setEditKey] = useState('')
  const [form, setForm] = useState({ collectedBy: '', destroyedOn: '', remark: '' })
  const days = retentionDays(state.config)

  const rows = useMemo(() => {
    const q = search.toLowerCase()
    return all.filter(
      (r) =>
        (!filter || r.status === filter) &&
        [r.product, r.run.batchId, r.run.id, r.sample.collectedBy || '', r.sample.remark || '']
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
  }, [all, filter, search])

  const { sort, toggle, setSort } = useTableSort()
  const sortBy: SortAccessors<ControlSampleRow> = {
    date: (r) => r.producedOn,
    product: (r) => r.product,
    batch: (r) => r.run.batchId,
    bottles: (r) => r.sample.count,
    collected: (r) => r.sample.collectedBy,
    expiry: (r) => r.sample.expiresOn,
    destroyed: (r) => r.sample.destroyedOn,
    status: (r) => r.status,
  }
  const sorted = sortRows(rows, sort, sortBy)

  const count = (status: ControlSampleStatus | '') =>
    status ? all.filter((r) => r.status === status).length : all.length

  const viewing = all.find((r) => r.key === viewKey)
  const editing = all.find((r) => r.key === editKey)

  const openEdit = (r: ControlSampleRow, destroy = false) => {
    setEditKey(r.key)
    setForm({
      collectedBy: r.sample.collectedBy || '',
      destroyedOn: r.sample.destroyedOn || (destroy ? today : ''),
      remark: r.sample.remark || '',
    })
  }

  const eachHeld = (r: ControlSampleRow) =>
    r.sample.perBottle ? fmtBulk(r.sample.perBottle, itemUom(state, runBulkItem(r.run))) : ''

  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Control samples',
          fields: [
            { label: 'Date', value: fmtDate(viewing.producedOn) },
            { label: 'Name of product', value: viewing.product },
            { label: 'Batch no.', value: <DocLink doc={viewing.run.batchId} /> },
            { label: 'Packing run', value: <DocLink doc={viewing.run.id} /> },
            { label: 'Bottles', value: viewing.sample.count },
            { label: 'Each held', value: eachHeld(viewing) },
            { label: 'Collected by', value: viewing.sample.collectedBy },
            { label: 'Date of expiry', value: viewing.sample.expiresOn ? fmtDate(viewing.sample.expiresOn) : '' },
            { label: 'Status', value: viewing.status },
            { label: 'Date destroyed', value: viewing.sample.destroyedOn ? fmtDate(viewing.sample.destroyedOn) : '' },
            { label: 'Remark', value: viewing.sample.remark, wide: true },
          ],
        },
      ]
    : []

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Control Samples</h3>
          <span>Control sampling tracking — every bottle kept back off a packing run</span>
        </div>
      </div>
      <div className="note">
        Control samples are recorded on the <b>packing run</b> they were kept back from — its juice, and a
        pack&apos;s bottle and cap, are drawn off the batch there. They are <b>never stock</b>: they cannot be
        dispatched, moved or issued, and nothing here changes inventory. Each expires{' '}
        <b>
          {days} day{days === 1 ? '' : 's'}
        </b>{' '}
        after the day it was produced. Once they are destroyed, record the date here; the record stays
        for audit.
      </div>

      <div className="vendors-toolbar">
        <div className="type-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id || 'all'}
              type="button"
              className={`type-tab ${filter === id ? 'active' : ''}`}
              onClick={() => setFilter(id)}
            >
              {label} ({count(id)})
            </button>
          ))}
        </div>
        <input
          className="vendors-search"
          placeholder="Search product, batch, run or person"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <SortSelect
        sort={sort}
        onPick={setSort}
        columns={[
          { k: 'date', label: 'Date', kind: 'date' },
          { k: 'product', label: 'Product' },
          { k: 'batch', label: 'Batch no.', kind: 'text' },
          { k: 'bottles', label: 'Bottles', kind: 'num' },
          { k: 'expiry', label: 'Expiry', kind: 'date' },
          { k: 'destroyed', label: 'Destroyed', kind: 'date' },
          { k: 'status', label: 'Status' },
        ]}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Date" k="date" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Name of Product" k="product" sort={sort} onToggle={toggle} />
              <SortHeader label="Batch No." k="batch" sort={sort} onToggle={toggle} />
              <SortHeader label="Bottles" k="bottles" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Collected By" k="collected" sort={sort} onToggle={toggle} />
              <SortHeader label="Date of Expiry" k="expiry" sort={sort} onToggle={toggle} />
              <SortHeader label="Date Destroyed" k="destroyed" first="desc" sort={sort} onToggle={toggle} />
              <th>Remark</th>
              <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={10} className="empty">
                  <EmptyState
                    filtered={!!search || !!filter}
                    empty="No control samples yet — record them on a packing run as it is posted."
                    onClear={() => {
                      setSearch('')
                      setFilter('')
                    }}
                  />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.key} {...detailRowProps(() => setViewKey(r.key))}>
                  <td data-label="Date">{fmtDate(r.producedOn)}</td>
                  <td data-label="Name of Product">{r.product}</td>
                  <td data-label="Batch No." className="register-doc">
                    <DocLink doc={r.run.batchId} />
                    <div className="small">
                      <DocLink doc={r.run.id} />
                    </div>
                  </td>
                  <td data-label="Bottles">{r.sample.count}</td>
                  <td data-label="Collected By">{r.sample.collectedBy || '—'}</td>
                  <td data-label="Date of Expiry">{r.sample.expiresOn ? fmtDate(r.sample.expiresOn) : '—'}</td>
                  <td data-label="Date Destroyed">{r.sample.destroyedOn ? fmtDate(r.sample.destroyedOn) : '—'}</td>
                  <td data-label="Remark">{r.sample.remark || '—'}</td>
                  <td data-label="Status">
                    <StatusBadge value={r.status} />
                  </td>
                  <td className="cell-actions">
                      <div className="row-actions">
                        <button className="btn btn-light" type="button" onClick={() => openEdit(r)}>
                        Edit
                      </button>
                      {r.sample.destroyedOn ? null : (
                        <button className="btn btn-primary" type="button" onClick={() => openEdit(r, true)}>
                          Mark Destroyed
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <DetailView
        open={!!viewing}
        title={viewing ? `${viewing.product} · ${viewing.run.batchId}` : 'Control samples'}
        sections={viewSections}
        onClose={() => setViewKey('')}
        record={viewing?.run.id}
      />

      <Modal
        open={!!editing}
        title={editing ? `Control Samples · ${editing.product} · ${editing.run.batchId}` : 'Control Samples'}
        saveLabel="Save"
        onClose={() => setEditKey('')}
        onSave={() => {
          if (!editing) return
          if (updateControlSample(editing.run.id, editing.index, form)) setEditKey('')
        }}
      >
        {editing ? (
          <>
            <div className="form-grid">
              <div className="field span-2">
                <label>Collected by</label>
                <input
                  value={form.collectedBy}
                  onChange={(e) => setForm((f) => ({ ...f, collectedBy: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Date destroyed</label>
                <input
                  type="date"
                  min={editing.producedOn}
                  max={today}
                  value={form.destroyedOn}
                  onChange={(e) => setForm((f) => ({ ...f, destroyedOn: e.target.value }))}
                />
              </div>
              <div className="field span-3">
                <label>Remark</label>
                <textarea value={form.remark} onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))} />
              </div>
            </div>
            <div className="note">
              {editing.sample.count} bottle{editing.sample.count === 1 ? '' : 's'} produced{' '}
              {fmtDate(editing.producedOn)}
              {editing.sample.expiresOn ? `, expiring ${fmtDate(editing.sample.expiresOn)}` : ''}. Leave the
              date destroyed empty while they are still kept.
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  )
}
