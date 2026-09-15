/**
 * Storage — every area the plant keeps stock in, what is sitting in each, where new stock
 * goes by default, and every move between them.
 *
 * There used to be four lists on this page: freezers, defrost areas, stores and holds,
 * each with its own heading and its own "+ Add" button. That made a cold room and a
 * chest freezer different sorts of thing, left nobody sure whether bulk belonged in a
 * "store" or a "hold", and meant adding a shelf started with choosing which of four
 * lists to put it in. There is one list now. What an area *is* is a field on it.
 */

import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { MoveStockModal } from '../components/MoveStockModal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import {
  AREA_PURPOSES,
  STORAGE_TYPES,
  allowedAreas,
  areaDeleteBlocker,
  defaultArea,
  defaultsOf,
  fmtRowTotal,
  itemTypeLabel,
  locationLabel,
  roomSuits,
  stockRowKey,
  storageTypeCount,
  storageTypeLabel,
} from '../lib/stock'
import { stockIdOfRow } from '../lib/stockIds'
import { fmtDate, fmtQty, inr, QTY_EPSILON, statusLabel } from '../lib/utils'
import type { StockRow, StorageLocation, StorageType } from '../types'

const blankArea = { label: '', holds: '', type: '' as StorageType | '' }

export function Storage() {
  const {
    state,
    rows,
    getItemName,
    addStorageLocation,
    updateStorageLocation,
    setStorageLocationStatus,
    setDefaultArea,
    deleteStorageLocation,
  } = useApp()

  const [openLoc, setOpenLoc] = useState(false)
  const [editLoc, setEditLoc] = useState('')
  const [loc, setLoc] = useState(blankArea)
  const [typeFilter, setTypeFilter] = useState<StorageType | ''>('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState('')
  const [moving, setMoving] = useState<StockRow | null>(null)
  const [confirming, setConfirming] = useState<{
    kind: 'deactivate' | 'delete'
    area: StorageLocation
  } | null>(null)
  const [historyArea, setHistoryArea] = useState('')

  /** What each area is holding right now, so a card can show it without a second pass. */
  const held = useMemo(() => {
    const by = new Map<string, { rows: StockRow[]; value: number }>()
    for (const r of rows) {
      if (r.qty <= QTY_EPSILON) continue
      const acc = by.get(r.location) || { rows: [], value: 0 }
      acc.rows.push(r)
      acc.value += r.value
      by.set(r.location, acc)
    }
    return by
  }, [rows])

  /** Every transfer ever made, newest first — the out-leg names where it came from. */
  const moves = useMemo(() => {
    const byDoc = new Map<string, { out?: (typeof state.ledger)[number]; in?: (typeof state.ledger)[number] }>()
    for (const l of state.ledger) {
      if (l.type !== 'Stock Transfer') continue
      const pair = byDoc.get(l.doc) || {}
      if (l.qtyOut > 0) pair.out = l
      else pair.in = l
      byDoc.set(l.doc, pair)
    }
    return [...byDoc.values()]
      .filter((p) => p.in && p.out)
      .map((p) => ({
        doc: p.in!.doc,
        time: p.in!.time,
        stockId: stockIdOfRow(state, p.in!),
        item: getItemName(p.in!.item),
        status: p.in!.status,
        qty: p.in!.qtyIn,
        uom: p.in!.uom,
        fromName: p.out!.location,
        toName: p.in!.location,
        from: locationLabel(state, p.out!.location),
        to: locationLabel(state, p.in!.location),
      }))
      .sort((a, b) => b.time.localeCompare(a.time))
  }, [getItemName, state])
  const shownMoves = historyArea
    ? moves.filter((m) => m.fromName === historyArea || m.toName === historyArea)
    : moves

  const areas = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.storageLocations
      .filter(
        (s) =>
          (!typeFilter || s.type === typeFilter) &&
          (!q || [s.label, s.holds, storageTypeLabel(s.type)].join(' ').toLowerCase().includes(q)),
      )
      // Cold rooms first: they are where production output and finished goods live, so
      // they are what an operator on this page is usually looking for.
      .slice()
      .sort(
        (a, b) =>
          STORAGE_TYPES.findIndex((t) => t.value === a.type) -
            STORAGE_TYPES.findIndex((t) => t.value === b.type) ||
          a.label.localeCompare(b.label),
      )
  }, [search, state.storageLocations, typeFilter])

  const openEdit = (s: StorageLocation) => {
    setEditLoc(s.id)
    setLoc({ label: s.label, holds: s.holds, type: s.type })
    setOpenLoc(true)
  }

  const openAdd = () => {
    setEditLoc('')
    // The type is picked on purpose: defaulting to a cold room saved packaging stores as
    // cold rooms whenever nobody noticed the dropdown.
    setLoc({ ...blankArea, type: typeFilter })
    setOpenLoc(true)
  }

  const active = state.storageLocations.filter((s) => s.status === 'Active')
  const inactive = state.storageLocations.length - active.length
  const totalValue = [...held.values()].reduce((a, b) => a + b.value, 0)
  const countOf = (type: StorageType) => active.filter((s) => s.type === type).length

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card metric">
          <div className="label">Active storage areas</div>
          <div className="value">{active.length}</div>
          <div className="sub">
            {STORAGE_TYPES.map((t) => storageTypeCount(t.value, countOf(t.value))).join(' · ')}
            {inactive ? ` · ${inactive} inactive` : ''}
          </div>
        </div>
        <div className="card metric">
          <div className="label">Holding stock</div>
          <div className="value">{held.size}</div>
          <div className="sub">Areas with something in them</div>
        </div>
        <div className="card metric">
          <div className="label">Value stored</div>
          <div className="value">{inr(totalValue)}</div>
          <div className="sub">Across every area, packing material included</div>
        </div>
        <div className="card metric">
          <div className="label">Transfers</div>
          <div className="value">{moves.length}</div>
          <div className="sub">Moves between areas</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div>
            <h3>Where new stock goes</h3>
            <span>
              The storage area each form starts on. Whoever posts can still pick a different one.
            </span>
          </div>
        </div>
        {/* Four kinds of stock: four across on a wide screen, stacked on a phone. */}
        <div
          className="form-grid"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
        >
          {AREA_PURPOSES.map((p) => {
            const current = defaultArea(state, p.key)
            const options = allowedAreas(state, p.itemType)
            const kind = itemTypeLabel(p.itemType).toLowerCase()
            return (
              <div className="field" key={p.key}>
                <label>{p.label}</label>
                <Select
                  value={current?.id || ''}
                  onChange={(e) => {
                    if (e.target.value) setDefaultArea(p.key, e.target.value)
                  }}
                >
                  <option value="">
                    {options.length ? 'Not set — the form will ask' : `No active area can take ${kind}`}
                  </option>
                  {options.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} · {storageTypeLabel(s.type)}
                      {roomSuits(p.itemType, s.type) ? '' : ` — not usually for ${kind}`}
                    </option>
                  ))}
                </Select>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-head">
          <div>
            <h3>Storage areas</h3>
            <span>Every place stock can sit. What an area is decides what may go into it.</span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" type="button" onClick={openAdd}>
              + Add storage area
            </button>
          </div>
        </div>

        <div className="note">
          {STORAGE_TYPES.map((t) => (
            <div key={t.value}>
              <b>{t.label}.</b> {t.blurb}
            </div>
          ))}
        </div>

        <div className="vendors-toolbar">
          <div className="type-tabs" role="tablist">
            <button
              type="button"
              className={`type-tab ${typeFilter === '' ? 'active' : ''}`}
              onClick={() => setTypeFilter('')}
            >
              All areas
            </button>
            {STORAGE_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`type-tab ${typeFilter === t.value ? 'active' : ''}`}
                onClick={() => setTypeFilter(t.value)}
              >
                {t.plural}
              </button>
            ))}
          </div>
          <input
            className="vendors-search"
            placeholder="Search storage areas"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {!areas.length ? (
          <div className="empty vendors-empty">
            <EmptyState
              filtered={!!search || !!typeFilter}
              empty="No storage areas yet. Add one and it becomes a place stock can be put away or moved into."
              onClear={() => {
                setSearch('')
                setTypeFilter('')
              }}
            />
          </div>
        ) : (
          <div className="vendor-grid">
            {areas.map((s) => {
              const inside = held.get(s.name)
              const open = expanded === s.id
              const purposes = defaultsOf(state, s)
              const blocker = areaDeleteBlocker(state, s)
              return (
                <article className="vendor-card room-card" key={s.id}>
                  <div className="vendor-card-top">
                    <div className="vendor-card-title">
                      <h4>{s.label}</h4>
                      <div className="small">{s.holds || storageTypeLabel(s.type)}</div>
                    </div>
                    <StatusBadge value={s.status} />
                  </div>
                  <div className="vendor-meta">
                    <div>
                      <span className="meta-label">Type</span>
                      <b>{storageTypeLabel(s.type)}</b>
                    </div>
                    <div>
                      <span className="meta-label">On hand</span>
                      <b>{inside ? fmtRowTotal(inside.rows) : 'Empty'}</b>
                    </div>
                    <div>
                      <span className="meta-label">Value</span>
                      <b>{inr(inside?.value || 0)}</b>
                    </div>
                  </div>
                  {purposes.length ? (
                    <div className="small">
                      Default for {purposes.map((p) => p.label.toLowerCase()).join(', ')}
                    </div>
                  ) : null}

                  {/* A four-column table inside a 350px card clipped its own Move
                      button. A stacked list carries the same detail and fits. */}
                  {open && inside ? (
                    <div className="room-stock">
                      {inside.rows.map((r) => (
                        <div className="room-stock-row" key={stockRowKey(r)}>
                          <div>
                            <b>{getItemName(r.item)}</b>
                            <div className="small">
                              {stockIdOfRow(state, r)} · {itemTypeLabel(r.itemType)} ·{' '}
                              {statusLabel(r.status)}
                            </div>
                            <div className="small">
                              {fmtQty(r.qty)} {r.uom} · {inr(r.value)}
                            </div>
                            {!roomSuits(r.itemType, s.type, r.status) ? (
                              <div className="small">
                                <b>Not usually kept in a {storageTypeLabel(s.type).toLowerCase()}</b>
                              </div>
                            ) : null}
                          </div>
                          <button className="btn btn-light" type="button" onClick={() => setMoving(r)}>
                            Move
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="row-actions">
                    <button
                      className="btn btn-light"
                      type="button"
                      disabled={!inside}
                      onClick={() => setExpanded(open ? '' : s.id)}
                    >
                      {open ? 'Hide stock' : "See what's inside"}
                    </button>
                    <button className="btn btn-light" type="button" onClick={() => openEdit(s)}>
                      Edit
                    </button>
                    {s.status === 'Active' ? (
                      <button
                        className="btn btn-light"
                        type="button"
                        onClick={() =>
                          inside
                            ? setConfirming({ kind: 'deactivate', area: s })
                            : setStorageLocationStatus(s.id, 'Inactive')
                        }
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        className="btn btn-light"
                        type="button"
                        onClick={() => setStorageLocationStatus(s.id, 'Active')}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      className="btn btn-danger"
                      type="button"
                      disabled={!!blocker}
                      title={blocker || undefined}
                      onClick={() => setConfirming({ kind: 'delete', area: s })}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h3>Transfer history</h3>
            <span>Every move between storage areas, newest first</span>
          </div>
          <div className="section-head-actions">
            <Select value={historyArea} onChange={(e) => setHistoryArea(e.target.value)}>
              <option value="">All storage areas</option>
              {state.storageLocations.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.label}
                  {s.status !== 'Active' ? ' (inactive)' : ''}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Stock ID</th>
                <th>Item</th>
                <th className="cell-num">Quantity</th>
                <th>From</th>
                <th>To</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {!shownMoves.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    <EmptyState
                      filtered={!!historyArea}
                      empty="Nothing has been moved between areas yet."
                      onClear={() => setHistoryArea('')}
                    />
                  </td>
                </tr>
              ) : (
                shownMoves.map((m) => (
                  <tr key={m.doc}>
                    <td data-label="When">{fmtDate(m.time)}</td>
                    <td data-label="Stock ID" className="cell-id">
                      {m.stockId}
                    </td>
                    <td data-label="Item">{m.item}</td>
                    <td data-label="Quantity" className="cell-num">
                      {fmtQty(m.qty)} {m.uom}
                    </td>
                    <td data-label="From">{m.from}</td>
                    <td data-label="To">{m.to}</td>
                    <td data-label="Status">{statusLabel(m.status)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={openLoc}
        title={editLoc ? 'Edit storage area' : 'Add storage area'}
        saveLabel={editLoc ? 'Save changes' : 'Add area'}
        onClose={() => setOpenLoc(false)}
        onSave={() => {
          const input = { label: loc.label, holds: loc.holds, type: loc.type as StorageType }
          const ok = editLoc ? updateStorageLocation(editLoc, input) : addStorageLocation(input)
          if (ok) setOpenLoc(false)
        }}
      >
        <div className="form-grid">
          <div className="field span-2">
            <label>Name</label>
            <input
              value={loc.label}
              placeholder="e.g. Chest Freezer 2, Cold Room A"
              onChange={(e) => setLoc((l) => ({ ...l, label: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Type</label>
            <Select
              value={loc.type}
              onChange={(e) => setLoc((l) => ({ ...l, type: e.target.value as StorageType | '' }))}
            >
              <option value="">Select type</option>
              {STORAGE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="field span-3">
            <label>What it is for</label>
            <input
              value={loc.holds}
              placeholder="Shown when someone picks where stock goes"
              onChange={(e) => setLoc((l) => ({ ...l, holds: e.target.value }))}
            />
          </div>
        </div>
        {loc.type ? (
          <div className="note">{STORAGE_TYPES.find((t) => t.value === loc.type)?.blurb}</div>
        ) : null}
        <div className="note warning-note" style={{ marginTop: 12 }}>
          Renaming is always safe — stock stays where it is. An area that has ever held stock can't
          be deleted; deactivate it to stop new stock going in.
        </div>
      </Modal>

      <Modal
        open={!!confirming}
        title={
          confirming
            ? `${confirming.kind === 'delete' ? 'Delete' : 'Deactivate'} ${confirming.area.label}?`
            : ''
        }
        saveLabel={confirming?.kind === 'delete' ? 'Delete area' : 'Deactivate area'}
        onClose={() => setConfirming(null)}
        onSave={() => {
          if (!confirming) return
          if (confirming.kind === 'delete') deleteStorageLocation(confirming.area.id)
          else setStorageLocationStatus(confirming.area.id, 'Inactive')
          setConfirming(null)
        }}
      >
        <div className="note">
          {confirming?.kind === 'delete'
            ? `${confirming.area.label} has never held stock, so nothing is lost. This cannot be undone.`
            : `${confirming?.area.label || 'This area'} still holds ${fmtRowTotal(
                held.get(confirming?.area.name || '')?.rows || [],
              )}. Deactivating stops new stock going into it; what is already inside stays until you move it out from its card.`}
        </div>
      </Modal>

      <MoveStockModal row={moving} onClose={() => setMoving(null)} />
    </div>
  )
}
