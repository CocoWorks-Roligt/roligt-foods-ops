import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DetailView, type DetailSection } from '../components/DetailView'
import { DocLink } from '../components/DocLink'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { EmptyState } from '../components/EmptyState'
import { useApp } from '../context/AppContext'
import { bulkItems, fmtBulk, itemUom } from '../lib/batches'
import { bulkItemOf, formatSize } from '../lib/packs'
import { useLinkedView } from '../lib/linkedView'
import { DRAWABLE, defaultPackStore, sampleLitres } from '../lib/posting'
import { itemName as lookupItemName, stockRowsExcluding, storageTypeLabel } from '../lib/stock'
import { fmtDate, inr, toLocalInputValue, QTY_EPSILON } from '../lib/utils'
import type { PackingRun } from '../types'
import { keyed, keyedAll, type Keyed } from '../lib/rows'

/** Runs posted before the plant made more than one juice drew whichever bulk their medium names. */
const runBulk = (r: PackingRun) =>
  r.bulkItem || (r.medium === 'Malai' ? 'SF-TCW-MALAI' : 'SF-TCW-WATER')

interface PackRow {
  /** Pack format the operator picked — BiB, Glass Bottle, Cover. Narrows the sizes
   *  offered beside it; the size is what actually names the product. */
  type: string
  sku: string
  packs: number | ''
}

const blankRow: PackRow = { type: '', sku: '', packs: '' }
/** Stands in for a pack saved before a type was required, so it is still selectable. */
const UNTYPED = 'Unspecified'
const num = (v: number | '') => Number(v) || 0

export function Packing() {
  const { state, rows, createPackingRun, updatePackingRun, deletePackingRun, showToast } = useApp()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [viewId, setViewId, closeView] = useLinkedView((id) => state.packingRuns.some((r) => r.id === id))
  const [date, setDate] = useState(toLocalInputValue())
  const [batchId, setBatchId] = useState('')
  const [bulkItem, setBulkItem] = useState('')
  const [packRows, setPackRows] = useState<Keyed<PackRow>[]>([keyed(blankRow)])
  const [location, setLocation] = useState('')
  const [sampleCount, setSampleCount] = useState<number | ''>('')
  const [sampleSize, setSampleSize] = useState<number | ''>(100)

  const itemName = (id: string) => lookupItemName(state, id)
  const bulkUom = bulkItem ? itemUom(state, bulkItem) : 'Litre'
  /** Only bulk something is actually packed from is worth offering. */
  const fillable = useMemo(
    () => bulkItems(state).filter((b) => state.products.some((p) => bulkItemOf(p) === b.id)),
    [state],
  )

  const editing = editId ? state.packingRuns.find((r) => r.id === editId) : undefined

  // Editing re-draws the bulk, so the batch this run already emptied has to stay on
  // offer — measured as it stood before the run was posted.
  const formRows = useMemo(
    () => (editing ? stockRowsExcluding(state, editing.id) : rows),
    [editing, rows, state],
  )

  /** Batches that still have bulk of the chosen kind waiting to be packed. Bulk QC has
   *  rejected is not offered — a failed batch must not reach a bottle. */
  const bulkByBatch = useMemo(() => {
    const held = new Map<string, number>()
    for (const r of formRows) {
      if (r.item !== bulkItem || r.qty <= 0 || !DRAWABLE.includes(r.status)) continue
      held.set(r.lot, (held.get(r.lot) || 0) + r.qty)
    }
    return held
  }, [bulkItem, formRows])

  /**
   * Packs come off the line and go into a cold room whatever the lab is doing — QC
   * changes their status where they stand, it does not move them. A hold area is still
   * offered for a plant that parks packs somewhere before freezing them.
   */
  const packDestinations = useMemo(
    () =>
      state.storageLocations
        .filter((l) => l.status === 'Active')
        .sort((a, b) => Number(b.type === 'Cold Room') - Number(a.type === 'Cold Room')),
    [state.storageLocations],
  )

  /** The cold room a run falls into when nothing is chosen — named on the option, so the
   *  default is not a mystery the operator has to post to discover. */
  const defaultRoom = useMemo(
    () => state.storageLocations.find((s) => s.name === defaultPackStore(state)),
    [state],
  )

  const packableBatches = useMemo(
    () => state.batches.filter((b) => (bulkByBatch.get(b.id) || 0) > QTY_EPSILON).slice().reverse(),
    [bulkByBatch, state.batches],
  )

  const products = useMemo(
    () => state.products.filter((p) => bulkItemOf(p) === bulkItem),
    [bulkItem, state.products],
  )

  /** The pack formats this bulk is filled into — what the Type column offers. A pack
   *  saved before the type became compulsory would otherwise be unreachable, and an
   *  unreachable pack cannot be filled at all, so it is grouped rather than dropped. */
  const packTypes = useMemo(() => {
    const seen: string[] = []
    for (const p of products) {
      const t = p.type || UNTYPED
      if (!seen.includes(t)) seen.push(t)
    }
    return seen
  }, [products])

  /**
   * Sizes are the ones an admin registered for that format, because the size is what
   * carries the bill of materials and the shelf life — a size typed in freehand would
   * leave the run with no caps to consume and no expiry to stamp. Two packs of the
   * same format and size are told apart by name.
   */
  const sizesForType = (type: string) => {
    const matching = products.filter((p) => (p.type || UNTYPED) === type)
    return matching.map((p) => {
      const label = formatSize(p.size, p.unit)
      const clashes = matching.filter((x) => formatSize(x.size, x.unit) === label).length > 1
      return { id: p.id, label: clashes ? `${label} · ${p.name}` : label }
    })
  }

  const list = useMemo(() => {
    const q = search.toLowerCase()
    return state.packingRuns
      .filter((r) =>
        [r.id, r.batchId, itemName(runBulk(r))].join(' ').toLowerCase().includes(q),
      )
      .slice()
      .reverse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, state.packingRuns, state.items])

  /** Pack products are numbered FG-0001, so a run reads better by name than by code. */
  const skuLabel = (sku: string) => state.products.find((p) => p.id === sku)?.name || sku

  const available = batchId ? bulkByBatch.get(batchId) || 0 : 0
  /** What one line draws: the pack's own size × how many, in base units. */
  const lineDraw = (r: PackRow) =>
    num(r.packs) * (state.products.find((x) => x.id === r.sku)?.packVolume || 0)
  const willDraw =
    packRows.reduce((a, r) => a + lineDraw(r), 0) +
    sampleLitres({ count: num(sampleCount), sizeMl: num(sampleSize) || 100 })

  const openForm = () => {
    if (!fillable.length) {
      showToast('No pack product is linked to a bulk yet. Set that on the Products & Materials page first.')
      return
    }
    setEditId('')
    setDate(toLocalInputValue())
    setBatchId('')
    setBulkItem('')
    setPackRows([keyed(blankRow)])
    setLocation('')
    setSampleCount('')
    setSampleSize(100)
    setOpen(true)
  }

  const openEdit = (run: PackingRun) => {
    setEditId(run.id)
    setDate(toLocalInputValue(new Date(run.date)))
    setBulkItem(runBulk(run))
    setBatchId(run.batchId)
    setPackRows(
      run.lines.length
        ? keyedAll(
            run.lines.map((l) => ({
              type: state.products.find((x) => x.id === l.sku)?.type || UNTYPED,
              sku: l.sku,
              packs: l.packs,
            })),
          )
        : [keyed(blankRow)],
    )
    setLocation(run.location || '')
    setSampleCount(run.samples?.count || '')
    setSampleSize(run.samples?.sizeMl || 100)
    setOpen(true)
  }

  const viewing = viewId ? state.packingRuns.find((r) => r.id === viewId) : undefined
  const viewBatch = viewing ? state.batches.find((b) => b.id === viewing.batchId) : undefined
  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Packing run',
          fields: [
            { label: 'Run', value: viewing.id },
            { label: 'Packed on', value: fmtDate(viewing.date) },
            { label: 'Batch', value: <DocLink doc={viewing.batchId} /> },
            { label: 'Packed from', value: itemName(runBulk(viewing)) },
            { label: 'Status', value: viewing.status },
            { label: 'Batch QC', value: viewBatch?.status },
          ],
        },
        {
          title: 'Output',
          fields: [
            {
              label: 'Bulk drawn',
              value: fmtBulk(viewing.drawn, itemUom(state, runBulk(viewing))),
            },
            {
              label: 'Packs filled',
              value: viewing.lines.reduce((a, l) => a + l.packs, 0),
            },
            {
              label: 'Lines',
              value: viewing.lines
                .map((l) => {
                  // The size that was actually filled, not whatever the master says now.
                  const per = l.perPack ?? l.kgPerPack
                  const size = per ? ` @ ${fmtBulk(per, itemUom(state, runBulk(viewing)))}` : ''
                  return `${l.packs} × ${skuLabel(l.sku)}${size} — ${l.qty} @ ${inr(l.unitCost)}, exp ${l.expiry}`
                })
                .join(' · '),
              wide: true,
            },
          ],
        },
        {
          title: 'Cost',
          fields: [
            { label: 'Bulk drawn value', value: inr(viewing.bulkCost) },
            { label: 'Packing material', value: inr(viewing.pmCost) },
            { label: 'Total', value: inr(viewing.bulkCost + viewing.pmCost) },
          ],
        },
      ]
    : []

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Packing Runs</h3>
          <span>Fill BiBs, bottles and covers from a batch's or melange's bulk output</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" onClick={openForm}>
            + New Packing Run
          </button>
        </div>
      </div>
      <div className="note">
        Packing draws bulk — coconut water, malai, a single-fruit juice or a blended melange — from
        the batch that made it and creates the finished goods. Each pack's type, size and bulk come
        from the <b>Products &amp; Materials</b> page, so a run only picks the pack and says how many. Packs go into
        the freezer as they come off the line and stay there — the lab works while they sit, and
        QC clears or rejects them where they stand. Take the lab's sample bottles off the same run
        so the bulk they use is accounted for.
      </div>

      <div className="toolbar">
        <input
          placeholder="Search run or batch"
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
              <th>Batch</th>
              <th>From</th>
              <th>Bulk Drawn</th>
              <th>Output</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!list.length ? (
              <tr>
                <td colSpan={8} className="empty">
                  <EmptyState
                    filtered={!!search}
                    empty="No packing runs yet."
                    onClear={() => setSearch('')}
                  />
                </td>
              </tr>
            ) : (
              list.map((r) => (
                <tr key={r.id}>
                  <td data-label="Run">
                    <b>{r.id}</b>
                  </td>
                  <td data-label="Date">{fmtDate(r.date)}</td>
                  <td data-label="Batch">
                    <DocLink doc={r.batchId} />
                  </td>
                  <td data-label="From">{itemName(runBulk(r))}</td>
                  <td data-label="Bulk Drawn">{fmtBulk(r.drawn, itemUom(state, runBulk(r)))}</td>
                  <td data-label="Output">
                    {r.lines.map((l) => `${l.packs} × ${skuLabel(l.sku)}`).join(', ')}
                  </td>
                  <td data-label="Status">
                    <StatusBadge value={r.status} />
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <button className="btn btn-light" onClick={() => setViewId(r.id)}>
                        View
                      </button>
                      <button className="btn btn-light" onClick={() => openEdit(r)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-light"
                        onClick={() => {
                          // One pack in the run can be labelled straight away; a run that
                          // filled several lands on the list, filtered to just that run.
                          const only = r.lines.length === 1 ? `${r.id}\u00b7${r.lines[0].sku}` : ''
                          navigate(
                            `/stickers?stage=pack&q=${encodeURIComponent(r.id)}${
                              only ? `&ref=${encodeURIComponent(only)}` : ''
                            }`,
                          )
                        }}
                      >
                        Sticker
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          if (confirm(`Delete ${r.id}? Bulk and packing material go back to stock.`)) {
                            deletePackingRun(r.id)
                          }
                        }}
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

      <DetailView
        open={!!viewing}
        title={viewing ? `${viewing.id} · ${viewing.batchId}` : 'Packing run'}
        sections={viewSections}
        onClose={closeView}
        record={viewing?.id}
      />

      <Modal
        open={open}
        title={editing ? `Edit ${editing.id} · ${editing.batchId}` : 'New Packing Run'}
        saveLabel={editing ? 'Save Changes' : 'Post Packing'}
        onClose={() => {
          setOpen(false)
          setEditId('')
        }}
        onSave={() => {
          const input = {
            date,
            batchId,
            bulkItem,
            location,
            samples: num(sampleCount)
              ? { count: num(sampleCount), sizeMl: num(sampleSize) || 100 }
              : undefined,
            lines: packRows
              .filter((r) => r.sku && num(r.packs) > 0)
              .map((r) => ({ sku: r.sku, packs: num(r.packs) })),
          }
          const ok = editing ? updatePackingRun(editing.id, input) : createPackingRun(input)
          if (ok) {
            setOpen(false)
            setEditId('')
          }
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Packing date / time</label>
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label>Pack from</label>
            <Select
              value={bulkItem}
              onChange={(e) => {
                setBulkItem(e.target.value)
                setBatchId('')
                setLocation('')
                setPackRows([keyed(blankRow)])
              }}
            >
              <option value="">Select bulk</option>
              {fillable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Batch / melange run</label>
            <Select
              value={batchId}
              disabled={!bulkItem}
              onChange={(e) => {
                setBatchId(e.target.value)
                setLocation('')
              }}
            >
              <option value="">{bulkItem ? 'Select batch' : 'Pick a bulk first'}</option>
              {packableBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} · {(bulkByBatch.get(b.id) || 0).toFixed(2)} {bulkUom} left · {b.status}
                </option>
              ))}
            </Select>
          </div>
          {/* Packs used to go wherever the code guessed — the freezer it happened to
              find first, or quarantine. The floor knows which room they went into. */}
          <div className="field span-3">
            <label>
              Put the packs in
              <span className="small" style={{ fontWeight: 400 }}>
                {' '}
                — they go in now and stay there; QC clears them where they stand
              </span>
            </label>
            {/* Every active area stays on the list — a plant may genuinely park packs
                somewhere before freezing them, and refusing would strand the run. What each
                area is for is spelled out instead, so picking "Rejected Stock" is visibly
                the wrong answer rather than just another line in a dropdown. */}
            <Select value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">
                Use the default room{defaultRoom ? ` — ${defaultRoom.label}` : ''}
              </option>
              {packDestinations.map((l) => (
                <option key={l.id} value={l.name}>
                  {l.label} · {storageTypeLabel(l.type)}
                  {l.holds ? ` — ${l.holds}` : ''}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="subform">
          <div className="subform-head">
            <span>Packs to fill</span>
            <button
              className="btn btn-light"
              type="button"
              onClick={() => setPackRows((r) => [...r, keyed(blankRow)])}
            >
              + Add line
            </button>
          </div>
          <div className="subform-body">
            {bulkItem && !products.length ? (
              <div className="note warning-note">
                No pack product is filled from {itemName(bulkItem)} yet. Add one on the{' '}
                <b>Products &amp; Materials</b> page — give it a type, a size and the bulk it draws — and it appears
                here.
              </div>
            ) : null}
            <div className="subform-row pack-row fill-row pack-row-head">
              <span>Type</span>
              <span>Size</span>
              <span>Qty</span>
              <span>Unit</span>
              <span>Total</span>
              <span />
            </div>
            {packRows.map((row, idx) => {
              const p = products.find((x) => x.id === row.sku)
              return (
                <div className="subform-row pack-row fill-row" key={row.rowId}>
                  <Select
                    value={row.type}
                    onChange={(e) =>
                      setPackRows((all) =>
                        // A different format means a different set of sizes, so the
                        // pack chosen under the old one cannot stand.
                        all.map((r, i) =>
                          i === idx ? { ...r, type: e.target.value, sku: '' } : r,
                        ),
                      )
                    }
                  >
                    <option value="">Select type</option>
                    {packTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={row.sku}
                    disabled={!row.type}
                    onChange={(e) =>
                      setPackRows((all) =>
                        all.map((r, i) => (i === idx ? { ...r, sku: e.target.value } : r)),
                      )
                    }
                  >
                    <option value="">{row.type ? 'Select size' : 'Pick a type first'}</option>
                    {sizesForType(row.type).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <input
                    type="number"
                    min="0"
                    placeholder="Qty"
                    value={row.packs}
                    onChange={(e) =>
                      setPackRows((all) =>
                        all.map((r, i) =>
                          i === idx
                            ? { ...r, packs: e.target.value === '' ? '' : Number(e.target.value) }
                            : r,
                        ),
                      )
                    }
                  />
                  {/* The unit belongs to the size the admin registered, so it is shown
                      rather than asked for — 250 is ml on a bottle and L on a BiB. */}
                  <input disabled placeholder="Unit" value={p?.unit || ''} />
                  <input
                    disabled
                    placeholder="Total"
                    value={p && num(row.packs) ? fmtBulk(lineDraw(row), bulkUom) : ''}
                  />
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => setPackRows((all) => all.filter((_, i) => i !== idx))}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Bottles pulled for the lab as the packs go into the freezer. They take bulk
            like a pack does, so the run has to know about them, but they are never
            stock and never carry a batch code. */}
        <div className="subform">
          <div className="subform-head">
            <span>Samples drawn for testing</span>
            <span className="small" style={{ fontWeight: 400 }}>
              {num(sampleCount) > 0
                ? `Takes ${fmtBulk(sampleLitres({ count: num(sampleCount), sizeMl: num(sampleSize) || 100 }), bulkUom)} off the batch`
                : 'Leave blank if none were taken'}
            </span>
          </div>
          <div className="subform-body">
            <div className="form-grid">
              <div className="field">
                <label>How many bottles</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="0"
                  value={sampleCount}
                  onChange={(e) =>
                    setSampleCount(e.target.value === '' ? '' : Number(e.target.value))
                  }
                />
              </div>
              <div className="field">
                <label>Size of each (ml)</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={sampleSize}
                  onChange={(e) =>
                    setSampleSize(e.target.value === '' ? '' : Number(e.target.value))
                  }
                />
              </div>
            </div>
            <div className="small">
              Samples are not stock and get no batch code — they never appear on the
              stickers list or in dispatch. Their bulk is absorbed by the packs the run
              filled, the same way any other loss on the run is.
            </div>
          </div>
        </div>

        {batchId && (
          <div className={`note${willDraw > available + QTY_EPSILON ? ' warning-note' : ''}`}>
            Drawing {fmtBulk(willDraw, bulkUom)} of {fmtBulk(available, bulkUom)} available in{' '}
            {batchId}
            {willDraw > available + QTY_EPSILON ? ' — more than the batch has left.' : '.'}
          </div>
        )}
        <div className="note warning-note">
          {editing
            ? 'Saving returns the bulk and packing material this run drew, then draws again from the new lines. Only a run whose packs QC has not yet moved and that has not been dispatched can be edited.'
            : bulkUom === 'Kg'
              ? `Each pack draws its own weight in kg from the batch and consumes its packing material. Stock sold by weight is counted in kg, not by the pack.`
              : `Each pack draws its own size in litres from the batch and consumes its packing material — a 250 ml bottle draws 0.25 L, so 10 of them draw 2.5 L.`}
        </div>
      </Modal>
    </div>
  )
}
