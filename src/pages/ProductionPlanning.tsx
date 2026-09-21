/**
 * Production planning — the way it actually happens on the floor.
 *
 * A plan is not written from thin air. It starts from what must ship: the open
 * customer orders. From those, subtract the finished goods already released and
 * sitting in store, and what is left is what the plant has to make. The demand
 * table at the top does that arithmetic per pack product; its Plan button hands
 * the answer straight to a plan.
 *
 * A packing plan needs bulk behind it, so the form says how much: the packs it
 * will fill, against the bulk already released, and the shelf life the packs
 * will carry — which is why the plan dates soonest-first: fresh product is
 * packed as close to its dispatch as the lab allows.
 *
 * A plan still books nothing. When the day comes, the run is posted as usual on
 * Production or Packing; the plan only ever said what was coming.
 */

import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { detailRowProps } from '../components/detailRow'
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
import { useApp } from '../context/AppContext'
import { fmtDate, fmtQty, statusLabel, toDateKey } from '../lib/utils'
import { stockRows } from '../lib/stock'
import type { PlanStage, PlanStatus, ProductionPlan } from '../types'

const STAGES: PlanStage[] = ['Extraction', 'Melange', 'Packing']
const UOMS: ProductionPlan['uom'][] = ['Litre', 'Kg', 'Packs']
const STATUS_FILTERS: (PlanStatus | '')[] = ['', 'Planned', 'In progress', 'Done', 'Cancelled']

const blankForm = () => ({
  date: toDateKey(),
  stage: 'Packing' as PlanStage,
  product: '',
  qty: '' as number | '',
  uom: 'Packs' as ProductionPlan['uom'],
  note: '',
})

const num = (v: number | '') => (v === '' ? 0 : Number(v))

/**
 * One pack product's week: what the open orders ask for, what is released and
 * waiting in store, and the difference the plant has to make.
 */
interface DemandRow {
  sku: string
  name: string
  due: number
  released: number
  toMake: number
}

export function ProductionPlanning() {
  const { state, addPlan, updatePlan, setPlanStatus, deletePlan } = useApp()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<PlanStatus | ''>('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [form, setForm] = useState(blankForm)

  const editing = editId ? state.productionPlans.find((p) => p.id === editId) : undefined

  // ── What must ship: open orders, netted against released finished goods ──────
  const demand = useMemo<DemandRow[]>(() => {
    const due: Record<string, number> = {}
    for (const o of state.orders) {
      if (o.status !== 'Open') continue
      for (const l of o.lines) due[l.sku] = (due[l.sku] || 0) + l.qty
    }
    const released: Record<string, number> = {}
    for (const r of stockRows(state)) {
      if (r.itemType !== 'Finished Goods' || r.status !== 'Released') continue
      released[r.item] = (released[r.item] || 0) + r.qty
    }
    const skus = [...new Set([...Object.keys(due), ...Object.keys(released)])]
    return skus
      .map((sku) => {
        const d = due[sku] || 0
        const rel = released[sku] || 0
        return {
          sku,
          name: state.products.find((p) => p.id === sku)?.name || sku,
          due: d,
          released: rel,
          toMake: Math.max(0, d - rel),
        }
      })
      .sort((a, b) => b.toMake - a.toMake || b.due - a.due)
  }, [state])

  // ── The plan list ────────────────────────────────────────────────────────────
  /** Today and onwards soonest-first, then the past newest-first. */
  const ordered = useMemo(() => {
    const today = toDateKey()
    const upcoming = state.productionPlans.filter((p) => p.date >= today)
    const past = state.productionPlans.filter((p) => p.date < today)
    upcoming.sort((a, b) => a.date.localeCompare(b.date))
    past.sort((a, b) => b.date.localeCompare(a.date))
    return [...upcoming, ...past]
  }, [state.productionPlans])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ordered.filter(
      (p) =>
        (!status || p.status === status) &&
        (!q || [p.id, p.product, p.stage, p.note || ''].join(' ').toLowerCase().includes(q)),
    )
  }, [ordered, search, status])

  const { sort, toggle, setSort } = useTableSort()
  const sortBy: SortAccessors<ProductionPlan> = {
    id: (p) => p.id,
    date: (p) => p.date,
    stage: (p) => p.stage,
    product: (p) => p.product,
    qty: (p) => p.qty,
    status: (p) => p.status,
  }
  const sorted = sortRows(shown, sort, sortBy)

  // ── The form, and what it can say about the product it names ────────────────
  /** What the form's product field can offer, by stage: bulk items to make,
   *  pack products to fill. */
  const productPicks = useMemo(() => {
    if (form.stage === 'Packing') return state.products.map((p) => p.name)
    const bulk = state.items.filter((i) => i.type === 'Semi Finished').map((i) => i.name)
    return [...new Set(bulk)]
  }, [form.stage, state.items, state.products])

  /** The pack product whose name the form holds, if it names one. */
  const namedProduct = state.products.find((p) => p.name === form.product.trim())
  const namedBulk = state.items.find((i) => i.type === 'Semi Finished' && i.name === form.product.trim())

  /** Released bulk on hand for whichever item the form is really about: the pack
   *  product's bulk behind a packing plan, or the named bulk itself. */
  const bulkOnHand = useMemo(() => {
    const itemId =
      form.stage === 'Packing' ? namedProduct?.bulkItem : namedBulk?.id
    if (!itemId) return null
    return stockRows(state)
      .filter((r) => r.item === itemId && r.status === 'Released')
      .reduce((a, r) => a + r.qty, 0)
  }, [form.stage, namedBulk, namedProduct, state])

  const openNew = () => {
    setEditId('')
    setForm(blankForm())
    setOpen(true)
  }

  /** Start a plan off a demand row: the packing the week is short of. */
  const planFromDemand = (row: DemandRow) => {
    setEditId('')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    setForm({
      date: toDateKey(tomorrow),
      stage: 'Packing',
      product: row.name,
      qty: row.toMake || '',
      uom: 'Packs',
      note: row.due > 0 ? `Open orders: ${row.due} packs` : '',
    })
    setOpen(true)
  }

  const openEdit = (p: ProductionPlan) => {
    setEditId(p.id)
    setForm({
      date: p.date,
      stage: p.stage,
      product: p.product,
      qty: p.qty,
      uom: p.uom,
      note: p.note || '',
    })
    setOpen(true)
  }

  const save = () => {
    const input = {
      date: form.date,
      stage: form.stage,
      product: form.product,
      qty: num(form.qty),
      uom: form.uom,
      note: form.note,
    }
    const ok = editing ? updatePlan(editing.id, input) : addPlan(input)
    if (ok) {
      setOpen(false)
      setEditId('')
    }
  }

  const openCount = shown.filter((p) => p.status === 'Planned' || p.status === 'In progress').length

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Production Planning</h3>
          <span>What must ship, what that leaves to make, and the week that makes it</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={openNew}>
            + New Plan
          </button>
        </div>
      </div>

      {/* ── What must ship ── */}
      <div className="section-head" style={{ marginTop: 4 }}>
        <div>
          <h4>What must ship</h4>
          <span className="small">
            Open orders, less the released stock already in store — the rest has to be made
          </span>
        </div>
      </div>
      {demand.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="cell-num cell-tight">Due (open orders)</th>
                <th className="cell-num cell-tight">Released in store</th>
                <th className="cell-num cell-tight">To make</th>
                <th className="cell-actions">Action</th>
              </tr>
            </thead>
            <tbody>
              {demand.map((row) => (
                <tr key={row.sku}>
                  <td data-label="Product">
                    <b>{row.name}</b>
                    <div className="cell-sub cell-id">{row.sku}</div>
                  </td>
                  <td data-label="Due (open orders)" className="cell-num cell-tight">
                    {row.due || '—'}
                  </td>
                  <td data-label="Released in store" className="cell-num cell-tight">
                    {row.released || '—'}
                  </td>
                  <td data-label="To make" className="cell-num cell-tight">
                    {row.toMake ? (
                      <b>{fmtQty(row.toMake)} packs</b>
                    ) : (
                      <span className="small">Covered</span>
                    )}
                  </td>
                  <td className="cell-actions">
                    {row.toMake ? (
                      <button className="btn btn-light" type="button" onClick={() => planFromDemand(row)}>
                        Plan
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <EmptyState
            filtered={false}
            empty="No open orders and no released packs — nothing has to be made."
            onClear={() => undefined}
          />
        </div>
      )}

      {/* ── The plan ── */}
      <div className="section-head" style={{ marginTop: 18 }}>
        <div>
          <h4>The plan</h4>
          <span className="small">Soonest first. A plan books nothing — the run is posted as usual when the day comes.</span>
        </div>
      </div>
      <div className="toolbar">
        <input
          placeholder="Search plan, product, stage or note"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value as PlanStatus | '')}>
          {STATUS_FILTERS.map((s) => (
            <option key={s || 'all'} value={s}>
              {s || 'All statuses'}
            </option>
          ))}
        </Select>
        <span className="small">
          {openCount} open {openCount === 1 ? 'plan' : 'plans'}
        </span>
      </div>

      <SortSelect
        sort={sort}
        onPick={setSort}
        columns={[
          { k: 'date', label: 'Date', kind: 'date' },
          { k: 'stage', label: 'Stage' },
          { k: 'product', label: 'Product' },
          { k: 'qty', label: 'Qty', kind: 'num' },
          { k: 'status', label: 'Status' },
        ]}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Plan" k="id" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Date" k="date" sort={sort} onToggle={toggle} />
              <SortHeader label="Stage" k="stage" sort={sort} onToggle={toggle} />
              <SortHeader label="Product" k="product" sort={sort} onToggle={toggle} />
              <SortHeader label="Qty" k="qty" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
              <th className="cell-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={7} className="empty">
                  <EmptyState
                    filtered={!!search.trim() || !!status}
                    empty="No plans yet. Start from what must ship above, or add a plan by hand."
                    onClear={() => {
                      setSearch('')
                      setStatus('')
                    }}
                  />
                </td>
              </tr>
            ) : (
              sorted.map((p) => (
                <tr key={p.id} {...detailRowProps(() => openEdit(p))}>
                  <td data-label="Plan" className="cell-id">
                    <b>{p.id}</b>
                  </td>
                  <td data-label="Date" className="cell-tight">
                    {fmtDate(p.date)}
                    {p.note ? <div className="cell-sub">{p.note}</div> : null}
                  </td>
                  <td data-label="Stage" className="cell-tight">
                    {p.stage}
                  </td>
                  <td data-label="Product">{p.product}</td>
                  <td data-label="Qty" className="cell-num cell-tight">
                    {fmtQty(p.qty)} {p.uom === 'Packs' ? 'packs' : p.uom.toLowerCase()}
                  </td>
                  <td data-label="Status" className="cell-tight">
                    <StatusBadge value={statusLabel(p.status)} />
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      {p.status === 'Planned' ? (
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => setPlanStatus(p.id, 'In progress')}
                        >
                          Start
                        </button>
                      ) : null}
                      {p.status === 'In progress' ? (
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={() => setPlanStatus(p.id, 'Done')}
                        >
                          Done
                        </button>
                      ) : null}
                      {p.status === 'Planned' || p.status === 'In progress' ? (
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => setPlanStatus(p.id, 'Cancelled')}
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => setPlanStatus(p.id, 'Planned')}
                        >
                          Reopen
                        </button>
                      )}
                      <button className="btn btn-light" type="button" onClick={() => openEdit(p)}>
                        Edit
                      </button>
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => {
                          if (confirm(`Delete ${p.id}? Plans are not stock records — this just removes the row.`)) {
                            deletePlan(p.id)
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

      <Modal
        open={open}
        title={editing ? `Edit ${editing.id}` : 'New plan'}
        saveLabel={editing ? 'Save Changes' : 'Add Plan'}
        onClose={() => {
          setOpen(false)
          setEditId('')
        }}
        onSave={save}
      >
        <div className="form-grid">
          <div className="field">
            <label>Day</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Stage</label>
            <Select
              value={form.stage}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  stage: e.target.value as PlanStage,
                  // The two stages of making bulk and the one that fills it measure
                  // their plans differently, so the unit follows the stage.
                  uom: e.target.value === 'Packing' ? 'Packs' : f.uom === 'Packs' ? 'Litre' : f.uom,
                }))
              }
            >
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="field span-2">
            <label>Product</label>
            <input
              value={form.product}
              placeholder={form.stage === 'Packing' ? 'e.g. OG TCW 5 L' : 'e.g. Coconut Water (bulk)'}
              onChange={(e) => setForm((f) => ({ ...f, product: e.target.value }))}
            />
            {productPicks.length ? (
              <div className="quick-picks">
                {productPicks.slice(0, 6).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`quick-pick${form.product === name ? ' picked' : ''}`}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        product: name,
                      }))
                    }
                  >
                    {name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="field">
            <label>Quantity</label>
            <input
              type="number"
              min={0}
              value={form.qty}
              placeholder="0"
              onChange={(e) =>
                setForm((f) => ({ ...f, qty: e.target.value === '' ? '' : Number(e.target.value) }))
              }
            />
          </div>
          <div className="field">
            <label>Unit</label>
            <Select
              value={form.uom}
              onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value as ProductionPlan['uom'] }))}
            >
              {UOMS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </div>
          {/* The arithmetic a planner does in their head, said out loud: what a
              packing plan draws, what is already released, and how long the
              packs keep. */}
          {form.stage === 'Packing' && namedProduct && namedProduct.packVolume ? (
            <div className="field span-2">
              {(() => {
                const needed = num(form.qty) * (namedProduct.packVolume || 0)
                const bulkName =
                  state.items.find((i) => i.id === namedProduct.bulkItem)?.name ||
                  namedProduct.bulkItem
                const onHand = bulkOnHand ?? 0
                const short = needed > 0 && onHand < needed
                return (
                  <div className={`note${short ? ' warning-note' : ''}`} style={{ margin: 0 }}>
                    {needed > 0 ? (
                      <>
                        Fills <b>{fmtQty(needed)} L</b> of {bulkName} · {fmtQty(onHand)} L released in
                        store
                        {short ? (
                          <>
                            {' '}
                            — short by <b>{fmtQty(needed - onHand)} L</b>; plan an extraction or melange first
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>Pick a quantity to see how much {bulkName} this run draws.</>
                    )}
                    {namedProduct.shelfLifeDays ? (
                      <>
                        <br />
                        {namedProduct.shelfLifeDays}-day shelf life — pack close to its dispatch date.
                      </>
                    ) : null}
                  </div>
                )
              })()}
            </div>
          ) : null}
          {form.stage !== 'Packing' && namedBulk && bulkOnHand != null ? (
            <div className="field span-2">
              <div className="note" style={{ margin: 0 }}>
                {fmtQty(bulkOnHand)} {namedBulk.name.toLowerCase()} released in store now.
              </div>
            </div>
          ) : null}
          <div className="field span-2">
            <label>Note (optional)</label>
            <input
              value={form.note}
              placeholder="Anything the floor should know about this run"
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
