import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DetailView, type DetailSection } from '../components/DetailView'
import { detailRowProps } from '../components/detailRow'
import { DocLink } from '../components/DocLink'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import {
  SortHeader,
  SortSelect,
  sortRows,
  useTableSort,
  type SortAccessors,
} from '../components/tableSort'
import { StatusBadge } from '../components/StatusBadge'
import { EmptyState } from '../components/EmptyState'
import { useApp } from '../context/AppContext'
import { bulkItems, fmtBulk, itemUom } from '../lib/batches'
import { bulkItemOf, formatSize } from '../lib/packs'
import { useLinkedView } from '../lib/linkedView'
import { DRAWABLE, defaultPackStore, sampleBulk } from '../lib/posting'
import { addDays, retentionDays, sampleProductName, sampleStatus } from '../lib/controlSamples'
import { itemName as lookupItemName, stockRowsExcluding, areaChoices } from '../lib/stock'
import { fmtDate, inr, toDateKey, toLocalInputValue, QTY_EPSILON } from '../lib/utils'
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

/** One product's control samples: what they went into, how many, and who took them. */
interface SampleRow {
  /** A pack product, `OTHER` for another container, or empty until picked. */
  sku: string
  sizeMl: number | ''
  count: number | ''
  collectedBy: string
}

/** Stands for a container that is not one of the plant's packs. */
const OTHER = '__other'
const blankSample: SampleRow = { sku: '', sizeMl: 100, count: '', collectedBy: '' }
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
  const [sampleRows, setSampleRows] = useState<Keyed<SampleRow>[]>([keyed(blankSample)])

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
   * Where the packs can go. They go into a storage area off the line and stay there while
   * the lab works — QC changes their status where they stand, it does not move them. Hold
   * areas are not offered: they only take stock QC has rejected.
   */
  const packDestinations = useMemo(
    () => areaChoices(state, 'Finished Goods', 'Quarantine', location),
    [location, state],
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

  const { sort, toggle, setSort } = useTableSort()
  const sortBy: SortAccessors<PackingRun> = {
    id: (r) => r.id,
    date: (r) => r.date,
    batch: (r) => r.batchId,
    from: (r) => itemName(runBulk(r)),
    drawn: (r) => r.drawn,
    packs: (r) => r.lines.reduce((a, l) => a + l.packs, 0),
    status: (r) => r.status,
  }
  const sorted = sortRows(list, sort, sortBy)

  /** Pack products are numbered FG-0001, so a run reads better by name than by code. */
  const skuLabel = (sku: string) => state.products.find((p) => p.id === sku)?.name || sku

  const available = batchId ? bulkByBatch.get(batchId) || 0 : 0
  /** What one line draws: the pack's own size × how many, in base units. */
  const lineDraw = (r: PackRow) =>
    num(r.packs) * (state.products.find((x) => x.id === r.sku)?.packVolume || 0)
  /** The control-sample lines, in the shape the posting reads. */
  const sampleInputs = sampleRows
    .filter((r) => r.sku || num(r.count) > 0)
    .map((r) => ({
      sku: r.sku && r.sku !== OTHER ? r.sku : undefined,
      count: num(r.count),
      sizeMl: r.sku === OTHER ? num(r.sizeMl) : undefined,
      collectedBy: r.collectedBy,
    }))
  const sampleDraw = sampleInputs.reduce((a, s) => a + sampleBulk(state, s), 0)
  const willDraw = packRows.reduce((a, r) => a + lineDraw(r), 0) + sampleDraw
  const keepDays = retentionDays(state.config)
  const packedOn = new Date(date)
  const sampleExpiry = Number.isNaN(packedOn.getTime()) ? '' : addDays(toDateKey(packedOn), keepDays)

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
    setLocation(defaultPackStore(state) || '')
    setSampleRows([keyed(blankSample)])
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
    setSampleRows(
      run.controlSamples?.length
        ? keyedAll(
            run.controlSamples.map((s) => ({
              sku: s.sku || OTHER,
              sizeMl: s.sizeMl || 100,
              count: s.count,
              collectedBy: s.collectedBy || '',
            })),
          )
        : [keyed(blankSample)],
    )
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
        ...(viewing.controlSamples?.length
          ? [
              {
                title: 'Control samples',
                fields: viewing.controlSamples.map((s) => ({
                  label: sampleProductName(state, viewing, s),
                  value: `${s.count} bottle(s)${s.collectedBy ? ` · collected by ${s.collectedBy}` : ''} · expires ${
                    s.expiresOn ? fmtDate(s.expiresOn) : '—'
                  } · ${sampleStatus(s)}${s.destroyedOn ? ` ${fmtDate(s.destroyedOn)}` : ''}`,
                  wide: true,
                })),
              },
            ]
          : []),
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
        the storage area you pick as they come off the line and stay there — the lab works while they sit, and
        QC clears or rejects them where they stand. Record the control samples kept back off the
        run on the same form, so the bulk and bottles they use are accounted for and they go on the
        Control Samples register.
      </div>

      <div className="toolbar">
        <input
          placeholder="Search run or batch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <SortSelect
        sort={sort}
        onPick={setSort}
        columns={[
          { k: 'id', label: 'Run', kind: 'text' },
          { k: 'date', label: 'Date', kind: 'date' },
          { k: 'batch', label: 'Batch', kind: 'text' },
          { k: 'from', label: 'From' },
          { k: 'drawn', label: 'Bulk drawn', kind: 'num' },
          { k: 'packs', label: 'Output (packs)', kind: 'num' },
          { k: 'status', label: 'Status' },
        ]}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Run" k="id" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Date" k="date" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Batch" k="batch" sort={sort} onToggle={toggle} />
              <SortHeader label="From" k="from" sort={sort} onToggle={toggle} />
              <SortHeader label="Bulk Drawn" k="drawn" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Output" k="packs" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
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
              sorted.map((r) => (
                <tr key={r.id} {...detailRowProps(() => setViewId(r.id))}>
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
          if (sampleRows.some((r) => !r.sku && num(r.count) > 0)) {
            showToast('Pick what each control sample was filled into.')
            return
          }
          const input = {
            date,
            batchId,
            bulkItem,
            location,
            controlSamples: sampleInputs,
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
                setPackRows([keyed(blankRow)])
                setSampleRows([keyed(blankSample)])
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
              Storage area
              <span className="small" style={{ fontWeight: 400 }}>
                {' '}
                — packs go in now and stay there; QC clears or rejects them where they stand
              </span>
            </label>
            <Select value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">Select storage area</option>
              {packDestinations.map((c) => (
                <option key={c.area.id} value={c.value}>
                  {c.text}
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

        {/* Control samples kept back as the packs go into the cold room. They take bulk —
            and a pack's bottle and cap — like a pack does, so the run has to know about
            them, but they are never stock and never carry a stock ID. */}
        <div className="subform">
          <div className="subform-head">
            <span>Control samples kept</span>
            <button
              className="btn btn-light"
              type="button"
              onClick={() => setSampleRows((r) => [...r, keyed(blankSample)])}
            >
              + Add line
            </button>
          </div>
          <div className="subform-body">
            <div className="subform-row sample-row pack-row-head">
              <span>Filled into</span>
              <span>Size</span>
              <span>Bottles</span>
              <span>Collected by</span>
              <span />
            </div>
            {sampleRows.map((row, idx) => {
              const p = products.find((x) => x.id === row.sku)
              const update = (patch: Partial<SampleRow>) =>
                setSampleRows((all) => all.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
              return (
                <div className="subform-row sample-row" key={row.rowId}>
                  <Select
                    value={row.sku}
                    disabled={!bulkItem}
                    onChange={(e) => update({ sku: e.target.value })}
                  >
                    <option value="">{bulkItem ? 'Select pack' : 'Pick a bulk first'}</option>
                    {products.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                    <option value={OTHER}>Other container</option>
                  </Select>
                  {row.sku === OTHER ? (
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder={bulkUom === 'Kg' ? 'g each' : 'ml each'}
                      value={row.sizeMl}
                      onChange={(e) => update({ sizeMl: e.target.value === '' ? '' : Number(e.target.value) })}
                    />
                  ) : (
                    <input disabled placeholder="Size" value={p ? formatSize(p.size, p.unit) : ''} />
                  )}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={row.count}
                    onChange={(e) => update({ count: e.target.value === '' ? '' : Number(e.target.value) })}
                  />
                  <input
                    placeholder="Name"
                    value={row.collectedBy}
                    onChange={(e) => update({ collectedBy: e.target.value })}
                  />
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() =>
                      setSampleRows((all) =>
                        all.length > 1 ? all.filter((_, i) => i !== idx) : [keyed(blankSample)],
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <div className="small" style={{ marginTop: 10 }}>
              {sampleDraw > 0
                ? `Takes ${fmtBulk(sampleDraw, bulkUom)} off the batch. `
                : 'Leave blank if none were kept. '}
              Control samples are never stock — no stock ID, and never in inventory, stickers or
              dispatch. One filled into a pack also uses that pack&apos;s bottle and cap. They go on the{' '}
              <b>Control Samples</b> register and expire {keepDays} day{keepDays === 1 ? '' : 's'} after
              the day they were packed{sampleExpiry ? ` — ${fmtDate(sampleExpiry)}` : ''}.
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
