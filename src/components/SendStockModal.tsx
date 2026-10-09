/**
 * Sending stock off the production floor — to the lab for testing, or to NPD.
 *
 * One dialog, two destinations, because to the person holding the jug it is one
 * decision: where is this sample going. What happens on the books differs:
 *  - Testing books it out as a "Lab / testing" stock issue against the lot. The lab
 *    consumes it; nothing comes back and there is nothing more to record.
 *  - NPD moves it into an NPD area under the NPD status. It stays on the books,
 *    out of production's reach, until NPD records what it used it for.
 *
 * Any status can go except Rejected (QC has said it is not fit — Stock Issues writes it
 * off) and stock NPD already holds.
 */

import { useState } from 'react'
import { Modal } from './Modal'
import { Select } from './Select'
import { useApp } from '../context/AppContext'
import { npdAreas } from '../lib/npd'
import { displayExpiry, locationLabel, stockRowKey } from '../lib/stock'
import { stockIdOfRow } from '../lib/stockIds'
import { fmtDate, fmtQty, statusLabel, toLocalInputValue } from '../lib/utils'
import type { StockRow } from '../types'

type Destination = 'testing' | 'npd'

export function SendStockModal({ row, onClose }: { row: StockRow | null; onClose: () => void }) {
  // Keyed by the row, so opening it for another lot starts from a clean form.
  return row ? <SendStockForm key={stockRowKey(row)} row={row} onClose={onClose} /> : null
}

function SendStockForm({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const { state, getItemName, createStockIssue, sendToNpd } = useApp()
  const areas = npdAreas(state)
  const [to, setTo] = useState<Destination>('testing')
  const [qty, setQty] = useState(Math.round(row.qty * 100) / 100)
  const [area, setArea] = useState(areas[0]?.name || '')
  const [recipient, setRecipient] = useState('')
  const [note, setNote] = useState('')
  const expiry = displayExpiry(state, row)

  const save = () => {
    const ok =
      to === 'testing'
        ? createStockIssue({
            date: toLocalInputValue(),
            reason: 'Lab / testing',
            recipient,
            notes: note,
            lines: [
              {
                item: row.item,
                lot: row.lot,
                location: row.location,
                status: row.status,
                expiry: row.expiry,
                qty,
              },
            ],
          })
        : sendToNpd({
            item: row.item,
            lot: row.lot,
            location: row.location,
            status: row.status,
            expiry: row.expiry,
            qty,
            to: area,
            note,
          })
    if (ok) onClose()
  }

  return (
    <Modal
      open
      title={`Send ${getItemName(row.item)} — ${stockIdOfRow(state, row)}`}
      saveLabel={to === 'testing' ? 'Send to testing' : 'Send to NPD'}
      onClose={onClose}
      onSave={save}
    >
      <div className="form-grid">
        <div className="field">
          <label>Send to</label>
          <Select value={to} onChange={(e) => setTo(e.target.value as Destination)}>
            <option value="testing">Testing (lab)</option>
            <option value="npd">NPD</option>
          </Select>
        </div>
        <div className="field">
          <label>From</label>
          <div className="field-fixed">
            {locationLabel(state, row.location)} · {statusLabel(row.status)}
            {expiry ? ` · best before ${fmtDate(expiry)}` : ''}
          </div>
        </div>
        <div className="field">
          <label>Quantity ({row.uom})</label>
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
        {to === 'testing' ? (
          <div className="field span-3">
            <label>Lab / tested by (optional)</label>
            <input
              value={recipient}
              placeholder="In-house lab, external lab name"
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>
        ) : (
          <div className="field span-3">
            <label>NPD area</label>
            <Select value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">{areas.length ? 'Select NPD area' : 'No NPD area yet'}</option>
              {areas.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.label}
                  {a.holds ? ` — ${a.holds}` : ''}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="field span-3">
          <label>Note (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={to === 'testing' ? 'Which tests, sample reference' : 'What NPD asked for it for'}
          />
        </div>
      </div>
      {to === 'npd' && !areas.length ? (
        <div className="note warning-note">
          There is no NPD area yet. Add one on the Storage page with the type “NPD area”, then send.
        </div>
      ) : null}
      <div className="note">
        {to === 'testing'
          ? 'Booked out as a “Lab / testing” stock issue against this lot — it comes off the books now and shows on the Stock Issues page.'
          : 'Moved into the NPD area and out of production for good: nothing can pack, blend or dispatch it from there. NPD records what it used it for on the NPD page.'}
      </div>
    </Modal>
  )
}
