/**
 * Melange runs — stage 2 of production.
 *
 * A melange run is a batch like any other: `createBatch` posts it, it gets its own
 * lot, its own QC record and its own packs, and Quality Control does not tell the two
 * apart. The only real difference from an extraction is what gets issued — bulk that
 * other batches pressed, rather than raw produce. So it lives on the Production page
 * as a tab beside Extraction rather than as a page of its own.
 */

import { Fragment, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DetailView, type DetailSection } from './DetailView'
import { DocLink } from './DocLink'
import { EmptyState } from './EmptyState'
import { Modal } from './Modal'
import { Select } from './Select'
import { StatusBadge } from './StatusBadge'
import { useApp } from '../context/AppContext'
import { batchInputQty, batchLabel, batchOutputs, bulkItems, fmtBulk, mainOutput } from '../lib/batches'
import { useLinkedView } from '../lib/linkedView'
import { DRAWABLE, defaultBulkStore } from '../lib/posting'
import {
  itemName as lookupItemName,
  poolByLot,
  stockRowsExcluding,
  storageTypeLabel,
} from '../lib/stock'
import { fmtDate, fmtQty, inr, QTY_EPSILON, toLocalInputValue } from '../lib/utils'
import type { Batch } from '../types'
import { keyed, keyedAll, type Keyed } from '../lib/rows'

/** One component of a run: which bulk, out of which batch, and how much. */
interface DrawRow {
  item: string
  lot: string
  qty: number | ''
}

const num = (v: number | '') => Number(v) || 0

export function MelangeRuns() {
  const { state, rows, createBatch, updateBatch, deleteBatch, showToast } = useApp()
  const navigate = useNavigate()

  const [runOpen, setRunOpen] = useState(false)
  const [runEditId, setRunEditId] = useState('')
  const [search, setSearch] = useState('')
  const [date, setDate] = useState(toLocalInputValue())
  const [melangeId, setMelangeId] = useState('')
  const [draws, setDraws] = useState<Keyed<DrawRow>[]>([])
  const [outQty, setOutQty] = useState<number | ''>('')
  const [outLocation, setOutLocation] = useState('')
  const [viewId, setViewId, closeView] = useLinkedView((id) =>
    state.batches.some((b) => b.id === id && b.kind === 'Melange'),
  )

  const itemName = (id: string) => lookupItemName(state, id)
  const bulks = useMemo(() => bulkItems(state), [state])

  const editingRun = runEditId ? state.batches.find((b) => b.id === runEditId) : undefined
  /** Blend that has been packed, re-blended or moved by QC is costed off this run. */
  const locked =
    !!editingRun && state.ledger.some((l) => l.lot === editingRun.id && l.doc !== editingRun.id)

  // Editing re-draws the components, so the bulk this run already took has to stay on
  // offer — measured as it stood before the run was posted.
  const formRows = useMemo(
    () => (editingRun ? stockRowsExcluding(state, editingRun.id) : rows),
    [editingRun, rows, state],
  )

  /** Every bulk lot that could go into a blend: anything on hand and not rejected. */
  const blendableLots = useMemo(
    () =>
      poolByLot(
        formRows.filter(
          (r) =>
            r.itemType === 'Semi Finished' && DRAWABLE.includes(r.status) && r.qty > QTY_EPSILON,
        ),
      ),
    [formRows],
  )

  const activeRecipes = state.melanges.filter((m) => m.status === 'Active')
  const selected = state.melanges.find((m) => m.id === melangeId)
  /**
   * A blend can never be one of its own components — `checkBatch` refuses it — so the
   * pickers must not offer it either, or an operator can fill the whole form before
   * being told the line was never going to post.
   */
  /** A blend is bulk like any other: unsealed, perishable and cold-room only. */
  const bulkRooms = useMemo(
    () => state.storageLocations.filter((l) => l.status === 'Active' && l.type === 'Cold Room'),
    [state.storageLocations],
  )

  const runBulks = useMemo(
    () => (selected ? bulks.filter((b) => b.id !== selected.outputItem) : bulks),
    [bulks, selected],
  )

  const runs = useMemo(() => {
    const q = search.toLowerCase()
    return state.batches
      .filter(
        (b) =>
          b.kind === 'Melange' &&
          [b.id, batchLabel(state, b), b.melangeId || ''].join(' ').toLowerCase().includes(q),
      )
      .slice()
      .reverse()
    // A run is named by the recipe it followed, so the search reads the whole state.
  }, [search, state])

  const openRunNew = () => {
    if (!activeRecipes.length) return
    setRunEditId('')
    setDate(toLocalInputValue())
    setMelangeId('')
    setDraws([])
    setOutQty('')
    setOutLocation(defaultBulkStore(state))
    setRunOpen(true)
  }

  const openRunEdit = (b: Batch) => {
    setRunEditId(b.id)
    setDate(toLocalInputValue(new Date(b.date)))
    setMelangeId(b.melangeId || '')
    setDraws(keyedAll((b.blendLines || []).map((l) => ({ item: l.item, lot: l.lot, qty: l.qty }))))
    setOutQty(mainOutput(b)?.qty ?? '')
    setOutLocation(b.location || defaultBulkStore(state))
    setRunOpen(true)
  }

  /** Picking a melange lays out one draw row per component, in the recipe's order. */
  const pickRecipe = (id: string) => {
    setMelangeId(id)
    const m = state.melanges.find((x) => x.id === id)
    setDraws(m ? keyedAll(m.components.map((c) => ({ item: c.item, lot: '', qty: '' as number | '' }))) : [])
    setOutQty('')
  }

  const drawnTotal = draws.reduce((a, d) => a + num(d.qty), 0)
  const outTotal = num(outQty)
  const loss = drawnTotal - outTotal

  /**
   * Components more than two points off the share the recipe names — including one
   * left at nothing, which is how a 60/40 juice used to post as 100% of one bulk
   * with the app saying nothing at all.
   */
  const offRecipe = !selected || drawnTotal <= 0
    ? []
    : selected.components
        .map((c) => {
          const drawn = draws
            .filter((d) => d.item === c.item)
            .reduce((a, d) => a + num(d.qty), 0)
          return { item: c.item, target: c.share, actual: (drawn / drawnTotal) * 100 }
        })
        .filter((o) => Math.abs(o.actual - o.target) > 2)

  const viewing = viewId ? state.batches.find((b) => b.id === viewId) : undefined
  const viewQc = viewing ? state.qcs.find((q) => q.batchId === viewing.id) : undefined

  /** Every pack filled from a run, each linked to the packing run that filled it. */
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
  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Melange run',
          fields: [
            { label: 'Run', value: viewing.id },
            { label: 'Blended on', value: fmtDate(viewing.date) },
            { label: 'Recipe', value: batchLabel(state, viewing) },
            { label: 'Status', value: viewing.status },
            {
              label: 'QC record',
              value: viewQc ? (
                <>
                  <DocLink doc={viewQc.id} /> · {viewQc.disposition}
                </>
              ) : (
                'None'
              ),
            },
          ],
        },
        {
          title: 'Components',
          fields: (viewing.blendLines || []).map((l) => ({
            label: itemName(l.item),
            value: (
              <>
                {fmtBulk(l.qty, l.uom || 'Litre')} from <DocLink doc={l.lot} /> @ {inr(l.unitCost)}
              </>
            ),
            wide: true,
          })),
        },
        {
          title: 'Blend',
          fields: [
            ...batchOutputs(viewing).map((o) => ({
              label: itemName(o.item),
              value: fmtBulk(o.qty, o.uom),
            })),
            { label: 'Bulk in', value: fmtBulk(batchInputQty(viewing), viewing.inputUom || 'Litre') },
            {
              label: 'Blending loss',
              value: fmtBulk(
                batchInputQty(viewing) - (mainOutput(viewing)?.qty ?? 0),
                viewing.inputUom || 'Litre',
              ),
            },
            {
              label: 'Packed from this run',
              value: packedFrom(viewing.id),
              wide: true,
            },
          ],
        },
        {
          title: 'Cost',
          fields: [
            { label: 'Components drawn', value: inr(viewing.rmCost) },
            {
              label: `Cost / ${mainOutput(viewing)?.uom === 'Kg' ? 'kg' : 'litre'}`,
              value: inr(viewing.costPerL),
            },
          ],
        },
      ]
    : []

  return (
    <>
      <div className="card">
        <div className="section-head">
          <div>
            <h3>Melange runs</h3>
            <span>Blend the bulk extraction made. The blend gets its own lot, QC and packs.</span>
          </div>
          <div className="section-head-actions">
            <button
              className="btn btn-primary"
              onClick={openRunNew}
              disabled={!activeRecipes.length}
              title={
                !activeRecipes.length
                  ? 'Add a melange on Products & Materials first'
                  : undefined
              }
            >
              + New Melange Run
            </button>
          </div>
        </div>

        <div className="note">
          A run draws bulk from the batches that pressed it and books the blend as a new lot in{' '}
          <b>Quarantine</b>, carrying the full cost of everything it drew. Blending loss raises the
          cost per litre, which is exactly what it does on the floor. Clear the blend in{' '}
          <b>Quality Control</b>, then fill packs on <b>Packing</b>.
        </div>

        {/* A blend needs a recipe before it can be run. Saying so in a toast meant the
            answer disappeared while the operator was still reading the page, and left
            them on the one screen that could not fix it. */}
        {!activeRecipes.length ? (
          <div className="note warning-note melange-setup-note">
            <span>
              There are no melanges yet. A melange names the blend and the share of each bulk in
              it — add one and it becomes a bulk product you can run here.
            </span>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => navigate('/purchase-products')}
            >
              Add a melange
            </button>
          </div>
        ) : null}

        <div className="toolbar">
          <input
            placeholder="Search run or melange"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Date</th>
                <th>Melange</th>
                <th>Components</th>
                <th>Blend Out</th>
                <th>Loss</th>
                <th>Cost / Unit</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {!runs.length ? (
                <tr>
                  <td colSpan={9} className="empty">
                    <EmptyState
                      filtered={!!search}
                      empty="No melange runs yet."
                      onClear={() => setSearch('')}
                    />
                  </td>
                </tr>
              ) : (
                runs.map((b) => {
                  const main = mainOutput(b)
                  const uom = b.inputUom || 'Litre'
                  return (
                    <tr key={b.id}>
                      <td data-label="Run">
                        <b>{b.id}</b>
                      </td>
                      <td data-label="Date">{fmtDate(b.date)}</td>
                      <td data-label="Melange">{batchLabel(state, b)}</td>
                      <td data-label="Components">
                        {(b.blendLines || []).map((l) => (
                          <div key={`${l.item}-${l.lot}`}>
                            {fmtBulk(l.qty, l.uom || uom)} {itemName(l.item)}
                            <span className="small cell-id"> · <DocLink doc={l.lot} /></span>
                          </div>
                        ))}
                      </td>
                      <td data-label="Blend Out">{fmtBulk(main?.qty ?? 0, main?.uom || uom)}</td>
                      <td data-label="Loss">
                        {fmtBulk(Math.max(0, batchInputQty(b) - (main?.qty ?? 0)), uom)}
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
                          <button className="btn btn-light" onClick={() => openRunEdit(b)}>
                            Edit
                          </button>
                          <button
                            className="btn btn-danger"
                            onClick={() => {
                              if (
                                confirm(`Delete ${b.id}? The components go back to their batches.`)
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
      </div>

      <DetailView
        open={!!viewing}
        title={viewing ? `${viewing.id} · ${batchLabel(state, viewing)}` : 'Melange run'}
        sections={viewSections}
        onClose={closeView}
        record={viewing?.id}
      />

      <Modal
        open={runOpen}
        title={editingRun ? `Edit ${editingRun.id} · ${batchLabel(state, editingRun)}` : 'New Melange Run'}
        saveLabel={editingRun ? 'Save Changes' : 'Post Melange'}
        onClose={() => {
          setRunOpen(false)
          setRunEditId('')
        }}
        onSave={() => {
          if (!selected) {
            showToast('Select a melange.')
            return
          }
          if (!(outTotal > 0)) {
            showToast('Enter how much blend came out of the run.')
            return
          }
          const input = {
            date,
            kind: 'Melange' as const,
            melangeId: selected.id,
            spoiled: 0,
            sourceLines: [],
            blendLines: draws
              .filter((d) => d.item && d.lot && num(d.qty) > 0)
              .map((d) => ({ item: d.item, lot: d.lot, qty: num(d.qty) })),
            location: outLocation,
            outputs: [{ item: selected.outputItem, qty: outTotal, main: true }],
          }
          const ok = editingRun ? updateBatch(editingRun.id, input) : createBatch(input)
          if (ok) {
            setRunOpen(false)
            setRunEditId('')
          }
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Blend date / time</label>
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field span-2">
            <label>Melange</label>
            <Select value={melangeId} disabled={locked} onChange={(e) => pickRecipe(e.target.value)}>
              <option value="">Select melange</option>
              {activeRecipes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.components.map((c) => `${c.share}%`).join(' / ')}
                </option>
              ))}
            </Select>
          </div>
          {/* The blend used to land in the bulk store no matter what rooms exist. */}
          <div className="field span-3">
            <label>Put the blend in</label>
            <Select
              value={outLocation}
              disabled={locked}
              onChange={(e) => setOutLocation(e.target.value)}
            >
              {bulkRooms.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.label} · {storageTypeLabel(l.type)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Bulk drawn</span>
            {locked || !selected ? null : (
              <button
                className="btn btn-light"
                type="button"
                onClick={() => setDraws((d) => [...d, keyed({ item: '', lot: '', qty: '' as number | '' })])}
              >
                + Add component
              </button>
            )}
          </div>
          <div className="subform-body">
            {!selected ? (
              <div className="small">Pick a melange and its components are laid out here.</div>
            ) : (
              <>
                <div className="subform-row pack-row blend-row pack-row-head">
                  <span>Component</span>
                  <span>Target</span>
                  <span>Batch lot</span>
                  <span>Qty</span>
                  <span>Actual</span>
                  <span />
                </div>
                {draws.map((d, idx) => {
                  const target = selected.components.find((c) => c.item === d.item)?.share
                  const actual = drawnTotal ? (num(d.qty) / drawnTotal) * 100 : 0
                  const lots = blendableLots.filter((r) => r.item === d.item)
                  return (
                    <div className="subform-row pack-row blend-row" key={d.rowId}>
                      <Select
                        value={d.item}
                        disabled={locked}
                        onChange={(e) =>
                          setDraws((all) =>
                            all.map((r, i) =>
                              i === idx ? { ...r, item: e.target.value, lot: '' } : r,
                            ),
                          )
                        }
                      >
                        <option value="">Select bulk</option>
                        {runBulks.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </Select>
                      <input disabled placeholder="Target" value={target ? `${target}%` : '—'} />
                      <Select
                        value={d.lot}
                        disabled={locked || !d.item}
                        onChange={(e) =>
                          setDraws((all) =>
                            all.map((r, i) => (i === idx ? { ...r, lot: e.target.value } : r)),
                          )
                        }
                      >
                        <option value="">{lots.length ? 'Select lot' : 'No stock'}</option>
                        {lots.map((l) => (
                          <option key={l.lot} value={l.lot}>
                            {l.lot} · {fmtQty(l.qty)} {l.uom} · {l.statuses.join(', ')}
                          </option>
                        ))}
                      </Select>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Qty"
                        value={d.qty}
                        disabled={locked}
                        onChange={(e) =>
                          setDraws((all) =>
                            all.map((r, i) =>
                              i === idx
                                ? { ...r, qty: e.target.value === '' ? '' : Number(e.target.value) }
                                : r,
                            ),
                          )
                        }
                      />
                      <span
                        className={`subform-unit${
                          num(d.qty) && target != null && Math.abs(actual - target) > 2
                            ? ' off-recipe'
                            : ''
                        }`}
                      >
                        {num(d.qty) ? `${actual.toFixed(1)}%` : '—'}
                      </span>
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={locked}
                        onClick={() => setDraws((all) => all.filter((_, i) => i !== idx))}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {selected ? (
          <div className="form-grid">
            <div className="field">
              <label>Blend produced ({selected.uom === 'Kg' ? 'kg' : 'litres'})</label>
              <input
                type="number"
                min="0"
                step="0.01"
                // A bare number here reads as a filled-in value, and the run would then
                // be posted with nothing recorded as having come out. Keep it a hint.
                placeholder={drawnTotal ? `e.g. ${Number(drawnTotal.toFixed(2))}` : '0'}
                value={outQty}
                disabled={locked}
                onChange={(e) => setOutQty(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </div>
          </div>
        ) : null}

        {selected && offRecipe.length ? (
          <div className="note warning-note">
            This run does not follow {selected.name}:{' '}
            {offRecipe
              .map((o) => `${itemName(o.item)} is ${o.actual.toFixed(1)}% against ${o.target}%`)
              .join('; ')}
            . Post it only if the floor really blended it that way — the recipe on record stays
            as it is.
          </div>
        ) : null}

        {selected && drawnTotal > 0 ? (
          <div className={`note${loss < -0.001 ? ' warning-note' : ''}`}>
            Drawing <b>{fmtBulk(drawnTotal, selected.uom)}</b> of components
            {outTotal > 0 ? (
              <>
                {' '}
                for <b>{fmtBulk(outTotal, selected.uom)}</b> of {selected.name} —{' '}
                {loss >= 0
                  ? `${fmtBulk(loss, selected.uom)} blending loss.`
                  : `${fmtBulk(-loss, selected.uom)} more than went in, so something was added that is not on this run.`}
              </>
            ) : (
              '. Enter how much blend came out.'
            )}
          </div>
        ) : null}

        {locked ? (
          <div className="note warning-note">
            {editingRun?.id} has already been packed or reviewed by QC, so what it drew and produced
            is frozen. Only the date can still be corrected.
          </div>
        ) : (
          <div className="note warning-note">
            {editingRun
              ? 'Saving returns the bulk this run drew to its batches, then draws again from the new lines.'
              : 'Posting draws each component out of its batch and books the blend as a new lot in Quarantine. The whole cost of what was drawn lands on the blend, so any loss shows up as a higher cost per unit.'}
          </div>
        )}
      </Modal>
    </>
  )
}
