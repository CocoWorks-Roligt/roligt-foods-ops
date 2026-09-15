/**
 * Moving stock from one storage area to another — the one dialog both the Storage and the
 * Inventory page open.
 *
 * Each page used to have its own, and the two had drifted: the title was the item code
 * and lot, neither said what unit the quantity was in, one called the destination a
 * "shelf" and the other a "freezer", and the warning about an unusual area was built
 * from a description that could be blank.
 */

import { useMemo, useState } from 'react'
import { Modal } from './Modal'
import { Select } from './Select'
import { useApp } from '../context/AppContext'
import {
  areaChoices,
  displayExpiry,
  itemTypeLabel,
  locationLabel,
  needsColdRoom,
  roomSuits,
  stockRowKey,
  storageTypeLabel,
} from '../lib/stock'
import { stockIdOfRow } from '../lib/stockIds'
import { fmtDate, fmtQty, statusLabel } from '../lib/utils'
import type { StockRow } from '../types'

export function MoveStockModal({ row, onClose }: { row: StockRow | null; onClose: () => void }) {
  // Keyed by the row, so opening the dialog for another item starts from a clean form.
  return row ? <MoveStockForm key={stockRowKey(row)} row={row} onClose={onClose} /> : null
}

function MoveStockForm({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const { state, getItemName, moveStock } = useApp()
  const [to, setTo] = useState('')
  const [qty, setQty] = useState(Math.round(row.qty * 100) / 100)
  const [note, setNote] = useState('')

  const from = state.storageLocations.find((s) => s.name === row.location)
  const choices = useMemo(
    () => areaChoices(state, row.itemType, row.status).filter((c) => c.value !== row.location),
    [row, state],
  )
  const picked = choices.find((c) => c.value === to)?.area
  const unusual = picked && !roomSuits(row.itemType, picked.type, row.status) ? picked : undefined
  const expiry = displayExpiry(state, row)
  const kind = itemTypeLabel(row.itemType).toLowerCase()

  return (
    <Modal
      open
      title={`Move ${getItemName(row.item)} — ${stockIdOfRow(state, row)}`}
      saveLabel="Move stock"
      onClose={onClose}
      onSave={() => {
        const ok = moveStock({
          item: row.item,
          lot: row.lot,
          status: row.status,
          from: row.location,
          // Two runs off one batch into one cold room are two rows under two dates;
          // without it the move could not find a finished-goods row at all.
          expiry: row.expiry,
          to,
          qty,
          note,
        })
        if (ok) onClose()
      }}
    >
      <div className="form-grid">
        <div className="field">
          <label>From</label>
          <div className="field-fixed">
            {locationLabel(state, row.location)}
            {from ? ` · ${storageTypeLabel(from.type)}` : ''}
          </div>
        </div>
        <div className="field">
          <label>Stock</label>
          <div className="field-fixed">
            {statusLabel(row.status)}
            {expiry ? ` · best before ${fmtDate(expiry)}` : ''}
          </div>
        </div>
        <div className="field">
          <label>Quantity to move ({row.uom})</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
          <div className="small">
            {fmtQty(row.qty)} {row.uom} on hand
          </div>
        </div>
        <div className="field span-3">
          <label>Move to</label>
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">
              {choices.length ? 'Select storage area' : 'No other storage area can take this stock'}
            </option>
            {choices.map((c) => (
              <option key={c.area.id} value={c.value}>
                {c.text}
              </option>
            ))}
          </Select>
        </div>
        {unusual ? (
          <div className="field span-3">
            <div className="note warning-note">
              {unusual.label} is a {storageTypeLabel(unusual.type).toLowerCase()}, and {kind} is not
              usually kept in one. The move is allowed — check it is the area you meant.
            </div>
          </div>
        ) : null}
        <div className="field span-3">
          <label>Note (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. consolidated onto one pallet"
          />
        </div>
      </div>
      <div className="note">
        A move changes where stock sits — not its cost, and not its QC status.
        {needsColdRoom(row.itemType)
          ? ' Bulk can only go into a cold room, or into a hold area once QC has rejected it.'
          : ''}
        {row.status === 'Rejected'
          ? ' Rejected stock can be set aside in a hold area.'
          : ' Only stock QC has rejected can go into a hold area.'}
      </div>
    </Modal>
  )
}
