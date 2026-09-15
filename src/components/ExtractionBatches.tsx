/**
 * Extraction — stage 1 of production: press raw produce into bulk.
 *
 * Lives beside MelangeRuns as a tab on the Production page. The two are the same
 * posting operation (`createBatch`, differing only by `kind`) and produce the same
 * kind of record, so they belong on one page rather than two.
 */

import { Fragment, useMemo, useState } from 'react'
import { DetailView, type DetailSection } from './DetailView'
import { DocLink } from './DocLink'
import { Modal } from './Modal'
import { Select } from './Select'
import { StatusBadge } from './StatusBadge'
import { EmptyState } from './EmptyState'
import { useApp } from '../context/AppContext'
import { useLinkedView } from '../lib/linkedView'
import { defaultBulkStore, isByProduct, postedLocation } from '../lib/posting'

/** "1 piece", "960 pieces" — the unit is stored singular. */
const plural = (uom: string, n: number) => (n === 1 ? uom : `${uom}s`)
import {
  COCONUT_ITEM,
  MALAI_ITEM,
  WATER_ITEM,
  batchInputQty,
  batchInputUom,
  batchLabel,
  batchOutputs,
  batchWastage,
  batchYield,
  usableYield,
  bulkItems,
  fmtBulk,
  mainOutput,
} from '../lib/batches'
import {
  itemName as lookupItemName,
  poolByLot,
  stockRowsExcluding,
  areaChoices,
} from '../lib/stock'
import { fmtDate, fmtQty, inr, toLocalInputValue } from '../lib/utils'
import type { Batch } from '../types'
import { keyed, keyedAll, type Keyed } from '../lib/rows'

/** A raw-material issue as the form holds it: the stock row picked, and how much of it. */
interface LotRow {
  item: string
  lot: string
  qty: number | ''
  unitCost: number
  uom: string
}

interface OutRow {
  item: string
  qty: number | ''
  main: boolean
}

const blankLot: LotRow = { item: '', lot: '', qty: '', unitCost: 0, uom: '' }
const blankOut: OutRow = { item: '', qty: '', main: true }
const num = (v: number | '') => Number(v) || 0

export function ExtractionBatches() {
  const { state, rows, createBatch, updateBatch, deleteBatch, showToast } = useApp()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [date, setDate] = useState(toLocalInputValue())
  const [spoiled, setSpoiled] = useState<number | ''>('')
  const [outLocation, setOutLocation] = useState('')
  const [lotRows, setLotRows] = useState<Keyed<LotRow>[]>([keyed(blankLot)])
  const [outRows, setOutRows] = useState<Keyed<OutRow>[]>([keyed(blankOut)])
  const [viewId, setViewId, closeView] = useLinkedView((id) =>
    state.batches.some((b) => b.id === id && (b.kind || 'Extraction') === 'Extraction'),
  )

  const itemName = (id: string) => lookupItemName(state, id)
  const editing = editId ? state.batches.find((b) => b.id === editId) : undefined
  /** Bulk that has been packed, blended or moved by QC was costed off this batch — its figures are frozen. */
  const locked = !!editing && state.ledger.some((l) => l.lot === editing.id && l.doc !== editing.id)

  // Editing re-issues the produce, so the lots this batch already took have to stay
  // on offer — measured as they stood before it was posted.
  const rmLots = useMemo(() => {
    const source = editing ? stockRowsExcluding(state, editing.id) : rows
    return poolByLot(
      source.filter((r) => r.itemType === 'Raw Material' && r.status === 'Available' && r.qty > 0),
    )
  }, [editing, rows, state])

  const bulks = useMemo(() => bulkItems(state), [state])
  /** Bulk is unsealed and perishable, so only cold rooms are offered — see `areaChoices`. */
  const bulkRooms = useMemo(
    () => areaChoices(state, 'Semi Finished', 'Quarantine', outLocation),
    [outLocation, state],
  )
  /**
   * A melange's own bulk is made by blending, on the Melange tab, and its record keeps
   * the lines it was blended from. Booking one straight out of a press would put
   * "ABC Juice" in the store with nothing saying what went into it, so extraction only
   * offers the bulks a press can actually make.
   */
  const pressable = useMemo(() => {
    const blended = new Set(state.melanges.map((m) => m.outputItem))
    return bulks.filter((b) => !blended.has(b.id))
  }, [bulks, state.melanges])

  /** Extractions only — melange runs have their own page and their own form. */
  const list = useMemo(() => {
    const q = search.toLowerCase()
    return state.batches
      .filter(
        (b) =>
          (b.kind || 'Extraction') === 'Extraction' &&
          (!status || b.status === status) &&
          [b.id, batchLabel(state, b)].join(' ').toLowerCase().includes(q),
      )
      .slice()
      .reverse()
    // A batch is named by the item it produced, so the search reads the whole state.
  }, [search, state, status])

  const viewing = viewId ? state.batches.find((b) => b.id === viewId) : undefined
  const qcRecords = viewing ? state.qcs.filter((q) => q.batchId === viewing.id) : []

  /** Every pack filled from a batch, each linked to the run that filled it. */
  const packedFrom = (batchId: string) => {
    const lines = state.packingRuns
      .filter((r) => r.batchId === batchId)
      .flatMap((r) => r.lines.map((l) => ({ run: r.id, l })))
    if (!lines.length) return 'Not packed yet'
    return (
      <>
        {lines.map(({ run, l }, i) => (
          <Fragment key={`${run}-${l.sku}-${i}`}>
            {i ? ' · ' : ''}
            {l.packs} × {itemName(l.sku)} (<DocLink doc={run} />)
          </Fragment>
        ))}
      </>
    )
  }

  /** Every melange blended from a batch, each linked. */
  const blendedInto = (batchId: string) => {
    const blends = state.batches.filter((b) => (b.blendLines || []).some((l) => l.lot === batchId))
    if (!blends.length) return 'Not blended'
    return (
      <>
        {blends.map((b, i) => (
          <Fragment key={b.id}>
            {i ? ' · ' : ''}
            <DocLink doc={b.id} /> {batchLabel(state, b)}
          </Fragment>
        ))}
      </>
    )
  }
  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Batch',
          fields: [
            { label: 'Batch', value: viewing.id },
            { label: 'Produced on', value: fmtDate(viewing.date) },
            { label: 'Product', value: batchLabel(state, viewing) },
            { label: 'Status', value: viewing.status },
            {
              label: 'QC records',
              value: qcRecords.length ? (
                <>
                  {qcRecords.map((q, i) => (
                    <Fragment key={q.id}>
                      {i ? ' · ' : ''}
                      <DocLink doc={q.id} /> {itemName(q.item || '')} {q.disposition}
                    </Fragment>
                  ))}
                </>
              ) : (
                'None'
              ),
              wide: true,
            },
          ],
        },
        {
          title: 'Input',
          fields: [
            {
              label: 'Issued',
              value: `${batchInputQty(viewing)} ${batchInputUom(viewing)}`,
            },
            { label: 'Spoiled', value: viewing.spoiled },
            {
              label: 'Source lots',
              value: (
                <>
                  {viewing.sourceLines.map((s, i) => (
                    <Fragment key={`${s.lot}-${i}`}>
                      {i ? ' · ' : ''}
                      {itemName(s.item || COCONUT_ITEM)} <DocLink doc={s.lot} /> — {s.qty}{' '}
                      {s.uom || 'Piece'} @ {inr(s.unitCost)}
                    </Fragment>
                  ))}
                </>
              ),
              wide: true,
            },
          ],
        },
        {
          title: 'Output',
          fields: [
            ...batchOutputs(viewing).map((o) => ({
              label: itemName(o.item),
              value: `${fmtBulk(o.qty, o.uom)}${o.costShare > 0 ? '' : ' · by-product'}`,
            })),
            {
              label: 'Yield',
              value: `${batchYield(viewing).toFixed(3)} per ${batchInputUom(viewing).toLowerCase()}`,
            },
            {
              label: 'Packed from this batch',
              value: packedFrom(viewing.id),
              wide: true,
            },
            {
              label: 'Blended into',
              value: blendedInto(viewing.id),
              wide: true,
            },
          ],
        },
        {
          title: 'Cost',
          fields: [
            { label: 'Raw material', value: inr(viewing.rmCost) },
            { label: 'Direct cost', value: inr(viewing.directCost) },
            {
              label: `Cost / ${mainOutput(viewing)?.uom === 'Kg' ? 'kg' : 'litre'} of ${itemName(mainOutput(viewing)?.item || '')}`,
              value: inr(viewing.costPerL),
            },
            { label: 'By-products', value: 'Carry no raw-material cost' },
          ],
        },
      ]
    : []

  const openForm = () => {
    if (!rmLots.length) {
      showToast('No raw material is available. Post a procurement receipt first.')
      return
    }
    setEditId('')
    setDate(toLocalInputValue())
    setSpoiled('')
    setOutLocation(defaultBulkStore(state) || '')
    setLotRows([keyed(blankLot)])
    setOutRows([keyed(blankOut)])
    setOpen(true)
  }

  const openEdit = (b: Batch) => {
    setEditId(b.id)
    setDate(toLocalInputValue(new Date(b.date)))
    setSpoiled(b.spoiled)
    setOutLocation(b.location || postedLocation(state, b.id, 'Semi Finished') || '')
    setLotRows(
      b.sourceLines.length
        ? keyedAll(
            b.sourceLines.map((s) => ({
              item: s.item || COCONUT_ITEM,
              lot: s.lot,
              qty: s.qty,
              unitCost: s.unitCost,
              uom: s.uom || 'Piece',
            })),
          )
        : [keyed(blankLot)],
    )
    const outs = batchOutputs(b)
    setOutRows(
      outs.length
        ? keyedAll(outs.map((o) => ({ item: o.item, qty: o.qty, main: o.costShare > 0 })))
        : [keyed(blankOut)],
    )
    setOpen(true)
  }

  /**
   * Coconuts have always come out as water plus malai, so picking a coconut lot fills
   * that in — while an operator pressing beetroot still names their own outputs.
   */
  const suggestOutputs = (item: string) => {
    if (item !== COCONUT_ITEM) return
    setOutRows((all) =>
      all.some((o) => o.item)
        ? all
        : [
            keyed({ item: WATER_ITEM, qty: '' as number | '', main: true }),
            keyed({ item: MALAI_ITEM, qty: '' as number | '', main: false }),
          ],
    )
  }

  const issued = lotRows.reduce((a, r) => a + num(r.qty), 0)
  const issuedUoms = new Set(lotRows.filter((r) => r.item).map((r) => r.uom))
  const issuedUom = issuedUoms.size === 1 ? [...issuedUoms][0] : 'unit'
  const mainRow = outRows.find((o) => o.main && o.item)

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Extraction Batches</h3>
          <span>
            Stage 1 — press any produce into bulk, whatever it is. Stage 2 blends that bulk
            under the Melange tab.
          </span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" onClick={openForm}>
            + New Extraction
          </button>
        </div>
      </div>
      <div className="note">
        A batch presses raw material into <b>bulk</b>, kept in the cold room you pick and marked <b>Awaiting QC</b>. One output carries
        the batch cost and the rest are by-products that carry none — coconuts give water plus malai,
        beetroot gives juice plus pomace. Pass all tests in <b>Quality Control</b> to release the
        batch, then blend it under <b>Melange</b> above or fill packs on <b>Packing</b>.
      </div>
      <div className="toolbar">
        <input
          placeholder="Search batch or product"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option>Awaiting QC</option>
          <option>Released</option>
          <option>On Hold</option>
          <option>Rejected</option>
        </Select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Date</th>
              <th>Product</th>
              <th>Raw Material</th>
              <th>Issued</th>
              <th>Bulk Produced</th>
              {/* The body has always carried this column; without its header every
                  label from Yield rightwards sat over the wrong data on desktop. */}
              <th>Spoiled / lost</th>
              <th>Yield</th>
              <th>Cost / Unit</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!list.length ? (
              <tr>
                <td colSpan={11} className="empty">
                  <EmptyState
                    filtered={!!search || !!status}
                    empty="No extraction batches yet."
                    onClear={() => {
                      setSearch('')
                      setStatus('')
                    }}
                  />
                </td>
              </tr>
            ) : (
              list.map((b) => {
                const materials = [
                  ...new Set(b.sourceLines.map((s) => itemName(s.item || COCONUT_ITEM))),
                ]
                return (
                  <tr key={b.id}>
                    <td data-label="Batch">
                      <b>{b.id}</b>
                    </td>
                    <td data-label="Date">{fmtDate(b.date)}</td>
                    <td data-label="Product">{batchLabel(state, b)}</td>
                    <td data-label="Raw Material">
                      {materials.join(', ')}
                      <div className="cell-sub cell-id">
                        {b.sourceLines.map((s, i) => (
                          <Fragment key={`${s.lot}-${i}`}>
                            {i ? ', ' : ''}
                            <DocLink doc={s.lot} />
                          </Fragment>
                        ))}
                      </div>
                    </td>
                    <td data-label="Issued">
                      {batchInputQty(b)} {batchInputUom(b)}
                    </td>
                    <td data-label="Bulk Produced">
                      {batchOutputs(b).map((o) => (
                        <div key={o.item}>
                          {fmtBulk(o.qty, o.uom)} {itemName(o.item)}
                        </div>
                      ))}
                    </td>
                    <td data-label="Spoiled / lost">
                      {b.spoiled ? (
                        <>
                          {b.spoiled} {plural(batchInputUom(b).toLowerCase(), b.spoiled)}
                          <div className="small">
                            ≈ {Number(batchWastage(b).toFixed(2))}{' '}
                            {(mainOutput(b)?.uom || 'L') === 'Kg' ? 'kg' : 'L'} lost
                          </div>
                        </>
                      ) : (
                        <span className="small">None</span>
                      )}
                    </td>
                    <td data-label="Yield">
                      {batchYield(b).toFixed(3)}
                      <div className="small">
                        {(mainOutput(b)?.uom || 'L') === 'Kg' ? 'kg' : 'L'} /{' '}
                        {batchInputUom(b).toLowerCase()}
                      </div>
                    </td>
                    <td data-label="Cost / Unit">{inr(b.costPerL)}</td>
                    <td data-label="Status">
                      <StatusBadge value={b.status} />
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        <button className="btn btn-light" onClick={() => setViewId(b.id)}>
                          View
                        </button>
                        <button className="btn btn-light" onClick={() => openEdit(b)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => {
                            if (
                              confirm(`Delete ${b.id}? This reverses its raw material, bulk and packed stock.`)
                            ) {
                              deleteBatch(b.id)
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <DetailView
        open={!!viewing}
        title={viewing ? `${viewing.id} · ${batchLabel(state, viewing)}` : 'Batch'}
        sections={viewSections}
        onClose={closeView}
        record={viewing?.id}
      />

      <Modal
        open={open}
        title={editing ? `Edit ${editing.id} · ${batchLabel(state, editing)}` : 'New Extraction Batch'}
        saveLabel={editing ? 'Save Changes' : 'Post Production'}
        onClose={() => {
          setOpen(false)
          setEditId('')
        }}
        onSave={() => {
          const input = {
            date,
            kind: 'Extraction' as const,
            spoiled: num(spoiled),
            sourceLines: lotRows
              .filter((r) => r.item && r.lot && num(r.qty) > 0)
              .map((r) => ({ item: r.item, lot: r.lot, qty: num(r.qty) })),
            blendLines: [],
            location: outLocation,
            outputs: outRows
              .filter((r) => r.item && num(r.qty) > 0)
              .map((r) => ({ item: r.item, qty: num(r.qty), main: r.main })),
          }
          const ok = editing ? updateBatch(editing.id, input) : createBatch(input)
          if (ok) {
            setOpen(false)
            setEditId('')
          }
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Production date / time</label>
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Spoiled / discarded input</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={spoiled}
              onChange={(e) => setSpoiled(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>
          {/* Bulk used to land in the bulk store whatever the plant actually had. */}
          <div className="field">
            <label>Storage area</label>
            <Select
              value={outLocation}
              disabled={locked}
              onChange={(e) => setOutLocation(e.target.value)}
            >
              <option value="">
                {bulkRooms.length ? 'Select a cold room' : 'No active cold room — add one on the Storage page'}
              </option>
              {bulkRooms.map((c) => (
                <option key={c.area.id} value={c.value}>
                  {c.text}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Raw material issued</span>
            {locked ? null : (
              <button
                className="btn btn-light"
                type="button"
                onClick={() => setLotRows((r) => [...r, keyed(blankLot)])}
              >
                + Add lot
              </button>
            )}
          </div>
          <div className="subform-body">
            <div className="subform-row pack-row pack-row-head">
              <span>Lot</span>
              <span>Material</span>
              <span>Unit</span>
              <span>Qty</span>
              <span>Cost / unit</span>
              <span />
            </div>
            {lotRows.map((row, idx) => (
              <div className="subform-row pack-row" key={row.rowId}>
                <Select
                  value={row.item && row.lot ? `${row.item}|${row.lot}` : ''}
                  disabled={locked}
                  onChange={(e) => {
                    const [item, lot] = e.target.value.split('|')
                    const stock = rmLots.find((l) => l.item === item && l.lot === lot)
                    setLotRows((all) =>
                      all.map((r, i) =>
                        i === idx
                          ? {
                              ...r,
                              item: item || '',
                              lot: lot || '',
                              qty: r.qty,
                              unitCost: stock?.unitCost || 0,
                              uom: stock?.uom || '',
                            }
                          : r,
                      ),
                    )
                    suggestOutputs(item)
                  }}
                >
                  <option value="">Select lot</option>
                  {rmLots.map((l) => (
                    <option key={`${l.item}|${l.lot}`} value={`${l.item}|${l.lot}`}>
                      {itemName(l.item)} · {l.lot} · {fmtQty(l.qty)} {l.uom} available
                    </option>
                  ))}
                </Select>
                <input disabled placeholder="Material" value={row.item ? itemName(row.item) : ''} />
                <input disabled placeholder="Unit" value={row.uom} />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Qty"
                  value={row.qty}
                  disabled={locked}
                  onChange={(e) =>
                    setLotRows((all) =>
                      all.map((r, i) =>
                        i === idx
                          ? { ...r, qty: e.target.value === '' ? '' : Number(e.target.value) }
                          : r,
                      ),
                    )
                  }
                />
                <input
                  disabled
                  value={row.unitCost ? row.unitCost.toFixed(2) : ''}
                  placeholder="Cost"
                />
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={locked}
                  onClick={() => setLotRows((all) => all.filter((_, i) => i !== idx))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Bulk produced</span>
            {locked ? null : (
              <button
                className="btn btn-light"
                type="button"
                onClick={() =>
                  setOutRows((r) => [...r, keyed({ item: '', qty: '' as number | '', main: !r.some((x) => x.main) })])
                }
              >
                + Add output
              </button>
            )}
          </div>
          <div className="subform-body">
            {!pressable.length ? (
              <div className="note warning-note">
                No bulk product exists yet. Add one on the <b>Products &amp; Materials</b> page — a name and whether
                it is measured in litres or kilograms — and it appears here.
              </div>
            ) : null}
            <div className="subform-row pack-row pack-row-head">
              <span>Bulk product</span>
              <span>Unit</span>
              <span>Qty</span>
              <span>Carries cost</span>
              <span />
              <span />
            </div>
            {outRows.map((row, idx) => {
              const item = bulks.find((b) => b.id === row.item)
              return (
                <div className="subform-row pack-row" key={row.rowId}>
                  <Select
                    value={row.item}
                    disabled={locked}
                    onChange={(e) => {
                      const picked = e.target.value
                      setOutRows((all) => {
                        const next = all.map((r, i) =>
                          i === idx ? { ...r, item: picked } : r,
                        )
                        // Never leave the batch cost sitting on a by-product.
                        const byProduct = (id: string) =>
                          isByProduct(bulks.find((b) => b.id === id))
                        if (!next.some((r) => r.main && r.item && !byProduct(r.item))) {
                          const heir = next.findIndex((r) => r.item && !byProduct(r.item))
                          return next.map((r, i) => ({ ...r, main: i === heir }))
                        }
                        return next.map((r) => (byProduct(r.item) ? { ...r, main: false } : r))
                      })
                    }}
                  >
                    <option value="">Select bulk product</option>
                    {/* A bulk already saved on this row stays selectable so an old batch
                        can still be opened and corrected. */}
                    {bulks
                      .filter((b) => b.id === row.item || pressable.includes(b))
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </Select>
                  <input disabled placeholder="Unit" value={item?.uom || ''} />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Qty"
                    value={row.qty}
                    disabled={locked}
                    onChange={(e) =>
                      setOutRows((all) =>
                        all.map((r, i) =>
                          i === idx
                            ? { ...r, qty: e.target.value === '' ? '' : Number(e.target.value) }
                            : r,
                        ),
                      )
                    }
                  />
                  {/* A by-product is defined as the thing that carries no cost, so it can
                      never be the output the cost lands on. The master already says which
                      is which — the form should not let you contradict it. */}
                  <label
                    className="check-row main-output-pick"
                    title={
                      isByProduct(item)
                        ? `${item?.name} is a by-product, so it carries no batch cost.`
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="main-output"
                      checked={row.main && !isByProduct(item)}
                      disabled={locked || isByProduct(item)}
                      onChange={() =>
                        setOutRows((all) => all.map((r, i) => ({ ...r, main: i === idx })))
                      }
                    />
                    <span className="small">{isByProduct(item) ? 'By-product' : 'Main'}</span>
                  </label>
                  <span />
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={locked}
                    onClick={() => setOutRows((all) => all.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {issued > 0 && mainRow && num(mainRow.qty) > 0 ? (
          (() => {
            const unit = bulks.find((b) => b.id === mainRow.item)?.uom === 'Kg' ? 'kg' : 'L'
            const spoiledNow = num(spoiled)
            const usable = issued - spoiledNow
            const y = usableYield(issued, spoiledNow, num(mainRow.qty))
            return (
              <div className="note">
                <b>
                  {Number(num(mainRow.qty).toFixed(3))} {unit}
                </b>{' '}
                of {itemName(mainRow.item)} from <b>{usable}</b> usable{' '}
                {plural(issuedUom.toLowerCase(), usable)}
                {spoiledNow > 0 ? ` of ${issued} issued` : ''} —{' '}
                <b>
                  {y.toFixed(3)} {unit}
                </b>{' '}
                each.
                {spoiledNow > 0 ? (
                  <>
                    {' '}
                    <b>{spoiledNow}</b> spoiled, costing about{' '}
                    <b>
                      {Number((y * spoiledNow).toFixed(3))} {unit}
                    </b>{' '}
                    at that rate.
                  </>
                ) : null}
              </div>
            )
          })()
        ) : null}

        {locked ? (
          <div className="note warning-note">
            {editing?.id} has already been packed, blended or reviewed by QC, so what it issued and
            produced is frozen. The date and the spoiled count can still be corrected.
          </div>
        ) : (
          <div className="note warning-note">
            {editing
              ? 'Saving returns the raw material this batch issued, then re-issues it and re-books the bulk from the new figures.'
              : 'Posting deducts the raw material and books the bulk into the cold room you pick, marked Awaiting QC. The output marked Main carries the whole batch cost; everything else is a by-product and carries none.'}
          </div>
        )}
      </Modal>
    </div>
  )
}
