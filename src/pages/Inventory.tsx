import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import {
  fmtRowTotal,
  itemTypeLabel,
  locationLabel,
  moveDestinations,
  roomSuits,
  stockRowKey,
  storageTypeLabel,
} from '../lib/stock'
import { resolveStockId, stockIdOfRow, stockOrigin } from '../lib/stockIds'
import { fmtDate, fmtQty, inr, QTY_EPSILON } from '../lib/utils'
import type { StockRow, StorageLocation, StorageType } from '../types'

/** One storage area with what it is holding folded in. */
type LocationRow = StorageLocation & { qty: number; value: number; byUom: Map<string, number> }

/** "220 L · 30 kg" — one figure per unit, never a sum across two of them. */
const onHandLabel = (s: { byUom: Map<string, number>; qty: number }) => {
  const parts = [...s.byUom]
    .filter(([, qty]) => qty > QTY_EPSILON)
    .map(([uom, qty]) => `${Number(qty.toFixed(2))} ${uom === 'Litre' ? 'L' : uom}`)
  return parts.length ? parts.join(' · ') : '0'
}

export function Inventory() {
  const { state, rows, getItemName, moveStock, exportData } = useApp()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [type, setType] = useState('')
  const [place, setPlace] = useState('')
  const [moving, setMoving] = useState<StockRow | null>(null)
  const [move, setMove] = useState({ to: '', qty: 0, note: '' })

  const nonPmRows = useMemo(() => rows.filter((r) => r.itemType !== 'Packing Material'), [rows])

  const cards = [
    [
      'Raw Material Value',
      nonPmRows.filter((r) => r.itemType === 'Raw Material').reduce((a, b) => a + b.value, 0),
    ],
    [
      'Bulk Value',
      nonPmRows.filter((r) => r.itemType === 'Semi Finished').reduce((a, b) => a + b.value, 0),
    ],
    [
      'Finished Goods Value',
      nonPmRows.filter((r) => r.itemType === 'Finished Goods').reduce((a, b) => a + b.value, 0),
    ],
    ['Total Stock Value', nonPmRows.reduce((a, b) => a + b.value, 0)],
  ] as const

  /**
   * What each storage location is currently holding, freezers first. Quantities are
   * kept per unit rather than added together: a store holding juice and malai was
   * reporting "967.50" with no unit, which is litres and kilograms in one number and
   * means nothing.
   */
  const byLocation: LocationRow[] = useMemo(() => {
    const held = new Map<string, { qty: number; value: number; byUom: Map<string, number> }>()
    for (const r of nonPmRows) {
      const acc = held.get(r.location) || { qty: 0, value: 0, byUom: new Map<string, number>() }
      acc.qty += r.qty
      acc.value += r.value
      acc.byUom.set(r.uom, (acc.byUom.get(r.uom) || 0) + r.qty)
      held.set(r.location, acc)
    }
    return state.storageLocations
      .filter((s) => s.status === 'Active' || held.has(s.name))
      .map((s) => ({
        ...s,
        ...(held.get(s.name) || { qty: 0, value: 0, byUom: new Map<string, number>() }),
      }))
      // A cold room is worth listing even when it is empty — an empty freezer is news.
      .filter((s) => s.qty > 0 || s.type === 'Cold Room')
      .sort((a, b) => (a.type === b.type ? 0 : a.type === 'Cold Room' ? -1 : 1))
  }, [nonPmRows, state.storageLocations])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return nonPmRows.filter(
      (r) =>
        (!type || r.itemType === type) &&
        (!place || r.location === place) &&
        [stockIdOfRow(state, r), r.item, r.lot, r.status, locationLabel(state, r.location), getItemName(r.item)]
          .join(' ')
          .toLowerCase()
          .includes(q),
    )
  }, [getItemName, nonPmRows, place, search, state, type])

  /**
   * One line per item of stock, keyed by its own stock ID.
   *
   * Stock was listed by product code — first one line per stock row with the code as
   * its heading, then one line per product with batches underneath — and either way the
   * code was the key. But a product is not stock: six batches of coconut water are six
   * items, each with its own lot, its own QC verdict and its own chain back to a farmer.
   * Every line is now an item, named by the stock ID printed on it and handed as-is to
   * Traceability. The product is what it is, not what it is called.
   *
   * An item split across two rooms, or half released, is still one item: its places
   * open underneath it.
   */
  const stock = useMemo(() => {
    const by = new Map<string, StockRow[]>()
    for (const r of filtered) {
      const id = stockIdOfRow(state, r)
      by.set(id, [...(by.get(id) || []), r])
    }
    const order = ['Raw Material', 'Semi Finished', 'Finished Goods']
    return [...by.entries()]
      .map(([stockId, places]) => {
        const ref = resolveStockId(state, stockId)
        return {
          stockId,
          item: places[0].item,
          itemType: places[0].itemType,
          places,
          value: places.reduce((a, p) => a + p.value, 0),
          origin: ref ? stockOrigin(state, ref) : undefined,
        }
      })
      .sort(
        (a, b) =>
          order.indexOf(a.itemType) - order.indexOf(b.itemType) ||
          getItemName(a.item).localeCompare(getItemName(b.item)) ||
          (b.origin?.when || '').localeCompare(a.origin?.when || '') ||
          a.stockId.localeCompare(b.stockId),
      )
  }, [filtered, getItemName, state])

  const openMove = (r: StockRow) => {
    setMoving(r)
    setMove({ to: '', qty: r.qty, note: '' })
  }

  /** See HOME_TYPES in lib/stock — shared with the Storage page so the two Move
   *  dialogs cannot drift apart. */
  const suits = (type: StorageType) => !moving || roomSuits(moving.itemType, type)

  const destinations = useMemo(
    () => (moving ? moveDestinations(state, moving.location, moving.itemType) : []),
    [state, moving],
  )

  const movingToOddPlace = destinations.find((s) => s.name === move.to && !suits(s.type))

  return (
    <>
      <div className="grid grid-4">
        {cards.map(([label, value]) => (
          <div className="card metric" key={label}>
            <div className="label">{label}</div>
            <div className="value">{inr(value)}</div>
            <div className="sub">Ledger-derived</div>
          </div>
        ))}
      </div>

      {byLocation.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-head">
            <div>
              <h3>Storage areas</h3>
              <span>Where stock is physically sitting right now</span>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Type</th>
                  <th>On Hand</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {byLocation.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Area">
                      <b>{s.label}</b>
                      <div className="cell-sub">{s.holds || storageTypeLabel(s.type)}</div>
                      {s.status !== 'Active' && <div className="cell-sub">Inactive</div>}
                    </td>
                    <td data-label="Type">{storageTypeLabel(s.type)}</td>
                    <td data-label="On Hand">{onHandLabel(s)}</td>
                    <td data-label="Value">{inr(s.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-head">
          <div>
            <h3>Stock Snapshot</h3>
            <span>
              Raw material, bulk and finished goods, added up from the stock ledger.
              Packing material has its own page.
            </span>
          </div>
          <div className="section-head-actions">
            <button className="btn btn-light" onClick={exportData}>
              Back up all data
            </button>
          </div>
        </div>
        <div className="toolbar">
          <input
            placeholder="Search stock ID, product, batch or lot"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All item types</option>
            <option>Raw Material</option>
            <option value="Semi Finished">Bulk</option>
            <option>Finished Goods</option>
          </Select>
          <Select value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">All locations</option>
            {state.storageLocations.map((s) => (
              <option key={s.id} value={s.name}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stock ID</th>
                <th>Product</th>
                <th>From</th>
                <th>Where</th>
                <th className="cell-num cell-tight">On hand</th>
                <th className="cell-num cell-tight">Value</th>
                <th className="cell-actions">Action</th>
              </tr>
            </thead>
            <tbody>
              {!stock.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    <EmptyState
                      filtered={!!search || !!type || !!place}
                      empty="No stock records."
                      onClear={() => {
                        setSearch('')
                        setType('')
                        setPlace('')
                      }}
                    />
                  </td>
                </tr>
              ) : (
                stock.map((s) => {
                  const single = s.places.length === 1 ? s.places[0] : undefined
                  const expanded = !!open[s.stockId]
                  return [
                    <tr key={s.stockId}>
                      <td data-label="Stock ID" className="cell-id">
                        <b>{s.stockId}</b>
                        {s.origin?.when ? (
                          <div className="cell-sub">
                            {s.origin.verb} {fmtDate(s.origin.when)}
                          </div>
                        ) : null}
                      </td>
                      <td data-label="Product">
                        <div>{getItemName(s.item)}</div>
                        <div className="cell-sub">{itemTypeLabel(s.itemType)}</div>
                      </td>
                      <td data-label="From" className="cell-id">
                        <DocLink doc={s.origin?.doc} label={s.origin?.from} />
                      </td>
                      <td data-label="Where">
                        {single ? (
                          <>
                            {locationLabel(state, single.location)}
                            <div className="cell-sub">
                              <StatusBadge value={single.status} />
                              {single.expiry ? ` · best before ${fmtDate(single.expiry)}` : ''}
                            </div>
                          </>
                        ) : (
                          <button
                            className="link-button"
                            type="button"
                            onClick={() => setOpen((o) => ({ ...o, [s.stockId]: !expanded }))}
                          >
                            {expanded ? 'Hide places' : `In ${s.places.length} places`}
                          </button>
                        )}
                      </td>
                      <td data-label="On hand" className="cell-num cell-tight">
                        {fmtRowTotal(s.places)}
                      </td>
                      <td data-label="Value" className="cell-num cell-tight">
                        {inr(s.value)}
                      </td>
                      <td className="cell-actions">
                        <div className="row-actions">
                          <button
                            className="btn btn-light"
                            type="button"
                            onClick={() =>
                              navigate(`/traceability?q=${encodeURIComponent(s.stockId)}`)
                            }
                          >
                            Trace
                          </button>
                          {single ? (
                            <button
                              className="btn btn-light"
                              type="button"
                              onClick={() => openMove(single)}
                            >
                              Move
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>,
                    !single && expanded ? (
                      <tr key={`${s.stockId}-places`} className="subrow">
                        <td colSpan={7}>
                          <div className="room-stock">
                            {s.places.map((r) => (
                              <div className="room-stock-row" key={stockRowKey(r)}>
                                <div>
                                  <b>{locationLabel(state, r.location)}</b>
                                  <div className="small">
                                    <StatusBadge value={r.status} />
                                    {r.expiry ? ` · best before ${fmtDate(r.expiry)}` : ''}
                                  </div>
                                  <div className="small">
                                    {fmtQty(r.qty)} {r.uom} at {inr(r.unitCost)} · {inr(r.value)}
                                  </div>
                                </div>
                                <button
                                  className="btn btn-light"
                                  type="button"
                                  onClick={() => openMove(r)}
                                >
                                  Move
                                </button>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ]
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

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
            // Two runs off one batch into one cold room are two rows under two dates;
            // without it the move could not find a finished-goods row at all.
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
            <input value={moving ? locationLabel(state, moving.location) : ''} disabled />
          </div>
          <div className="field">
            <label>Move to</label>
            <Select value={move.to} onChange={(e) => setMove((m) => ({ ...m, to: e.target.value }))}>
              <option value="">Select destination</option>
              {destinations.map((s) => (
                <option key={s.id} value={s.name}>
                  {s.label} · {storageTypeLabel(s.type)}
                  {suits(s.type) ? '' : ` — not usually for ${itemTypeLabel(moving?.itemType || '')}`}
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
          {movingToOddPlace ? (
            <div className="field span-3">
              <div className="note warning-note">
                {movingToOddPlace.label} normally holds {movingToOddPlace.holds.toLowerCase()}, not{' '}
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
              placeholder="e.g. moved to the overflow freezer"
            />
          </div>
        </div>
        <div className="note">
          A move relocates stock without revaluing it — the unit cost travels with the packs.
          Released packs are dispatched out of whichever freezer they are sitting in.
        </div>
      </Modal>
    </>
  )
}
