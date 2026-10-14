/**
 * The Storage put-away form (WORKFLOW W13, behind the pipeline flag) — a "Put
 * away" tab on Inventory. Stock already booked that sits somewhere the app's
 * own rules flag: an area that refuses it, a room the plant deactivated, or
 * just an unusual home. Queue offers the worst first; picking a row lays out
 * the SAME move the Inventory page's Move button posts.
 *
 * The write is moveStock — the SAME Classic path MoveStockModal uses. Its
 * refusals are its own toasts (a different destination, an active area, stock
 * that is no longer on hand, a quantity past what the row holds, an area that
 * may not take it); a null return leaves this form open. Destination options
 * and the unusual-destination warning are the dialog's own folds verbatim
 * (areaChoices / roomSuits) — never re-derived here.
 */
import { useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import {
  areaChoices,
  itemTypeLabel,
  locationLabel,
  needsColdRoom,
  roomSuits,
  storageTypeLabel,
} from '../lib/stock'
import { PUT_AWAY_TAG, putAwayRows } from '../lib/storageStage'
import { fmtDate, fmtQty } from '../lib/utils'

export function PutAwayTab() {
  const { state, getItemName, moveStock } = useApp()
  const [picked, setPicked] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [to, setTo] = useState('')
  const [qty, setQty] = useState(0)
  const [note, setNote] = useState('')

  const queue = useMemo(() => putAwayRows(state), [state])
  // The moved row folds out of the queue the moment its two ledger lines land
  // (a stock row keyed by place), so the queue is self-updating after a save.
  const current = queue.find((q) => q.key === picked)
  const row = current?.row

  const pick = (key: string) => {
    const found = queue.find((q) => q.key === key)
    setPicked(key)
    setScanNote('')
    setTo('')
    setNote('')
    // Put-away usually carries the whole row — the pallet leaves the room it
    // should not be in. The move's own check still bounds a smaller number.
    setQty(found ? Math.round(found.row.qty * 100) / 100 : 0)
  }

  const scanStock = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = queue.find(
      (q) =>
        q.stockId.toLowerCase() === wanted ||
        q.row.lot.toLowerCase() === wanted ||
        getItemName(q.row.item).toLowerCase() === wanted,
    )
    if (!found) {
      setScanNote(
        queue.length
          ? `Nothing in the put-away queue reads ${code}.`
          : `Nothing needs putting away — ${code} included.`,
      )
      return
    }
    pick(found.key)
  }

  // The dialog's own options fold: every area this stock may go into but its own.
  const choices = useMemo(
    () =>
      row
        ? areaChoices(state, row.itemType, row.status).filter((c) => c.value !== row.location)
        : [],
    [row, state],
  )
  const destination = choices.find((c) => c.value === to)?.area
  const unusualDestination =
    destination && row && !roomSuits(row.itemType, destination.type, row.status)
      ? destination
      : undefined
  const kind = row ? itemTypeLabel(row.itemType).toLowerCase() : ''

  const submit = () => {
    if (!row) return
    // moveStock posts the two Stock Transfer lines and toasts; on a refusal it
    // returns null and the form stays put with its words already on screen.
    const saved = moveStock({
      item: row.item,
      lot: row.lot,
      status: row.status,
      from: row.location,
      // Part of the row's identity — without it the move could not find a row
      // split across two dates. Handed through exactly as the dialog does.
      expiry: row.expiry,
      to,
      qty,
      note,
    })
    if (!saved) return
    // The queue re-folds without the moved row — offer the next worst seat.
    const next = queue.find((q) => q.key !== current?.key)
    pick(next ? next.key : '')
  }

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Put away</h2>
          <span className="cell-sub">
            Stock sitting where it should not be — an area that refuses it, a room that was
            deactivated, or an unusual home — worst first
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'queue',
            title: 'Needs putting away',
            hint: queue.length
              ? `${queue.length} row${queue.length === 1 ? '' : 's'} flagged where it sits`
              : undefined,
            children: (
              <div>
                {queue.length ? (
                  <>
                    <div className="form-grid">
                      <label className="span-2">
                        Stock
                        <Select value={picked} onChange={(e) => pick(e.target.value)}>
                          <option value="">Select stock</option>
                          {queue.map((q) => (
                            <option key={q.key} value={q.key}>
                              {getItemName(q.row.item)} · {q.stockId} ·{' '}
                              {locationLabel(state, q.row.location)} · {fmtQty(q.row.qty)}{' '}
                              {q.row.uom} · {PUT_AWAY_TAG[q.reason]}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </div>
                    <div style={{ marginTop: 8, maxWidth: 360 }}>
                      <ScanInput
                        label="Stock ID or lot"
                        onScan={scanStock}
                        placeholder="Scan or type a stock ID or lot"
                      />
                    </div>
                  </>
                ) : (
                  <p className="cell-sub">
                    Nothing needs putting away. A row lands here when it sits in an area the
                    rules refuse, a room that was deactivated, or somewhere its kind is not
                    usually kept — everywhere else, stock is where it belongs.
                  </p>
                )}
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
              </div>
            ),
          },
          ...(row && current
            ? [
                {
                  id: 'move',
                  title: `${getItemName(row.item)} — ${current.stockId}`,
                  hint: `${fmtQty(row.qty)} ${row.uom} · ${locationLabel(state, row.location)}${
                    current.area ? ` · ${storageTypeLabel(current.area.type)}` : ''
                  }`,
                  children: (
                    <div>
                      <div className={`note${current.reason === 'unusual' ? '' : ' warning-note'}`}>
                        {current.why}
                      </div>
                      <div className="form-grid">
                        <div className="field">
                          <label>Stock</label>
                          <div className="field-fixed">
                            {row.status}
                            {row.expiry ? ` · best before ${fmtDate(row.expiry)}` : ''}
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
                              {choices.length
                                ? 'Select storage area'
                                : 'No other storage area can take this stock'}
                            </option>
                            {choices.map((c) => (
                              <option key={c.area.id} value={c.value}>
                                {c.text}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="field span-3">
                          <label>Note (optional)</label>
                          <input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="e.g. consolidated onto one pallet"
                          />
                        </div>
                      </div>
                      {unusualDestination ? (
                        <div className="note warning-note">
                          {unusualDestination.label} is a{' '}
                          {storageTypeLabel(unusualDestination.type).toLowerCase()}, and {kind} is
                          not usually kept in one. The move is allowed — check it is the area you
                          meant.
                        </div>
                      ) : null}
                      <div className="note">
                        A move changes where stock sits — not its cost, and not its QC status.
                        {needsColdRoom(row.itemType)
                          ? ' Bulk can only go into a cold room, or into a hold area once QC has rejected it.'
                          : ''}
                        {row.status === 'Rejected'
                          ? ' Rejected stock can be set aside in a hold area.'
                          : ' Only stock QC has rejected can go into a hold area.'}
                      </div>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
        footer={
          row ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-primary" onClick={submit}>
                Move stock
              </button>
            </div>
          ) : undefined
        }
      />
    </div>
  )
}
