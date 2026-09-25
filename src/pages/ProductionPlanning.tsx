/**
 * Production planning — the pathway from open orders to the runs that make them.
 *
 * A plan is not written from thin air. It starts from what must ship: the open
 * customer orders. The demand table reads them the way the floor does — by
 * drink, not by pack SKU. Each drink row works out the bulk its packs commit —
 * both the ones still to fill and the ones a packing plan on the board will
 * draw when it runs — then nets that against the bulk released in the cold room
 * and the bulk the extraction and melange plans on the board will make, and
 * says whether more bulk must be extracted or blended — a melange's components
 * spelled out in their shares. The pack formats sit beneath their drink, each
 * with its own Plan button, so the page reads as the week's pathway: extract or
 * blend so much, then pack it into these formats.
 *
 * A plan raised from that table carries the order ids it serves, so the link
 * outlives the note text: the list reads it back, and flags a plan whose orders
 * have all left Open — moot work the planner can cancel, letting demand ask again.
 *
 * The demand can be scoped to a week by the orders' ship-by days. What is late
 * is the most urgent work on the page, so a window never hides an overdue order,
 * nor one with no ship-by day at all.
 *
 * A packing plan needs bulk behind it, so the form says how much: the packs it
 * will fill, against the bulk already released, and the shelf life the packs
 * will carry — which is why the plan dates soonest-first: fresh product is
 * packed as close to its dispatch as the lab allows.
 *
 * A plan still books nothing. When the day comes, the run is posted as usual on
 * Production or Packing; the plan only ever said what was coming.
 */

import { Fragment, useMemo, useState } from 'react'
import { DocLink } from '../components/DocLink'
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
import { bulkItemOf, bulkUomForUnit, drinkName } from '../lib/packs'
import { stockRows } from '../lib/stock'
import {
  bulkSentence,
  filterPlans,
  horizonWindow,
  orderedPlans,
  planDemand,
  productPicks as productPicksFor,
  servesClosed as servesClosedOrders,
  shortUom,
  type DrinkRow,
  type FormatRow,
} from '../lib/planningView'
import type { PlanStage, PlanStatus, ProductionPlan } from '../types'

const STAGES: PlanStage[] = ['Extraction', 'Melange', 'Packing']
/** Each stage measures its plans in its own units: packs when filling, bulk when making. */
const PACKING_UOMS: ProductionPlan['uom'][] = ['Packs']
const BULK_UOMS: ProductionPlan['uom'][] = ['Litre', 'Kg']
const STATUS_FILTERS: (PlanStatus | '')[] = ['', 'Planned', 'In progress', 'Done', 'Cancelled']

const blankForm = () => ({
  date: toDateKey(),
  stage: 'Packing' as PlanStage,
  product: '',
  qty: '' as number | '',
  uom: 'Packs' as ProductionPlan['uom'],
  note: '',
  serves: [] as string[],
})

const num = (v: number | '') => (v === '' ? 0 : Number(v))

/** A heavier rule above each drink row, so the groups read as groups. */
const drinkRowTop = { borderTop: '2px solid var(--line)' } as const

export function ProductionPlanning() {
  const { state, addPlan, updatePlan, setPlanStatus, deletePlan } = useApp()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<PlanStatus | ''>('')
  const [horizon, setHorizon] = useState<'all' | 'week' | 'next'>('all')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [form, setForm] = useState(blankForm)

  const editing = editId ? state.productionPlans.find((p) => p.id === editId) : undefined

  // ── What must ship: open orders by drink, netted against released stock and
  //    the plans already on the board ────────────────────────────────────────────
  const win = useMemo(() => horizonWindow(horizon), [horizon])
  const demand = useMemo(() => planDemand(state, win), [state, win])

  // ── The plan list ────────────────────────────────────────────────────────────
  const ordered = useMemo(() => orderedPlans(state.productionPlans), [state.productionPlans])
  const shown = useMemo(() => filterPlans(ordered, search, status), [ordered, search, status])

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
  // productPicksFor reads exactly these three collections of state (see
  // planningView) — whole-state deps would recompute on every unrelated save.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const productPicks = useMemo(
    () => productPicksFor(state, form.stage),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.stage, state.items, state.melanges, state.products],
  )

  const namedProduct = state.products.find((p) => p.name === form.product.trim())
  const namedBulk = state.items.find((i) => i.type === 'Semi Finished' && i.name === form.product.trim())

  /** The bulk item the form is really about: the pack product's bulk behind a
   *  packing plan (legacy fallback included), or the named bulk itself. */
  const formBulkId =
    form.stage === 'Packing'
      ? namedProduct
        ? bulkItemOf(namedProduct)
        : undefined
      : namedBulk?.id
  const formBulk = state.items.find((i) => i.id === formBulkId)
  const formBulkUom = formBulk?.uom || (namedProduct ? bulkUomForUnit(namedProduct.unit) : 'Litre')
  const formBulkUnit = shortUom(formBulkUom)

  const bulkOnHand = useMemo(() => {
    if (!formBulkId) return null
    return stockRows(state)
      .filter((r) => r.item === formBulkId && r.status === 'Released')
      .reduce((a, r) => a + r.qty, 0)
  }, [formBulkId, state])

  const openNew = () => {
    setEditId('')
    setForm(blankForm())
    setOpen(true)
  }

  /** Picking a product follows it with the unit it is counted in. A different
   *  product breaks the order link the plan was raised with, so the link goes. */
  const pickProduct = (name: string) => {
    setForm((f) => {
      const serves = f.product === name ? f.serves : []
      if (f.stage === 'Packing') return { ...f, product: name, uom: 'Packs', serves }
      const item = state.items.find((i) => i.name === name)
      return { ...f, product: name, uom: item?.uom === 'Kg' ? 'Kg' : item ? 'Litre' : f.uom, serves }
    })
  }

  /** Start a packing plan off a format the drink is short of. */
  const planPacking = (row: FormatRow) => {
    setEditId('')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    setForm({
      date: toDateKey(tomorrow),
      stage: 'Packing',
      product: row.name,
      qty: row.toMake || '',
      uom: 'Packs',
      note:
        row.due > 0
          ? `Open orders: ${row.due} packs${row.planned ? ` · ${row.planned} already planned` : ''}`
          : '',
      serves: row.orders,
    })
    setOpen(true)
  }

  /** Start the upstream plan a drink row asks for: extraction or the blend. */
  const planBulkRun = (d: DrinkRow) => {
    if (!d.bulkId || !d.toMakeBulk) return
    const item = state.items.find((i) => i.id === d.bulkId)
    if (!item) return
    setEditId('')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const openFormats = d.formats
      .filter((f) => f.toMake > 0)
      .map((f) => `${f.name}: ${fmtQty(f.toMake)}`)
      .join(', ')
    setForm({
      date: toDateKey(tomorrow),
      stage: d.isMelange ? 'Melange' : 'Extraction',
      product: item.name,
      qty: d.toMakeBulk,
      uom: d.uom === 'Kg' ? 'Kg' : 'Litre',
      note: [
        openFormats ? `For open orders — ${openFormats}` : '',
        d.plannedBulk
          ? `${fmtQty(d.plannedBulk)} ${shortUom(d.uom)} already planned on the board`
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      serves: d.orders,
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
      serves: p.serves || [],
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
      serves: form.serves,
    }
    const ok = editing ? updatePlan(editing.id, input) : addPlan(input)
    if (ok) {
      setOpen(false)
      setEditId('')
    }
  }

  const openCount = shown.filter((p) => p.status === 'Planned' || p.status === 'In progress').length

  const servesClosed = (p: ProductionPlan) => servesClosedOrders(state.orders, p)

  /** The order link a plan carries, said under its number in the list. */
  const servesNote = (p: ProductionPlan) =>
    p.serves?.length ? (
      <div className="cell-sub">
        serves{' '}
        {p.serves.slice(0, 3).map((id, i) => (
          <Fragment key={id}>
            {i > 0 ? ', ' : ''}
            <DocLink doc={id} />
          </Fragment>
        ))}
        {p.serves.length > 3 ? ` +${p.serves.length - 3} more` : ''}
      </div>
    ) : null

  /** What a packing plan draws, said under its quantity in the list. */
  const fillsNote = (p: ProductionPlan) => {
    if (p.stage !== 'Packing' || p.uom !== 'Packs') return null
    const prod = state.products.find((x) => x.name === p.product)
    if (!prod?.packVolume) return null
    const item = state.items.find((i) => i.id === bulkItemOf(prod))
    return (
      <div className="cell-sub">
        fills {fmtQty(p.qty * prod.packVolume)} {shortUom(item?.uom || 'Litre')} of{' '}
        {drinkName(item?.name || bulkItemOf(prod))}
      </div>
    )
  }

  const uomBase = form.stage === 'Packing' ? PACKING_UOMS : BULK_UOMS
  /** A plan saved before units followed the stage keeps its old unit visible. */
  const uomOptions: ProductionPlan['uom'][] =
    form.uom && !uomBase.includes(form.uom) ? [form.uom, ...uomBase] : uomBase

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Production Planning</h3>
          <span>What must ship, what that leaves to make, and the plans that make it</span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={openNew}>
            + New Plan
          </button>
        </div>
      </div>

      {/* ── What must ship, by drink ── */}
      <div className="section-head" style={{ marginTop: 4 }}>
        <div>
          <h4>What must ship</h4>
          <span className="small">
            Open orders by drink, less released stock and the plans already on the board — the bulk
            to extract or blend above, the pack formats beneath. Overdue and undated orders are
            never hidden by a week.
          </span>
        </div>
        <div className="section-head-actions">
          <Select
            value={horizon}
            aria-label="Order horizon"
            onChange={(e) => setHorizon(e.target.value as 'all' | 'week' | 'next')}
          >
            <option value="all">All open orders</option>
            <option value="week">Due this week</option>
            <option value="next">Due next week</option>
          </Select>
        </div>
      </div>
      {demand.drinks.length ? (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Drink / pack format</th>
                  <th className="cell-num cell-tight">Due (open orders)</th>
                  <th className="cell-num cell-tight">In store</th>
                  <th className="cell-num cell-tight">On the board</th>
                  <th className="cell-num cell-tight">To make</th>
                  <th className="cell-actions">Action</th>
                </tr>
              </thead>
              <tbody>
                {demand.drinks.map((d) => {
                  const u = shortUom(d.uom)
                  return (
                    <Fragment key={d.key}>
                      <tr>
                        <td style={drinkRowTop}>
                          <b>{d.name}</b>
                          <div className="cell-sub">
                            {d.isMelange ? 'Blend, then pack' : 'Extract, then pack'}
                          </div>
                          {d.overdue > 0 ? (
                            <div className="cell-sub" style={{ color: 'var(--warning)' }}>
                              {d.overdue} open {d.overdue === 1 ? 'order' : 'orders'} past{' '}
                              {d.overdue === 1 ? 'its' : 'their'} ship-by date
                            </div>
                          ) : null}
                          {d.components.length ? (
                            <div className="cell-sub">
                              Needs{' '}
                              {d.components
                                .map((c) => `${fmtQty(c.qty)} ${shortUom(c.uom)} ${c.name}`)
                                .join(' · ')}
                            </div>
                          ) : null}
                        </td>
                        {d.bulkId ? (
                          <>
                            <td colSpan={3} className="cell-sub" style={drinkRowTop}>
                              {bulkSentence(d)}
                            </td>
                            <td
                              data-label="To make"
                              className="cell-num cell-tight"
                              style={drinkRowTop}
                            >
                              <b>
                                {fmtQty(d.toMakeBulk)} {u}
                              </b>
                            </td>
                            <td className="cell-actions" style={drinkRowTop}>
                              {d.toMakeBulk > 0 ? (
                                <button
                                  className="btn btn-light"
                                  type="button"
                                  onClick={() => planBulkRun(d)}
                                >
                                  Plan {d.isMelange ? 'blend' : 'extraction'}
                                </button>
                              ) : null}
                            </td>
                          </>
                        ) : (
                          <>
                            <td colSpan={3} className="cell-sub" style={drinkRowTop}>
                              Ordered, but no longer in the product master — it cannot be planned
                              until it is back.
                            </td>
                            <td className="cell-num cell-tight" style={drinkRowTop}>
                              —
                            </td>
                            <td className="cell-actions" style={drinkRowTop} />
                          </>
                        )}
                      </tr>
                      {d.formats.map((f) => (
                        <tr key={f.sku}>
                          <td data-label="Pack format">↳ {f.name}</td>
                          <td data-label="Due (open orders)" className="cell-num cell-tight">
                            {f.due || '—'}
                          </td>
                          <td data-label="In store" className="cell-num cell-tight">
                            {f.released || '—'}
                          </td>
                          <td data-label="On the board" className="cell-num cell-tight">
                            {f.planned || '—'}
                          </td>
                          <td data-label="To make" className="cell-num cell-tight">
                            {f.toMake ? (
                              <b>{fmtQty(f.toMake)} packs</b>
                            ) : (
                              <span className="small">Covered</span>
                            )}
                          </td>
                          <td className="cell-actions">
                            {f.toMake && f.product ? (
                              <button
                                className="btn btn-light"
                                type="button"
                                onClick={() => planPacking(f)}
                              >
                                Plan packing
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {demand.covered > 0 ? (
            <div className="small" style={{ padding: '8px 2px 0' }}>
              {demand.covered} drink{demand.covered === 1 ? '' : 's'} fully covered by released stock
              or plans already on the board — hidden.
            </div>
          ) : null}
          {win && demand.beyond > 0 ? (
            <div className="small" style={{ padding: '8px 2px 0' }}>
              {demand.beyond} open {demand.beyond === 1 ? 'order is' : 'orders are'} due beyond this
              window — All open orders shows {demand.beyond === 1 ? 'it' : 'them'}.
            </div>
          ) : null}
        </>
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
                    {servesNote(p)}
                    {servesClosed(p) ? (
                      <div className="cell-sub" style={{ color: 'var(--warning)' }}>
                        its orders are no longer open
                      </div>
                    ) : null}
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
                    {fillsNote(p)}
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
                  // The stages name different products, so the pick cannot follow
                  // the stage across; and the unit follows the stage.
                  product: '',
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
            <Select value={form.product} onChange={(e) => pickProduct(e.target.value)}>
              <option value="">
                {form.stage === 'Packing' ? 'Pick the pack product' : 'Pick the bulk'}
              </option>
              {productPicks.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {/* A plan saved against a since-renamed product keeps its value pickable. */}
              {form.product && !productPicks.includes(form.product) ? (
                <option value={form.product}>{form.product}</option>
              ) : null}
            </Select>
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
              {uomOptions.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </div>
          {/* The arithmetic a planner does in their head, said out loud: what a
              packing plan draws, what is already released, and how long the
              packs keep. */}
          {form.stage === 'Packing' && namedProduct ? (
            <div className="field span-2">
              {(() => {
                const needed =
                  form.uom === 'Packs'
                    ? num(form.qty) * (namedProduct.packVolume || 0)
                    : num(form.qty)
                const bulkName = formBulk?.name || formBulkId || 'its bulk'
                const onHand = bulkOnHand ?? 0
                const short = needed > 0 && onHand < needed
                return (
                  <div className={`note${short ? ' warning-note' : ''}`} style={{ margin: 0 }}>
                    {needed > 0 ? (
                      <>
                        Fills <b>
                          {fmtQty(needed)} {formBulkUnit}
                        </b>{' '}
                        of {drinkName(bulkName)} · {fmtQty(onHand)} {formBulkUnit} released in store
                        {short ? (
                          <>
                            {' '}
                            — short by <b>
                              {fmtQty(needed - onHand)} {formBulkUnit}
                            </b>
                            ; plan an extraction or melange first
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>Pick a quantity to see how much {drinkName(bulkName)} this run draws.</>
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
                {fmtQty(bulkOnHand)} {formBulkUnit} of {drinkName(namedBulk.name)} released in store
                now.
                {(() => {
                  const recipe = state.melanges.find((m) => m.outputItem === namedBulk.id)
                  if (!recipe) return null
                  return (
                    <>
                      <br />
                      Blend:{' '}
                      {recipe.components
                        .map((c) => {
                          const ci = state.items.find((i) => i.id === c.item)
                          return `${c.share}% ${drinkName(ci?.name || c.item)}`
                        })
                        .join(' · ')}
                    </>
                  )
                })()}
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
          {form.serves.length ? (
            <div className="field span-2">
              <div className="note" style={{ margin: 0 }}>
                Raised for {form.serves.join(', ')} — the link stays with the plan even if the note
                is edited away.
              </div>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
