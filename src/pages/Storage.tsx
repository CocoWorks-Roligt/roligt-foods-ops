/**
 * Storage — every area the plant keeps stock in, what is sitting in each, and every
 * move between them.
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
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import {
  STORAGE_TYPES,
  itemTypeLabel,
  locationLabel,
  moveDestinations,
  roomSuits,
  rowKey,
  storageTypeLabel,
} from '../lib/stock'
import { stockIdOfRow } from '../lib/stockIds'
import { fmtDate, fmtQty, inr, QTY_EPSILON } from '../lib/utils'
import type { StockRow, StorageLocation, StorageType } from '../types'

const blankArea = {
  label: '',
  holds: '',
  type: 'Cold Room' as StorageType,
}

export function Storage() {
  const {
    state,
    rows,
    getItemName,
    moveStock,
    addStorageLocation,
    updateStorageLocation,
    setStorageLocationStatus,
    deleteStorageLocation,
  } = useApp()

  const [openLoc, setOpenLoc] = useState(false)
  const [editLoc, setEditLoc] = useState('')
  const [loc, setLoc] = useState(blankArea)
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState('')
  const [moving, setMoving] = useState<StockRow | null>(null)
  const [move, setMove] = useState({ to: '', qty: 0, note: '' })

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
        lot: p.in!.lot,
        item: getItemName(p.in!.item),
        qty: p.in!.qtyIn,
        uom: p.in!.uom,
        from: locationLabel(state, p.out!.location),
        to: locationLabel(state, p.in!.location),
      }))
      .sort((a, b) => b.time.localeCompare(a.time))
  }, [getItemName, state])

  const areas = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.storageLocations
      .filter(
        (s) =>
          (!typeFilter || s.type === typeFilter) &&
          (!q || [s.label, s.holds, s.type].join(' ').toLowerCase().includes(q)),
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
    setLoc({ ...blankArea, type: (typeFilter as StorageType) || 'Cold Room' })
    setOpenLoc(true)
  }

  const startMove = (r: StockRow) => {
    setMoving(r)
    setMove({ to: '', qty: r.qty, note: '' })
  }

  const destinations = useMemo(
    () => (moving ? moveDestinations(state, moving.location, moving.itemType) : []),
    [state, moving],
  )
  const oddPlace = destinations.find(
    (s) => s.name === move.to && moving && !roomSuits(moving.itemType, s.type),
  )

  const active = state.storageLocations.filter((s) => s.status === 'Active')
  const totalValue = [...held.values()].reduce((a, b) => a + b.value, 0)
  const countOf = (type: StorageType) => active.filter((s) => s.type === type).length

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card metric">
          <div className="label">Storage areas</div>
          <div className="value">{active.length}</div>
          <div className="sub">
            {STORAGE_TYPES.map((t) => `${countOf(t.value)} ${t.label.toLowerCase()}`).join(' · ')}
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
          <div className="sub">Across every area</div>
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
            <h3>Storage areas</h3>
            <span>
              One list of everywhere stock can sit. What an area is — cold room, dry store or
              hold — decides what belongs in it.
            </span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-primary" type="button" onClick={openAdd}>
              + Add storage area
            </button>
          </div>
        </div>

        <div className="note">
          Bulk from production — juice, coconut water, malai, a blended melange — is unsealed and
          perishable, so it may only be kept in a <b>cold room</b>. Finished packs go into a cold
          room off the line and are dispatched straight out of it. Produce and packing material
          wait in a <b>dry store</b>. A <b>hold area</b> is for stock set aside: rejected by QC, or
          waiting on a decision.
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
                {t.label}s
              </button>
            ))}
          </div>
          <input
            className="vendors-search"
            placeholder="Search area"
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
              return (
                <article className="vendor-card room-card" key={s.id}>
                  <div className="vendor-card-top">
                    <div className="vendor-card-title">
                      <h4>{s.label}</h4>
                      <div className="small">{s.holds || 'No description'}</div>
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
                      <b>
                        {inside
                          ? `${inside.rows.length} line${inside.rows.length === 1 ? '' : 's'}`
                          : 'Empty'}
                      </b>
                    </div>
                    <div>
                      <span className="meta-label">Value</span>
                      <b>{inr(inside?.value || 0)}</b>
                    </div>
                  </div>

                  {/* A four-column table inside a 350px card clipped its own Move
                      button. A stacked list carries the same detail and fits. */}
                  {open && inside ? (
                    <div className="room-stock">
                      {inside.rows.map((r) => (
                        <div className="room-stock-row" key={rowKey(r)}>
                          <div>
                            <b>{getItemName(r.item)}</b>
                            <div className="small">
                              {stockIdOfRow(state, r)} · {itemTypeLabel(r.itemType)} · {r.status}
                            </div>
                            <div className="small">
                              {fmtQty(r.qty)} {r.uom} · {inr(r.value)}
                            </div>
                          </div>
                          <button
                            className="btn btn-light"
                            type="button"
                            onClick={() => startMove(r)}
                          >
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
                    <button
                      className="btn btn-light"
                      type="button"
                      onClick={() =>
                        setStorageLocationStatus(s.id, s.status === 'Active' ? 'Inactive' : 'Active')
                      }
                    >
                      {s.status === 'Active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete ${s.label}?`)) deleteStorageLocation(s.id)
                      }}
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
            <span>Every move between areas, newest first</span>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Item</th>
                <th>Lot / Batch</th>
                <th className="cell-num">Quantity</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {!moves.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    <EmptyState
                      filtered={false}
                      empty="Nothing has been moved between areas yet."
                      onClear={() => {}}
                    />
                  </td>
                </tr>
              ) : (
                moves.map((m) => (
                  <tr key={m.doc}>
                    <td data-label="When">{fmtDate(m.time)}</td>
                    <td data-label="Item">{m.item}</td>
                    <td data-label="Lot / Batch">{m.lot}</td>
                    <td data-label="Quantity" className="cell-num">
                      {fmtQty(m.qty)} {m.uom}
                    </td>
                    <td data-label="From">{m.from}</td>
                    <td data-label="To">{m.to}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={openLoc}
        title={editLoc ? `Edit ${loc.label || 'storage area'}` : 'Add storage area'}
        saveLabel={editLoc ? 'Save Changes' : 'Add area'}
        onClose={() => setOpenLoc(false)}
        onSave={() => {
          const ok = editLoc ? updateStorageLocation(editLoc, loc) : addStorageLocation(loc)
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
              onChange={(e) => setLoc((l) => ({ ...l, type: e.target.value as StorageType }))}
            >
              {STORAGE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="field span-3">
            <label>What it holds</label>
            <input
              value={loc.holds}
              placeholder="One line the floor will read on a dropdown"
              onChange={(e) => setLoc((l) => ({ ...l, holds: e.target.value }))}
            />
          </div>
        </div>
        <div className="note">{STORAGE_TYPES.find((t) => t.value === loc.type)?.blurb}</div>
        <div className="note warning-note" style={{ marginTop: 12 }}>
          Renaming is always safe — the ledger tracks each area by a hidden key, so stock stays
          put. An area holding stock cannot be deleted; deactivate it to stop new stock going in.
          {loc.type !== 'Cold Room'
            ? ' Bulk from production cannot be put away here — only a cold room may hold it.'
            : ''}
        </div>
      </Modal>

      <Modal
        open={!!moving}
        title={moving ? `Move ${moving.item} · ${moving.lot}` : 'Move stock'}
        saveLabel="Move Stock"
        onClose={() => setMoving(null)}
        onSave={() => {
          if (!moving) return
          const ok = moveStock({
            item: moving.item,
            lot: moving.lot,
            status: moving.status,
            from: moving.location,
            expiry: moving.expiry,
            to: move.to,
            qty: move.qty,
            note: move.note,
          })
          if (ok) setMoving(null)
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>From</label>
            <div className="field-fixed">{moving ? locationLabel(state, moving.location) : ''}</div>
          </div>
          <div className="field">
            <label>Move to</label>
            <Select value={move.to} onChange={(e) => setMove((m) => ({ ...m, to: e.target.value }))}>
              <option value="">Select destination</option>
              {destinations.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.label} · {storageTypeLabel(s.type)}
                  {moving && !roomSuits(moving.itemType, s.type)
                    ? ` — not usually for ${itemTypeLabel(moving.itemType)}`
                    : ''}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Quantity (max {moving?.qty.toFixed(2) || 0})</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={move.qty}
              onChange={(e) => setMove((m) => ({ ...m, qty: Number(e.target.value) }))}
            />
          </div>
          {oddPlace ? (
            <div className="field span-3">
              <div className="note warning-note">
                {oddPlace.label} normally holds {oddPlace.holds.toLowerCase()}, not{' '}
                {itemTypeLabel(moving?.itemType || '').toLowerCase()}. The move is allowed — just
                check it is the shelf you meant.
              </div>
            </div>
          ) : null}
          <div className="field span-3">
            <label>Note (optional)</label>
            <input
              value={move.note}
              onChange={(e) => setMove((m) => ({ ...m, note: e.target.value }))}
              placeholder="e.g. consolidated onto one pallet"
            />
          </div>
        </div>
        <div className="note">
          A move relocates stock without revaluing it — the unit cost travels with it. What
          decides whether packs can go out is the QC verdict, not the area they sit in.
          {moving && moving.itemType === 'Semi Finished'
            ? ' Bulk can only be moved between cold rooms, so that is all this list offers.'
            : ''}
        </div>
      </Modal>
    </div>
  )
}
