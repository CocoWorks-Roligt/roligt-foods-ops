import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { buildExceptions } from '../lib/alerts'
import { batchInputUom, batchKind, batchWastage, batchYield, fmtBulk, mainOutput } from '../lib/batches'
import { fmtByUom, fmtRowTotal, sumByUom } from '../lib/stock'
import { inr } from '../lib/utils'
import { StatusBadge } from '../components/StatusBadge'
import type { StockRow } from '../types'

interface BreakdownLine {
  label: string
  qty: number
  uom: string
}

function breakdownByItem(
  rows: StockRow[],
  itemType: string,
  status: string,
  itemName: (id: string) => string,
): BreakdownLine[] {
  const byItem = new Map<string, BreakdownLine>()
  for (const r of rows) {
    if (r.itemType !== itemType || r.status !== status || r.qty <= 0) continue
    const existing = byItem.get(r.item)
    if (existing) existing.qty += r.qty
    else byItem.set(r.item, { label: itemName(r.item), qty: r.qty, uom: r.uom })
  }
  return Array.from(byItem.values()).sort((a, b) => b.qty - a.qty)
}

function breakdownByLot(rows: StockRow[], itemType: string, status: string): BreakdownLine[] {
  const byLot = new Map<string, BreakdownLine>()
  for (const r of rows) {
    if (r.itemType !== itemType || r.status !== status || r.qty <= 0) continue
    const existing = byLot.get(r.lot)
    if (existing) existing.qty += r.qty
    else byLot.set(r.lot, { label: r.lot, qty: r.qty, uom: r.uom })
  }
  return Array.from(byLot.values()).sort((a, b) => a.label.localeCompare(b.label))
}

export function Dashboard() {
  const { state, rows } = useApp()
  const navigate = useNavigate()
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({})
  const toggleCard = (key: string) => setOpenCards((o) => ({ ...o, [key]: !o[key] }))
  const itemName = (id: string) => state.items.find((i) => i.id === id)?.name || id

  /**
   * Each card names the units it is counting. Adding 80 pieces of coconut to 15
   * kilograms of beetroot and printing "95 units" was a number the floor could not
   * act on — and the breakdown underneath already told the truth, so the headline
   * was the only thing lying.
   */
  const held = (itemType: string, status: string) =>
    rows.filter((r) => r.itemType === itemType && r.status === status)
  const rmRows = held('Raw Material', 'Available')
  const pmRows = held('Packing Material', 'Available')
  const qRows = held('Finished Goods', 'Quarantine')
  const relRows = held('Finished Goods', 'Released')


  const cards = [
    {
      key: 'rm',
      label: 'Raw material available',
      value: fmtRowTotal(rmRows, 'None'),
      sub: 'Lot-controlled produce awaiting pressing',
      breakdown: breakdownByLot(rows, 'Raw Material', 'Available'),
      emptyText: 'No raw material on hand.',
    },
    {
      key: 'pm',
      label: 'Packing material available',
      value: fmtRowTotal(pmRows, 'None'),
      sub: 'Food-contact and outer packs',
      breakdown: breakdownByItem(rows, 'Packing Material', 'Available', itemName),
      emptyText: 'No packing material on hand.',
    },
    {
      key: 'fgQ',
      label: 'Finished goods awaiting QC',
      value: fmtRowTotal(qRows, 'None'),
      sub: 'Finished goods waiting for QC',
      breakdown: breakdownByItem(rows, 'Finished Goods', 'Quarantine', itemName),
      emptyText: 'No finished goods awaiting QC.',
    },
    {
      key: 'fgR',
      label: 'Finished goods released',
      value: fmtRowTotal(relRows, 'None'),
      sub: 'QC passed — ready to dispatch',
      breakdown: breakdownByItem(rows, 'Finished Goods', 'Released', itemName),
      emptyText: 'No released finished goods.',
    },
  ] as const

  const exceptions = buildExceptions(state, rows)

  const extractions = state.batches.filter((b) => batchKind(b) === 'Extraction')
  const melangeRuns = state.batches.filter((b) => batchKind(b) === 'Melange')
  // Only what extraction pressed. A melange run's output is bulk that extraction
  // already produced, blended — counting both totals the same litres twice.
  // Litres and kilograms are kept apart, because their sum means nothing.
  const pressed = extractions.reduce(
    (acc, b) => {
      const main = mainOutput(b)
      if (!main) return acc
      if (main.uom === 'Kg') acc.kg += main.qty
      else acc.litres += main.qty
      return acc
    },
    { litres: 0, kg: 0 },
  )
  const pressedLabel = [
    pressed.litres ? `${Number(pressed.litres.toFixed(1))} L` : '',
    pressed.kg ? `${Number(pressed.kg.toFixed(1))} kg` : '',
  ]
    .filter(Boolean)
    .join(' · ') || '0 L'
  /**
   * Yield only means something against the unit it was measured in — 0.205 L per
   * coconut and 0.5 L per kilo of beetroot average to 0.35 of nothing. Each pairing
   * of output unit and input unit is averaged on its own and printed with both.
   */
  const yieldByPair = new Map<string, { total: number; count: number }>()
  for (const b of extractions) {
    const out = mainOutput(b)
    if (!out) continue
    const key = `${out.uom === 'Kg' ? 'kg' : 'L'} / ${batchInputUom(b).toLowerCase()}`
    const acc = yieldByPair.get(key) || { total: 0, count: 0 }
    acc.total += batchYield(b)
    acc.count += 1
    yieldByPair.set(key, acc)
  }
  const yieldLabel =
    [...yieldByPair.entries()]
      .map(([pair, a]) => `${(a.total / a.count).toFixed(3)} ${pair}`)
      .join(' · ') || '—'

  // What never reached the press, and what it would have been worth at the rate the
  // rest of the load actually ran at. Both are kept apart by unit for the same reason.
  const spoiledLabel = fmtByUom(
    sumByUom(extractions.map((b) => ({ qty: b.spoiled || 0, uom: batchInputUom(b) }))),
    'None',
  )
  const wastageLabel = fmtByUom(
    sumByUom(
      extractions.map((b) => ({
        qty: batchWastage(b),
        uom: mainOutput(b)?.uom === 'Kg' ? 'kg' : 'L',
      })),
    ),
    '\u2014',
  )

  const today = [
    ['Goods receipts posted', state.grns.length],
    ['Extraction batches', extractions.length],
    ['Melange runs', melangeRuns.length],
    ['Bulk pressed (extraction only)', pressedLabel],
    ['Average yield per unit issued', yieldLabel],
    ['Spoiled produce', spoiledLabel],
    ['Lost to spoilage', wastageLabel],
    ['Batches awaiting QC', state.qcs.filter((q) => q.disposition === 'Pending').length],
    ['Dispatches delivered', state.dispatches.filter((d) => d.status === 'Delivered').length],
  ] as const

  /**
   * Finished goods by QC state, one bar per unit.
   *
   * A pack is a pack and malai is sold by weight, so this used to print a single
   * number that was two hundred packs added to fifty kilograms — a figure with no
   * physical meaning, on the dashboard's headline chart, while the cards above it
   * already knew better. A plant that only sells packs sees exactly what it saw
   * before; one that also sells by weight gets a second row rather than a wrong sum.
   */
  const fgStates = [
    ['Awaiting QC', qRows],
    ['Released', relRows],
    ['Rejected', held('Finished Goods', 'Rejected')],
  ] as const
  const fgUnits = [
    ...new Set(fgStates.flatMap(([, list]) => [...sumByUom(list).keys()])),
  ].sort()
  const fgBars = fgUnits.map((uom) => {
    const bars = fgStates.map(([label, list]) => ({
      label,
      qty: sumByUom(list).get(uom) || 0,
    }))
    return { uom, bars, max: Math.max(1, ...bars.map((x) => x.qty)) }
  })

  /**
   * A plant on its first day has nothing but four zeros to look at, and the order the
   * masters have to be created in is real — you cannot receive produce you have not
   * described, or dispatch to a customer who does not exist. So until the first receipt
   * is posted the dashboard says what to do next instead of reporting nothing.
   */
  const setupSteps = [
    { label: 'Add a farmer or vendor', done: state.vendors.length > 0, path: '/vendors' },
    {
      label: 'Describe what you buy and what you make it into',
      done: state.purchaseProducts.length > 0,
      path: '/purchase-products',
    },
    { label: 'Add a customer', done: state.customers.length > 0, path: '/customers' },
    { label: 'Receive your first delivery', done: state.grns.length > 0, path: '/procurement' },
  ]
  const showSetup = !state.grns.length
  const nextStep = setupSteps.find((s) => !s.done)

  return (
    <>
      {showSetup ? (
        <div className="card setup-card">
          <div className="section-head">
            <div>
              <h3>Start here</h3>
              <span>
                Nothing has been received yet. These come in order — each one needs the one
                above it.
              </span>
            </div>
          </div>
          <ol className="setup-steps">
            {setupSteps.map((step) => (
              <li key={step.path} className={step.done ? 'done' : ''}>
                <span className="setup-tick" aria-hidden="true">
                  {step.done ? '✓' : ''}
                </span>
                <span className="setup-label">{step.label}</span>
                <button
                  type="button"
                  className={`btn ${step === nextStep ? 'btn-primary' : 'btn-light'}`}
                  onClick={() => navigate(step.path)}
                >
                  {step.done ? 'Review' : 'Open'}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="section-head dashboard-export">
        <div>
          <h3>Plant summary</h3>
          <span className="small">
            Stock on hand right now — open a card to see it by item
          </span>
        </div>
      </div>

      <div className="card metric-strip">
        {cards.map((c) => {
          const isOpen = !!openCards[c.key]
          return (
            <div className="metric metric-expandable" key={c.key}>
              <button
                type="button"
                className="metric-expand-toggle"
                onClick={() => toggleCard(c.key)}
                aria-expanded={isOpen}
              >
                <div>
                  <div className="label">{c.label}</div>
                  <div className="value">{c.value}</div>
                  <div className="sub">{c.sub}</div>
                </div>
                <span className={`metric-chevron ${isOpen ? 'open' : ''}`}>⌄</span>
              </button>
              {isOpen ? (
                <div className="metric-breakdown">
                  {!c.breakdown.length ? (
                    <div className="empty">{c.emptyText}</div>
                  ) : (
                    c.breakdown.map((b) => (
                      <div className="metric-breakdown-row" key={b.label}>
                        <span>{b.label}</span>
                        <b>
                          {Math.round(b.qty)} {b.uom}
                        </b>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="split" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="section-head">
            <div>
              <h3>Needs attention</h3>
              <span className="small">QC holds, low stock, near-expiry, yield and cost variances</span>
            </div>
          </div>
          {!exceptions.length ? (
            <div className="empty">Nothing needs attention right now.</div>
          ) : (
            exceptions.map((e, i) => (
              <div className="kpi-row" key={`${e.title}-${i}`}>
                <div>
                  <b>
                    <span className="exception-category">{e.category}</span>
                    {e.title}
                  </b>
                  <div className="small">{e.detail}</div>
                </div>
                <StatusBadge value={e.status} />
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="section-head">
            <h3>Plant to date</h3>
            <span>Running totals, all time</span>
          </div>
          <div className="kpi-list">
            {today.map(([label, value]) => (
              <div className="kpi-row" key={label}>
                <span>{label}</span>
                <b>{value}</b>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="section-head">
            <h3>Finished goods by status</h3>
          </div>
          {!fgBars.length ? (
            <div className="empty">No finished goods on hand.</div>
          ) : (
            fgBars.map((group) => (
              <div key={group.uom}>
                {fgBars.length > 1 ? (
                  <div className="small" style={{ fontWeight: 800, marginTop: 8 }}>
                    Counted in {group.uom.toLowerCase()}
                  </div>
                ) : null}
                {group.bars.map(({ label, qty }) => (
                  <div style={{ margin: '12px 0' }} key={label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{label}</span>
                      <b>
                        {Number(qty.toFixed(2))} {group.uom}
                      </b>
                    </div>
                    <div className="bar">
                      <span style={{ width: `${(qty / group.max) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="section-head">
            <h3>Batch performance</h3>
          </div>
          {!state.batches.length ? (
            <div className="empty">No batches yet.</div>
          ) : (
            // Newest five by the date they were run. Insertion order is not the same
            // thing: a batch entered late for a run that happened last week is not the
            // latest batch.
            [...state.batches]
              .sort((a, b) => a.date.localeCompare(b.date))
              .slice(-5)
              .reverse()
              .map((b) => {
                const main = mainOutput(b)
                const unit = main?.uom === 'Kg' ? 'kg' : 'L'
                return (
                  <div className="kpi-row" key={b.id}>
                    <div>
                      <b>{b.id}</b>
                      <div className="small">
                        {main ? fmtBulk(main.qty, main.uom) : '—'} ·{' '}
                        {batchKind(b) === 'Melange'
                          ? 'blended'
                          : `${batchYield(b).toFixed(3)} ${unit} per unit issued`}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <b>
                        {inr(b.costPerL)}/{unit}
                      </b>
                      <div>
                        <StatusBadge value={b.status} />
                      </div>
                    </div>
                  </div>
                )
              })
          )}
        </div>
      </div>
    </>
  )
}
