import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CompareTable } from '../components/reports/CompareTable'
import { RangePicker } from '../components/reports/RangePicker'
import { ReportShell } from '../components/reports/ReportShell'
import { defaultMonth, readRange } from '../components/reports/range'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { Select } from '../components/Select'
import { SortHeader, SortSelect, sortRows, useTableSort, type SortAccessors } from '../components/tableSort'
import { useApp } from '../context/AppContext'
import type { ExportColumn } from '../lib/export'
import {
  REPORTS,
  REPORT_FAMILIES,
  reportDef,
  type ReportDef,
} from '../lib/reports/index.ts'
import { fmtByUom } from '../lib/stock'
import { isWholeMonth, monthLabel, monthOf, windowLabel } from '../lib/reports/params.ts'
import {
  batchWiseRows,
  productionCompare,
  productionReport,
  type ByUom,
} from '../lib/reports/production.ts'
import { procurementCompare, procurementLotRows, procurementSummary } from '../lib/reports/procurement.ts'
import { lotYieldRows } from '../lib/reports/lotYield.ts'
import { dispatchRows, type DispatchGrouping } from '../lib/reports/dispatchReport.ts'
import {
  fgOnHand,
  itemFlows,
  lotAgeing,
  type ItemFlowRow,
} from '../lib/reports/inventoryReports.ts'
import { qualityReport } from '../lib/reports/qualityReport.ts'
import { fmtQty, inr, toDateKey } from '../lib/utils'

/**
 * The live reports page — thin on purpose.
 *
 * Every figure on it is derived from the snapshot the app already holds, by the
 * pure functions in src/lib/reports, at the moment it is asked for. Nothing is
 * stored, so there is nothing to go stale and nothing to reconcile: the report
 * and the register it reads cannot disagree because they are the same rows.
 *
 * All filter state lives in the URL (`type`, `from`, `to`, `cmp`, `cfrom`,
 * `cto`, `group`), so any view an operator can reach is a view they can link
 * someone else to.
 */

/** "395 L · 52 kg" — quantities per unit, never a sum across two of them. */
const fmtUoms = (list: ByUom[]) =>
  fmtByUom(new Map(list.map((x) => [x.uom, x.qty] as const)), '0')

/** Fold entries to one total per unit — the input side of `fmtUoms`. */
const perUom = (entries: { uom: string; qty: number }[]): ByUom[] => {
  const by = new Map<string, number>()
  for (const e of entries) by.set(e.uom, (by.get(e.uom) || 0) + e.qty)
  return [...by.entries()].map(([uom, qty]) => ({ uom, qty: Number(qty.toFixed(3)) }))
}

const pct = (n: number | null) => (n === null ? '—' : `${n}%`)

export function LiveReports() {
  const [params] = useSearchParams()
  const def = reportDef(params.get('type') || '')
  if (!def) return <Catalog />
  switch (def.key) {
    case 'procurement-lots':
      return <ProcurementView def={def} />
    case 'fruits':
      return <ProcurementView def={def} fruits />
    case 'lot-yield':
      return <LotYieldView def={def} />
    case 'production':
      return <ProductionView def={def} />
    case 'batch-wise':
      return <BatchWiseView def={def} />
    case 'dispatch':
      return <DispatchView def={def} />
    case 'rm':
      return <FlowsView def={def} itemTypes={['Raw Material']} ageing />
    case 'pm':
      return <FlowsView def={def} itemTypes={['Packing Material']} />
    case 'storage':
      return <StorageView def={def} />
    case 'quality':
      return <QualityView def={def} />
  }
}

/** The catalog the page opens on: every report, grouped the way the plant thinks. */
function Catalog() {
  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Live reports</h3>
          <span>
            Derived straight off the records, over whatever range you point them at —
            nothing stored, so nothing to reconcile. Ranges and comparisons are part of
            the link, so any view can be shared.
          </span>
        </div>
      </div>
      {REPORT_FAMILIES.map((family) => (
        <div className="report-catalog-family" key={family}>
          <h4>{family}</h4>
          <div className="grid grid-2">
            {REPORTS.filter((r) => r.family === family).map((r) => (
              <Link className="report-card" key={r.key} to={`/reports/live?type=${r.key}`}>
                <b>{r.title}</b>
                <span>{r.blurb}</span>
                <small>Reads: {r.sources}</small>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Range state the ranged views share: the window, and whether the operator has
 *  moved it off this month (an empty list means something different then). */
function useRangedParams(def: ReportDef) {
  const [params, setParams] = useSearchParams()
  const { window, compareWindow, labelA, labelB } = readRange(params, def.compare)
  const offDefault = !(isWholeMonth(window) && monthOf(window.from) === defaultMonth())
  const resetRange = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const k of ['from', 'to', 'cmp', 'cfrom', 'cto']) next.delete(k)
      return next
    })
  return { window, compareWindow, labelA, labelB, offDefault, resetRange }
}

// ─── Reports 1 & 3: procurement lots, and the same for fruit ────────────────

function ProcurementView({ def, fruits }: { def: ReportDef; fruits?: boolean }) {
  const { state } = useApp()
  const { window: w, compareWindow, labelA, labelB, offDefault, resetRange } = useRangedParams(def)
  const rows = useMemo(
    () => procurementLotRows(state, w, { fruitsOnly: !!fruits }),
    [state, w, fruits],
  )
  const summary = procurementSummary(rows)
  const cmp = useMemo(
    () =>
      compareWindow
        ? procurementCompare(
            procurementLotRows(state, compareWindow, { fruitsOnly: !!fruits }),
            rows,
          )
        : null,
    [state, compareWindow, rows, fruits],
  )

  const { sort, toggle, setSort } = useTableSort('date', 'desc')
  const by: SortAccessors<typeof rows[number]> = {
    grn: (r) => r.grnId,
    date: (r) => r.date,
    supplier: (r) => r.supplier,
    product: (r) => r.product,
    received: (r) => r.total,
    reject: (r) => r.reject,
    landed: (r) => r.landed,
    per: (r) => r.perAccepted,
  }
  const sorted = sortRows(rows, sort, by)

  const columns: ExportColumn<typeof rows[number]>[] = [
    { header: 'Receipt', value: (r) => r.grnId },
    { header: 'Lot', value: (r) => r.lot },
    { header: 'Date', value: (r) => r.date },
    { header: 'Supplier', value: (r) => r.supplier },
    { header: 'Product', value: (r) => r.product },
    { header: 'Received', value: (r) => `${r.total} ${r.uom}` },
    { header: 'Free', value: (r) => r.free },
    { header: 'A', value: (r) => r.a },
    { header: 'B', value: (r) => r.b },
    { header: 'C', value: (r) => r.c },
    { header: 'Rejected', value: (r) => r.reject },
    { header: 'Rate (₹)', value: (r) => r.rate },
    { header: 'Landed (₹)', value: (r) => r.landed },
    { header: '₹ per accepted', value: (r) => (r.accepted ? Number(r.perAccepted.toFixed(2)) : '') },
  ]

  return (
    <ReportShell
      def={def}
      range={windowLabel(w)}
      exportName={def.key}
      columns={columns}
      rows={rows}
      controls={<RangePicker compare={def.compare} />}
    >
      <div className="metric-strip">
        <div className="metric">
          <div className="label">Receipts</div>
          <div className="value">{summary.receipts}</div>
          <div className="sub">{fmtByUom(new Map(summary.qtyByUom.map((x) => [x.uom, x.qty] as const)))} received</div>
        </div>
        <div className="metric">
          <div className="label">Landed cost</div>
          <div className="value">{inr(summary.landed)}</div>
          <div className="sub">Priced, graded and transported</div>
        </div>
        <div className="metric">
          <div className="label">Avg ₹ per accepted</div>
          <div className="value">
            {summary.avgPerAcceptedByUom.length
              ? summary.avgPerAcceptedByUom.map((x) => `${inr(x.qty)}/${x.uom}`).join(' · ')
              : '—'}
          </div>
          <div className="sub">Weighted by accepted quantity</div>
        </div>
        <div className="metric">
          <div className="label">Suppliers</div>
          <div className="value">{summary.suppliers}</div>
          <div className="sub">Distinct sources in the range</div>
        </div>
      </div>

      {cmp ? <CompareTable labelA={labelA} labelB={labelB} lines={cmp.lines} /> : null}

      <SortSelect sort={sort} onPick={setSort} columns={[
        { k: 'grn', label: 'Receipt' },
        { k: 'date', label: 'Received', kind: 'date' },
        { k: 'supplier', label: 'Supplier' },
        { k: 'product', label: 'Product' },
        { k: 'received', label: 'Received', kind: 'num' },
        { k: 'landed', label: 'Landed cost', kind: 'num' },
        { k: 'per', label: '₹ per accepted', kind: 'num' },
      ]} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Receipt / Lot" k="grn" sort={sort} onToggle={toggle} />
              <SortHeader label="Received" k="date" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Supplier" k="supplier" sort={sort} onToggle={toggle} />
              <SortHeader label="Product" k="product" sort={sort} onToggle={toggle} />
              <SortHeader label="Received" k="received" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Free</th>
              <th className="cell-tight">Grades A/B/C</th>
              <SortHeader label="Reject" k="reject" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Landed" k="landed" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="₹ / accepted" k="per" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={10} className="empty">
                  <EmptyState
                    filtered={offDefault}
                    empty={fruits ? 'No fruit receipts in this range.' : 'No receipts in this range.'}
                    onClear={resetRange}
                  />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.grnId}>
                  <td data-label="Receipt / Lot">
                    <DocLink doc={r.grnId} />
                    <div className="cell-sub">{r.lot}</div>
                  </td>
                  <td data-label="Received">{r.date}</td>
                  <td data-label="Supplier">{r.supplier}</td>
                  <td data-label="Product">{r.product}</td>
                  <td data-label="Received" className="cell-num">
                    {fmtQty(r.total)} {r.uom}
                  </td>
                  <td data-label="Free" className="cell-num">{fmtQty(r.free)}</td>
                  <td data-label="Grades" className="cell-num">
                    {r.a} / {r.b} / {r.c}
                  </td>
                  <td data-label="Reject" className="cell-num">{fmtQty(r.reject)}</td>
                  <td data-label="Landed" className="cell-num">{inr(r.landed)}</td>
                  <td data-label="₹ / accepted" className="cell-num">
                    {r.accepted ? inr(r.perAccepted) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ReportShell>
  )
}

// ─── Report 2: lot yield ────────────────────────────────────────────────────

function LotYieldView({ def }: { def: ReportDef }) {
  const { state } = useApp()
  const { window: w, offDefault, resetRange } = useRangedParams(def)
  const rows = useMemo(() => lotYieldRows(state, w), [state, w])
  const pending = rows.filter((r) => r.pending).length
  const attributed = rows.filter((r) => !r.pending && r.mainQty > 0)
  // The lot's landed cost is its usable cost × accepted — the identity the
  // derivation itself prices litres by.
  const landed = rows.reduce((a, r) => a + r.usableCost * r.received, 0)

  const { sort, toggle, setSort } = useTableSort('date', 'desc')
  const by: SortAccessors<typeof rows[number]> = {
    lot: (r) => r.lot,
    date: (r) => r.date,
    supplier: (r) => r.supplier,
    issued: (r) => r.issued,
    yield: (r) => r.yieldPerUnit,
    cost: (r) => r.costPerUnit,
  }
  const sorted = sortRows(rows, sort, by)

  const columns: ExportColumn<typeof rows[number]>[] = [
    { header: 'Receipt', value: (r) => r.grnId },
    { header: 'Lot', value: (r) => r.lot },
    { header: 'Date', value: (r) => r.date },
    { header: 'Supplier', value: (r) => r.supplier },
    { header: 'Product', value: (r) => r.product },
    { header: 'Received', value: (r) => `${r.received} ${r.uom}` },
    { header: 'Issued', value: (r) => r.issued },
    { header: 'Spoiled', value: (r) => r.spoiled },
    { header: 'Main output', value: (r) => (r.mainQty ? `${r.mainQty} ${r.mainUom}` : '') },
    { header: 'By-product', value: (r) => (r.byQty ? `${r.byQty} ${r.byUom}` : '') },
    { header: 'Yield per unit', value: (r) => (r.yieldPerUnit === null ? 'Yield pending' : Number(r.yieldPerUnit.toFixed(4))) },
    { header: 'Landed (₹)', value: (r) => Number((r.usableCost * r.received).toFixed(2)) },
    { header: '₹ per unit output', value: (r) => (r.costPerUnit === null ? '' : Number(r.costPerUnit.toFixed(2))) },
  ]

  return (
    <ReportShell def={def} range={windowLabel(w)} exportName={def.key} columns={columns} rows={rows}
      controls={<RangePicker compare={def.compare} />}>
      <div className="metric-strip">
        <div className="metric">
          <div className="label">Lots in range</div>
          <div className="value">{rows.length}</div>
          <div className="sub">Received {windowLabel(w).toLowerCase()}</div>
        </div>
        <div className="metric">
          <div className="label">Yield pending</div>
          <div className="value">{pending}</div>
          <div className="sub">Lots nothing has pressed yet</div>
        </div>
        <div className="metric">
          <div className="label">Output attributed</div>
          <div className="value">{fmtUoms(perUom(attributed.map((r) => ({ uom: r.mainUom, qty: r.mainQty }))))}</div>
          <div className="sub">Pro-rata over every pressing, all of history</div>
        </div>
        <div className="metric">
          <div className="label">Landed cost</div>
          <div className="value">{inr(landed)}</div>
          <div className="sub">What the range's fruit cost as received</div>
        </div>
      </div>

      <SortSelect sort={sort} onPick={setSort} columns={[
        { k: 'lot', label: 'Lot' },
        { k: 'date', label: 'Received', kind: 'date' },
        { k: 'supplier', label: 'Supplier' },
        { k: 'issued', label: 'Issued', kind: 'num' },
        { k: 'yield', label: 'Yield', kind: 'num' },
        { k: 'cost', label: '₹ per litre', kind: 'num' },
      ]} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Lot" k="lot" sort={sort} onToggle={toggle} />
              <SortHeader label="Received" k="date" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Supplier" k="supplier" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Issued</th>
              <th className="cell-tight">Spoiled</th>
              <th className="cell-tight">Main output</th>
              <th className="cell-tight">By-product</th>
              <SortHeader label="Yield" k="yield" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="₹ / unit out" k="cost" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={10} className="empty">
                  <EmptyState filtered={offDefault} empty="No lots received in this range." onClear={resetRange} />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.lot}>
                  <td data-label="Lot">
                    <DocLink doc={r.grnId} label={r.lot} />
                    <div className="cell-sub">{r.product}</div>
                  </td>
                  <td data-label="Received">{r.date}</td>
                  <td data-label="Supplier">{r.supplier}</td>
                  <td data-label="Issued" className="cell-num">
                    {fmtQty(r.issued)} {r.uom}
                  </td>
                  <td data-label="Spoiled" className="cell-num">{fmtQty(r.spoiled)}</td>
                  <td data-label="Main output" className="cell-num">
                    {r.mainQty ? `${fmtQty(r.mainQty)} ${r.mainUom}` : '—'}
                  </td>
                  <td data-label="By-product" className="cell-num">
                    {r.byQty ? `${fmtQty(r.byQty)} ${r.byUom}` : '—'}
                  </td>
                  <td data-label="Yield" className="cell-num">
                    {r.yieldPerUnit === null ? '—' : Number(r.yieldPerUnit.toFixed(3))}
                  </td>
                  <td data-label="₹ / unit out" className="cell-num">
                    {r.costPerUnit === null ? '—' : inr(r.costPerUnit)}
                  </td>
                  <td data-label="Status">
                    {r.pending ? (
                      <span className="status warning">Yield pending</span>
                    ) : (
                      <span className="cell-sub">{r.batches.length} batch{r.batches.length === 1 ? '' : 'es'}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ReportShell>
  )
}

// ─── Report 4: production, month by month ───────────────────────────────────

function ProductionView({ def }: { def: ReportDef }) {
  const { state } = useApp()
  const { window: w, compareWindow, labelA, labelB, offDefault, resetRange } = useRangedParams(def)
  const report = useMemo(() => productionReport(state, w), [state, w])
  const cmp = useMemo(
    () => (compareWindow ? productionCompare(productionReport(state, compareWindow).totals, report.totals) : null),
    [state, compareWindow, report.totals],
  )
  const t = report.totals

  const columns: ExportColumn<typeof report.rows[number]>[] = [
    { header: 'Month', value: (r) => monthLabel(r.month) },
    { header: 'Extractions', value: (r) => r.extractions },
    { header: 'Mélange runs', value: (r) => r.melanges },
    { header: 'Net-new bulk', value: (r) => fmtUoms(r.netNew) },
    { header: 'Spoiled', value: (r) => fmtUoms(r.spoiled) },
    { header: 'Avg yield', value: (r) => r.avgYield.map((y) => `${y.pair}: ${y.avg}`).join('; ') },
    { header: 'Packs filled', value: (r) => r.packsFilled },
    { header: 'RM cost (₹)', value: (r) => r.rmCost },
    { header: 'PM cost (₹)', value: (r) => r.pmCost },
    { header: 'Direct cost (₹)', value: (r) => r.directCost },
  ]

  return (
    <ReportShell def={def} range={windowLabel(w)} exportName={def.key} columns={columns} rows={report.rows}
      controls={<RangePicker compare={def.compare} />}>
      <div className="metric-strip">
        <div className="metric">
          <div className="label">Net-new bulk</div>
          <div className="value">{fmtUoms(t.netNew)}</div>
          <div className="sub">Pressings plus what blends added</div>
        </div>
        <div className="metric">
          <div className="label">Batches</div>
          <div className="value">{t.extractions + t.melanges}</div>
          <div className="sub">{t.extractions} extractions · {t.melanges} mélange</div>
        </div>
        <div className="metric">
          <div className="label">Packs filled</div>
          <div className="value">{t.packsFilled}</div>
          <div className="sub">{t.packRuns} packing run{t.packRuns === 1 ? '' : 's'}</div>
        </div>
        <div className="metric">
          <div className="label">Cost put through</div>
          <div className="value">{inr(t.rmCost + t.pmCost + t.directCost)}</div>
          <div className="sub">RM {inr(t.rmCost)} · PM {inr(t.pmCost)} · direct {inr(t.directCost)}</div>
        </div>
      </div>

      {cmp ? <CompareTable labelA={labelA} labelB={labelB} lines={cmp} /> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th className="cell-num cell-tight">Extractions</th>
              <th className="cell-num cell-tight">Mélange</th>
              <th className="cell-num">Net-new bulk</th>
              <th className="cell-num">Spoiled</th>
              <th className="cell-num">Avg yield</th>
              <th className="cell-num cell-tight">Avg ₹/L</th>
              <th className="cell-num cell-tight">Packs</th>
              <th className="cell-num cell-tight">PM cost</th>
            </tr>
          </thead>
          <tbody>
            {!report.rows.length ? (
              <tr>
                <td colSpan={9} className="empty">
                  <EmptyState filtered={offDefault} empty="Nothing was produced in this range." onClear={resetRange} />
                </td>
              </tr>
            ) : (
              report.rows.map((r) => (
                <tr key={r.month}>
                  <td data-label="Month">{monthLabel(r.month)}</td>
                  <td data-label="Extractions" className="cell-num">{r.extractions}</td>
                  <td data-label="Mélange" className="cell-num">{r.melanges}</td>
                  <td data-label="Net-new bulk" className="cell-num">{fmtUoms(r.netNew)}</td>
                  <td data-label="Spoiled" className="cell-num">{fmtUoms(r.spoiled)}</td>
                  <td data-label="Avg yield" className="cell-num">
                    {r.avgYield.length ? r.avgYield.map((y) => `${y.avg} ${y.pair}`).join(' · ') : '—'}
                  </td>
                  <td data-label="Avg ₹/L" className="cell-num">
                    {r.costPerUnit.length ? r.costPerUnit.map((c) => inr(c.value)).join(' · ') : '—'}
                  </td>
                  <td data-label="Packs" className="cell-num">{r.packsFilled}</td>
                  <td data-label="PM cost" className="cell-num">{inr(r.pmCost)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ReportShell>
  )
}

// ─── Report 5: batch-wise production ────────────────────────────────────────

function BatchWiseView({ def }: { def: ReportDef }) {
  const { state } = useApp()
  const { window: w, offDefault, resetRange } = useRangedParams(def)
  const rows = useMemo(() => batchWiseRows(state, w), [state, w])

  const { sort, toggle, setSort } = useTableSort('date', 'desc')
  const by: SortAccessors<typeof rows[number]> = {
    batch: (r) => r.batchId,
    date: (r) => r.date,
    label: (r) => r.label,
    input: (r) => r.inputQty,
    yield: (r) => r.yieldPerUnit,
    cost: (r) => r.costPerUnit,
    total: (r) => r.totalCost,
  }
  const sorted = sortRows(rows, sort, by)

  const columns: ExportColumn<typeof rows[number]>[] = [
    { header: 'Batch', value: (r) => r.batchId },
    { header: 'Date', value: (r) => r.date },
    { header: 'Kind', value: (r) => r.kind },
    { header: 'Product', value: (r) => r.label },
    { header: 'Input', value: (r) => `${r.inputQty} ${r.inputUom}` },
    { header: 'Spoiled', value: (r) => r.spoiled },
    { header: 'Outputs', value: (r) => r.outputs.map((o) => `${o.qty} ${o.uom} ${o.name}`).join('; ') },
    { header: 'Yield', value: (r) => (r.yieldPerUnit === null ? '' : Number(r.yieldPerUnit.toFixed(4))) },
    { header: 'Total cost (₹)', value: (r) => r.totalCost },
    { header: '₹ per unit (₹)', value: (r) => r.costPerUnit },
    { header: 'Status', value: (r) => r.status },
  ]

  return (
    <ReportShell def={def} range={windowLabel(w)} exportName={def.key} columns={columns} rows={rows}
      controls={<RangePicker compare={def.compare} />}>
      <SortSelect sort={sort} onPick={setSort} columns={[
        { k: 'batch', label: 'Batch' },
        { k: 'date', label: 'Date', kind: 'date' },
        { k: 'label', label: 'Product' },
        { k: 'input', label: 'Input', kind: 'num' },
        { k: 'yield', label: 'Yield', kind: 'num' },
        { k: 'cost', label: '₹ per unit', kind: 'num' },
        { k: 'total', label: 'Total cost', kind: 'num' },
      ]} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Batch" k="batch" sort={sort} onToggle={toggle} />
              <SortHeader label="Date" k="date" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="Product" k="label" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Input</th>
              <th className="cell-tight">Spoiled</th>
              <th>Outputs</th>
              <SortHeader label="Yield" k="yield" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Total cost" k="total" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="₹ / unit" k="cost" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Status</th>
              <th>QC</th>
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={10} className="empty">
                  <EmptyState filtered={offDefault} empty="No batches were run in this range." onClear={resetRange} />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.batchId}>
                  <td data-label="Batch">
                    <DocLink doc={r.batchId} />
                    <div className="cell-sub">{r.kind}</div>
                  </td>
                  <td data-label="Date">{r.date}</td>
                  <td data-label="Product">{r.label}</td>
                  <td data-label="Input" className="cell-num">
                    {fmtQty(r.inputQty)} {r.inputUom}
                  </td>
                  <td data-label="Spoiled" className="cell-num">{fmtQty(r.spoiled)}</td>
                  <td data-label="Outputs">
                    {r.outputs.map((o) => (
                      <div key={o.item}>
                        {fmtQty(o.qty)} {o.uom} {o.name}
                        {o.costShare === 0 ? <span className="cell-sub"> (by-product)</span> : null}
                      </div>
                    ))}
                  </td>
                  <td data-label="Yield" className="cell-num">
                    {r.yieldPerUnit === null ? '—' : Number(r.yieldPerUnit.toFixed(3))}
                  </td>
                  <td data-label="Total cost" className="cell-num">{inr(r.totalCost)}</td>
                  <td data-label="₹ / unit" className="cell-num">
                    {inr(r.costPerUnit)}<span className="cell-sub"> /{r.mainUom || 'L'}</span>
                  </td>
                  <td data-label="Status">{r.status}</td>
                  <td data-label="QC">
                    {r.qcIds.length ? (
                      r.qcIds.map((id) => <DocLink key={id} doc={id} />)
                    ) : (
                      <span className="cell-sub">Not tested</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ReportShell>
  )
}

// ─── Report 6: dispatch ─────────────────────────────────────────────────────

function DispatchView({ def }: { def: ReportDef }) {
  const { state } = useApp()
  const [params, setParams] = useSearchParams()
  const { window: w, offDefault, resetRange } = useRangedParams(def)
  const group: DispatchGrouping = params.get('group') === 'batch' ? 'batch' : 'month'
  const rows = useMemo(() => dispatchRows(state, w, group), [state, w, group])
  const setGroup = (g: DispatchGrouping) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (g === 'month') next.delete('group')
      else next.set('group', g)
      return next
    }, { replace: true })

  const { sort, toggle, setSort } = useTableSort('group', 'desc')
  const by: SortAccessors<typeof rows[number]> = {
    group: (r) => r.group,
    sku: (r) => r.skuName,
    qty: (r) => r.qty,
    pending: (r) => r.pendingQty,
    pod: (r) => r.podMissing,
  }
  const sorted = sortRows(rows, sort, by)

  const columns: ExportColumn<typeof rows[number]>[] = [
    { header: group === 'month' ? 'Month' : 'Batch', value: (r) => r.group },
    { header: 'SKU', value: (r) => r.skuName },
    { header: 'Qty', value: (r) => `${r.qty} ${r.uom}` },
    { header: 'Delivered', value: (r) => r.deliveredQty },
    { header: 'Outstanding', value: (r) => r.pendingQty },
    { header: 'Dispatches', value: (r) => r.dispatchCount },
    { header: 'Customers', value: (r) => r.customers.join('; ') },
    { header: 'Challans', value: (r) => r.challans.join('; ') },
    { header: 'POD missing', value: (r) => r.podMissing },
    { header: 'Orders', value: (r) => r.orderIds.join('; ') },
  ]

  return (
    <ReportShell def={def} range={windowLabel(w)} exportName={def.key} columns={columns} rows={rows}
      controls={
        <>
          <RangePicker compare={def.compare} />
          <span className="range-vs">Group by</span>
          <Select value={group} onChange={(e) => setGroup(e.target.value as DispatchGrouping)} id="dispatch-group">
            <option value="month">By month</option>
            <option value="batch">By batch</option>
          </Select>
        </>
      }>
      <SortSelect sort={sort} onPick={setSort} columns={[
        { k: 'group', label: group === 'month' ? 'Month' : 'Batch' },
        { k: 'sku', label: 'SKU' },
        { k: 'qty', label: 'Quantity', kind: 'num' },
        { k: 'pending', label: 'Outstanding', kind: 'num' },
      ]} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label={group === 'month' ? 'Month' : 'Batch'} k="group" first="desc" sort={sort} onToggle={toggle} />
              <SortHeader label="SKU" k="sku" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Batch</th>
              <SortHeader label="Qty" k="qty" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Delivered</th>
              <SortHeader label="Outstanding" k="pending" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Dispatches</th>
              <th>Customers</th>
              <th>Challans</th>
              <SortHeader label="POD missing" k="pod" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <th>Orders</th>
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={11} className="empty">
                  <EmptyState filtered={offDefault} empty="Nothing was dispatched in this range." onClear={resetRange} />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={`${r.group}|${r.sku}`}>
                  <td data-label={group === 'month' ? 'Month' : 'Batch'}>
                    {group === 'month' ? monthLabel(r.group) : <DocLink doc={r.group} />}
                  </td>
                  <td data-label="SKU">
                    {r.skuName}
                    <div className="cell-sub">{r.sku}</div>
                  </td>
                  <td data-label="Batch"><DocLink doc={r.batchId} /></td>
                  <td data-label="Qty" className="cell-num">
                    {fmtQty(r.qty)} {r.uom}
                  </td>
                  <td data-label="Delivered" className="cell-num">{fmtQty(r.deliveredQty)}</td>
                  <td data-label="Outstanding" className="cell-num">{fmtQty(r.pendingQty)}</td>
                  <td data-label="Dispatches" className="cell-num">{r.dispatchCount}</td>
                  <td data-label="Customers">{r.customers.join(', ')}</td>
                  <td data-label="Challans">{r.challans.join(', ')}</td>
                  <td data-label="POD missing" className="cell-num">
                    {r.podMissing ? <span className="status warning">{r.podMissing}</span> : '0'}
                  </td>
                  <td data-label="Orders">
                    {r.orderIds.length ? r.orderIds.map((id) => <DocLink key={id} doc={id} />) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ReportShell>
  )
}

// ─── Reports 7 & 8: the ledger engine over raw material / packing material ──

function FlowsView({ def, itemTypes, ageing }: { def: ReportDef; itemTypes: string[]; ageing?: boolean }) {
  const { state } = useApp()
  const { window: w, offDefault, resetRange } = useRangedParams(def)
  const rows = useMemo(() => itemFlows(state, w, itemTypes), [state, w, itemTypes])
  const ages = useMemo(
    () => (ageing ? lotAgeing(state, itemTypes, toDateKey()) : null),
    [state, itemTypes, ageing],
  )
  const totals = rows.reduce(
    (a, r) => ({
      received: a.received + r.received,
      issued: a.issued + r.issued,
      value: a.value + r.closingValue,
    }),
    { received: 0, issued: 0, value: 0 },
  )
  const reorderCount = rows.filter((r) => r.belowReorder).length

  const { sort, toggle, setSort } = useTableSort('name', 'asc')
  const by: SortAccessors<ItemFlowRow> = {
    name: (r) => r.name,
    opening: (r) => r.opening,
    received: (r) => r.received,
    issued: (r) => r.issued,
    closing: (r) => r.closing,
    value: (r) => r.closingValue,
  }
  const sorted = sortRows(rows, sort, by)

  const columns: ExportColumn<ItemFlowRow>[] = [
    { header: 'Item', value: (r) => r.name },
    { header: 'Code', value: (r) => r.item },
    { header: 'Opening', value: (r) => r.opening },
    { header: 'Received', value: (r) => r.received },
    { header: 'Issued', value: (r) => r.issued },
    { header: 'Closing', value: (r) => r.closing },
    { header: `Closing value (₹)`, value: (r) => r.closingValue },
    { header: 'Reorder level', value: (r) => r.reorder ?? '' },
    { header: 'Below reorder', value: (r) => (r.belowReorder ? 'Yes' : '') },
  ]

  return (
    <ReportShell def={def} range={windowLabel(w)} exportName={def.key} columns={columns} rows={rows}
      controls={<RangePicker compare={def.compare} />}>
      <div className="metric-strip">
        <div className="metric">
          <div className="label">Items moved</div>
          <div className="value">{rows.length}</div>
          <div className="sub">Seen by the ledger in the range</div>
        </div>
        <div className="metric">
          <div className="label">Received</div>
          <div className="value">{fmtUoms(perUom(rows.map((r) => ({ uom: r.uom, qty: r.received }))))}</div>
          <div className="sub">Receipt lines in the window</div>
        </div>
        <div className="metric">
          <div className="label">Issued</div>
          <div className="value">{fmtUoms(perUom(rows.map((r) => ({ uom: r.uom, qty: r.issued }))))}</div>
          <div className="sub">Consume / issue lines in the window</div>
        </div>
        <div className="metric">
          <div className="label">Closing value</div>
          <div className="value">{inr(totals.value)}</div>
          <div className="sub">
            {ageing ? 'Balance at window end, valued at unit cost' : `${reorderCount} item${reorderCount === 1 ? '' : 's'} below reorder`}
          </div>
        </div>
      </div>

      <SortSelect sort={sort} onPick={setSort} columns={[
        { k: 'name', label: 'Item' },
        { k: 'opening', label: 'Opening', kind: 'num' },
        { k: 'received', label: 'Received', kind: 'num' },
        { k: 'issued', label: 'Issued', kind: 'num' },
        { k: 'closing', label: 'Closing', kind: 'num' },
        { k: 'value', label: 'Closing value', kind: 'num' },
      ]} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Item" k="name" sort={sort} onToggle={toggle} />
              <SortHeader label="Opening" k="opening" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Received" k="received" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Issued" k="issued" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Closing" k="closing" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Value" k="value" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              {itemTypes.includes('Packing Material') ? <th className="cell-tight">Reorder</th> : null}
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={7} className="empty">
                  <EmptyState filtered={offDefault} empty="No movements in this range." onClear={resetRange} />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.item}>
                  <td data-label="Item">
                    {r.name}
                    <div className="cell-sub">{r.item}</div>
                  </td>
                  <td data-label="Opening" className="cell-num">{fmtQty(r.opening)}</td>
                  <td data-label="Received" className="cell-num">{fmtQty(r.received)}</td>
                  <td data-label="Issued" className="cell-num">{fmtQty(r.issued)}</td>
                  <td data-label="Closing" className="cell-num">
                    <b>{fmtQty(r.closing)}</b> <span className="cell-sub">{r.uom}</span>
                  </td>
                  <td data-label="Value" className="cell-num">{inr(r.closingValue)}</td>
                  {itemTypes.includes('Packing Material') ? (
                    <td data-label="Reorder">
                      {r.belowReorder ? (
                        <span className="status warning">Below {fmtQty(r.reorder || 0)}</span>
                      ) : r.reorder ? (
                        <span className="cell-sub">Level {fmtQty(r.reorder)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {ages && ages.rows.length ? (
        <>
          <div className="section-head" style={{ marginTop: 8 }}>
            <div>
              <h4>Lot ageing</h4>
              <span>Lots still on hand, aged from harvest where the receipt has one.</span>
            </div>
            <div className="section-head-actions">
              {ages.byAge.map((b) => (
                <span key={`${b.bucket}-${b.uom}`} className="pill">
                  {b.bucket}: {fmtQty(b.qty)} {b.uom}
                </span>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lot</th>
                  <th>From</th>
                  <th>Received</th>
                  <th className="cell-num">On hand</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {ages.rows.map((r) => (
                  <tr key={r.lot}>
                    <td data-label="Lot">
                      <DocLink doc={r.grnId} label={r.lot} />
                    </td>
                    <td data-label="From">{r.from}</td>
                    <td data-label="Received">{r.received}</td>
                    <td data-label="On hand" className="cell-num">
                      {fmtQty(r.onHand)} {r.uom}
                    </td>
                    <td data-label="Where">{r.locations.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </ReportShell>
  )
}

// ─── Report 9: finished goods on hand ───────────────────────────────────────

function StorageView({ def }: { def: ReportDef }) {
  const { state } = useApp()
  const rows = useMemo(() => fgOnHand(state, toDateKey()), [state])
  const value = rows.reduce((a, r) => a + r.value, 0)
  const alertDays = state.config?.expiryAlertDays ?? 2
  const atRisk = rows.filter(
    (r) => r.bucket === 'Expired' || (r.daysToExpiry !== null && r.daysToExpiry <= alertDays),
  )

  const { sort, toggle, setSort } = useTableSort('expiry', 'asc')
  const by: SortAccessors<typeof rows[number]> = {
    item: (r) => r.name,
    location: (r) => r.locationLabel,
    lot: (r) => r.lot,
    qty: (r) => r.qty,
    value: (r) => r.value,
    expiry: (r) => r.expiry || '9999-12-31',
  }
  const sorted = sortRows(rows, sort, by)

  const columns: ExportColumn<typeof rows[number]>[] = [
    { header: 'Item', value: (r) => r.name },
    { header: 'Code', value: (r) => r.item },
    { header: 'Lot', value: (r) => r.lot },
    { header: 'Storage area', value: (r) => r.locationLabel },
    { header: 'Status', value: (r) => r.status },
    { header: 'Qty', value: (r) => `${r.qty} ${r.uom}` },
    { header: 'Value (₹)', value: (r) => r.value },
    { header: 'Expiry', value: (r) => r.expiry },
    { header: 'Days left', value: (r) => r.daysToExpiry },
    { header: 'Bucket', value: (r) => r.bucket },
  ]

  return (
    <ReportShell def={def} range="As of now" exportName={def.key} columns={columns} rows={rows}>
      <div className="metric-strip">
        <div className="metric">
          <div className="label">Finished stock</div>
          <div className="value">{fmtUoms(perUom(rows))}</div>
          <div className="sub">{rows.length} line{rows.length === 1 ? '' : 's'} across all areas</div>
        </div>
        <div className="metric">
          <div className="label">Value</div>
          <div className="value">{inr(value)}</div>
          <div className="sub">At each line's unit cost</div>
        </div>
        <div className="metric">
          <div className="label">In the alert window</div>
          <div className="value">{atRisk.length}</div>
          <div className="sub">Expired or inside {state.config?.expiryAlertDays ?? 2} days</div>
        </div>
        <div className="metric">
          <div className="label">Where it sits</div>
          <div className="value">{new Set(rows.map((r) => r.locationLabel)).size}</div>
          <div className="sub">Storage areas holding finished goods</div>
        </div>
      </div>


      <SortSelect sort={sort} onPick={setSort} columns={[
        { k: 'item', label: 'Item' },
        { k: 'location', label: 'Storage area' },
        { k: 'lot', label: 'Lot' },
        { k: 'qty', label: 'On hand', kind: 'num' },
        { k: 'expiry', label: 'Expiry', kind: 'date' },
      ]} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Item" k="item" sort={sort} onToggle={toggle} />
              <SortHeader label="Storage area" k="location" sort={sort} onToggle={toggle} />
              <SortHeader label="Lot" k="lot" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Status</th>
              <SortHeader label="On hand" k="qty" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Value" k="value" first="desc" className="cell-num cell-tight" sort={sort} onToggle={toggle} />
              <SortHeader label="Expiry" k="expiry" sort={sort} onToggle={toggle} />
              <th className="cell-tight">Days left</th>
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={8} className="empty">
                  <EmptyState filtered={false} empty="No finished goods on hand." onClear={() => {}} />
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={`${r.item}|${r.lot}|${r.location}|${r.status}`}>
                  <td data-label="Item">
                    {r.name}
                    <div className="cell-sub">{r.item}</div>
                  </td>
                  <td data-label="Storage area">{r.locationLabel}</td>
                  <td data-label="Lot">{r.lot}</td>
                  <td data-label="Status">{r.status}</td>
                  <td data-label="On hand" className="cell-num">
                    {fmtQty(r.qty)} {r.uom}
                  </td>
                  <td data-label="Value" className="cell-num">{inr(r.value)}</td>
                  <td data-label="Expiry">
                    {r.expiry || '—'}
                    {r.bucket !== '> 30 d' && r.bucket !== 'No expiry' ? (
                      <div className="cell-sub">{r.bucket}</div>
                    ) : null}
                  </td>
                  <td data-label="Days left" className="cell-num">
                    {r.daysToExpiry === null ? '—' : r.daysToExpiry < 0 ? `expired ${-r.daysToExpiry} d ago` : r.daysToExpiry}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ReportShell>
  )
}

// ─── Report 10: quality ─────────────────────────────────────────────────────

function QualityView({ def }: { def: ReportDef }) {
  const { state } = useApp()
  const { window: w, offDefault, resetRange } = useRangedParams(def)
  const report = useMemo(() => qualityReport(state, w), [state, w])
  const decided = report.byMonth.reduce((a, m) => a + m.records, 0)

  const columns: ExportColumn<typeof report.byMonth[number]>[] = [
    { header: 'Month', value: (m) => m.key },
    { header: 'Records', value: (m) => m.records },
    { header: 'Released', value: (m) => m.released },
    { header: 'Rejected', value: (m) => m.rejected },
    { header: 'Retest', value: (m) => m.retest },
    { header: 'Pending', value: (m) => m.pending },
    { header: 'Release rate %', value: (m) => m.releaseRate },
    { header: 'Reject rate %', value: (m) => m.rejectRate },
  ]

  return (
    <ReportShell def={def} range={windowLabel(w)} exportName={def.key} columns={columns} rows={report.byMonth}
      controls={<RangePicker compare={def.compare} />}>
      <div className="metric-strip">
        <div className="metric">
          <div className="label">QC records</div>
          <div className="value">{decided}</div>
          <div className="sub">One per product of each batch</div>
        </div>
        <div className="metric">
          <div className="label">Released</div>
          <div className="value">{report.byMonth.reduce((a, m) => a + m.released, 0)}</div>
          <div className="sub">{pct(
            decided
              ? Number(((report.byMonth.reduce((a, m) => a + m.released, 0) / decided) * 100).toFixed(1))
              : null,
          )} of records</div>
        </div>
        <div className="metric">
          <div className="label">Rejected</div>
          <div className="value">{report.byMonth.reduce((a, m) => a + m.rejected, 0)}</div>
          <div className="sub">{pct(
            decided
              ? Number(((report.byMonth.reduce((a, m) => a + m.rejected, 0) / decided) * 100).toFixed(1))
              : null,
          )} of records</div>
        </div>
        <div className="metric">
          <div className="label">Awaiting a decision</div>
          <div className="value">{report.byMonth.reduce((a, m) => a + m.pending + m.retest, 0)}</div>
          <div className="sub">Pending or sent for retest</div>
        </div>
      </div>

      {!report.byMonth.length && !report.batchStatuses.length ? (
        <EmptyState filtered={offDefault} empty="Nothing was tested in this range." onClear={resetRange} />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="cell-num cell-tight">Records</th>
                  <th className="cell-num cell-tight">Released</th>
                  <th className="cell-num cell-tight">Rejected</th>
                  <th className="cell-num cell-tight">Retest</th>
                  <th className="cell-num cell-tight">Pending</th>
                  <th className="cell-num cell-tight">Release rate</th>
                  <th className="cell-num cell-tight">Reject rate</th>
                </tr>
              </thead>
              <tbody>
                {report.byMonth.map((m) => (
                  <tr key={m.key}>
                    <td data-label="Month">{monthLabel(m.key)}</td>
                    <td data-label="Records" className="cell-num">{m.records}</td>
                    <td data-label="Released" className="cell-num">{m.released}</td>
                    <td data-label="Rejected" className="cell-num">{m.rejected}</td>
                    <td data-label="Retest" className="cell-num">{m.retest}</td>
                    <td data-label="Pending" className="cell-num">{m.pending}</td>
                    <td data-label="Release rate" className="cell-num">{pct(m.releaseRate)}</td>
                    <td data-label="Reject rate" className="cell-num">{pct(m.rejectRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.byProduct.length ? (
            <>
              <div className="section-head" style={{ marginTop: 8 }}>
                <div>
                  <h4>By product</h4>
                  <span>Each bulk product the lab passed judgment on.</span>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="cell-num cell-tight">Records</th>
                      <th className="cell-num cell-tight">Released</th>
                      <th className="cell-num cell-tight">Rejected</th>
                      <th className="cell-num cell-tight">Pending</th>
                      <th className="cell-num cell-tight">Release rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byProduct.map((p) => (
                      <tr key={p.key}>
                        <td data-label="Product">{p.key}</td>
                        <td data-label="Records" className="cell-num">{p.records}</td>
                        <td data-label="Released" className="cell-num">{p.released}</td>
                        <td data-label="Rejected" className="cell-num">{p.rejected}</td>
                        <td data-label="Pending" className="cell-num">{p.pending + p.retest}</td>
                        <td data-label="Release rate" className="cell-num">{pct(p.releaseRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {report.batchStatuses.length ? (
            <>
              <div className="section-head" style={{ marginTop: 8 }}>
                <div>
                  <h4>Batch status roll-up</h4>
                  <span>The plant's own summary of its batches in the range.</span>
                </div>
                <div className="section-head-actions">
                  {report.batchStatuses.map((s) => (
                    <span key={s.status} className="pill">{s.status}: {s.count}</span>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {report.partlyReleased.length ? (
            <>
              <div className="section-head" style={{ marginTop: 8 }}>
                <div>
                  <h4>Partly released batches</h4>
                  <span>Batches whose products disagree — one released, another held or rejected.</span>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>Products</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.partlyReleased.map((p) => (
                      <tr key={p.batchId}>
                        <td data-label="Batch"><DocLink doc={p.batchId} /></td>
                        <td data-label="Products">
                          {p.outputs.map((o, i) => (
                            <span key={o.item}>
                              {i > 0 ? '; ' : ''}
                              {o.name} — {o.disposition}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      )}
    </ReportShell>
  )
}
