/**
 * /styleguide — the design system, rendered live (overhaul §1 SHELL): the
 * tokens, the status palette, the chart colours and every shell component in
 * one place, so "what does the system say?" is a URL rather than a memory.
 * DESIGN_SYSTEM.md is the prose; this page is the proof.
 *
 * Everything here is static sample data — no plant numbers. The swatches
 * read their values from the live stylesheet, so switching the theme in the
 * top bar re-proves both palettes in place. Not a catalog page: no nav item,
 * no permission slug — builders reach it by URL.
 */
import { useEffect, useMemo, useState } from 'react'
import { StatusBadge } from '../components/StatusBadge'
import { ThemeToggle } from '../components/ThemeToggle'
import { ConfirmDialog } from '../components/shell/ConfirmDialog'
import { DataTable, type Column } from '../components/shell/DataTable'
import { FilterBar } from '../components/shell/FilterBar'
import { FreshnessChip } from '../components/shell/FreshnessChip'
import { ChartCard } from '../components/shell/ChartCard'
import { KpiCard } from '../components/shell/KpiCard'
import { MassBalanceBar, TransformationForm } from '../components/shell/TransformationForm'
import { ScanInput } from '../components/shell/ScanInput'
import { SectionedForm, Stepper } from '../components/shell/SectionedForm'
import { SignaturePad } from '../components/shell/SignaturePad'
import { KpiSkeleton, Skeleton } from '../components/shell/Skeleton'
import { chartColors } from '../lib/chartTheme.ts'
import type { DateRange } from '../lib/dateRanges.ts'
import { PALETTE } from '../lib/statusPalette.ts'
import type { Freshness, KpiCard as KpiCardWire, KpiChart } from '../lib/contracts.ts'

/** The tokens the swatch grid proves, in display order. */
const TOKENS = [
  ['--panel', 'Panel'],
  ['--ink', 'Ink'],
  ['--ink-mute', 'Muted ink'],
  ['--hair', 'Hairline'],
  ['--neutral-wash', 'Neutral wash'],
  ['--leaf', 'Leaf (brand)'],
  ['--grove-active', 'Grove (active)'],
  ['--danger', 'Danger'],
] as const

/** One stored status per palette state, as the pages actually write them. */
const STATUS_SAMPLES: { state: string; stored: string }[] = [
  { state: 'pending', stored: 'Draft' },
  { state: 'inProgress', stored: 'In Progress' },
  { state: 'onHold', stored: 'Awaiting QC' },
  { state: 'rework', stored: 'Retest' },
  { state: 'passed', stored: 'Passed' },
  { state: 'released', stored: 'Released' },
  { state: 'dispatched', stored: 'Dispatched' },
  { state: 'outForDelivery', stored: 'In Transit' },
  { state: 'delivered', stored: 'Delivered' },
  { state: 'failed', stored: 'Rejected' },
  { state: 'returned', stored: 'Returned' },
  { state: 'cancelled', stored: 'Cancelled' },
]

/**
 * Live token values, re-read whenever the theme attribute moves — the page
 * and the stylesheet can never disagree about what a token is worth.
 */
function useLiveTokens(): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      const next: Record<string, string> = {}
      for (const [token] of TOKENS) next[token] = cs.getPropertyValue(token).trim()
      next.__charts = JSON.stringify({
        categorical: chartColors().categorical,
        sequential: chartColors().sequential,
      })
      setValues(next)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return values
}

interface LotRow {
  lot: string
  item: string
  qty: number
  uom: string
  status: string
}

const LOT_COLUMNS: Column<LotRow>[] = [
  { key: 'lot', label: 'Lot', sort: (r) => r.lot },
  { key: 'item', label: 'Item', sort: (r) => r.item },
  { key: 'qty', label: 'Qty', sort: (r) => r.qty, align: 'right' },
  { key: 'uom', label: 'Unit', defaultHidden: true },
  { key: 'status', label: 'Status', sort: (r) => r.status, render: (r) => <StatusBadge value={r.status} /> },
]

const LOTS: LotRow[] = [
  { lot: 'LOT-20261013-001', item: 'Tender coconut water', qty: 180, uom: 'Litre', status: 'Quarantine' },
  { lot: 'LOT-20261012-004', item: 'Tender coconut water', qty: 240, uom: 'Litre', status: 'Released' },
  { lot: 'LOT-20261012-003', item: 'Malai', qty: 42, uom: 'Kg', status: 'Awaiting QC' },
  { lot: 'PKG-20261012-002', item: '250 ml packs', qty: 960, uom: 'Piece', status: 'Dispatched' },
]

const KPIS: KpiCardWire[] = [
  { key: 'yield', label: 'Extraction yield', value: 82.4, unit: '%', deltaPct: 3.1 },
  { key: 'spoilage', label: 'Spoilage', value: 1.2, unit: '%', deltaPct: 0.4 },
  { key: 'orders', label: 'Open orders', value: 7, deltaPct: -2 },
]

const CHART: KpiChart = {
  key: 'styleguide-bar',
  kind: 'bar',
  label: 'Cases packed by line',
  rows: [
    { label: 'Line 1', value: 420 },
    { label: 'Line 2', value: 380 },
    { label: 'Line 3', value: 510 },
    { label: 'Manual', value: 96 },
  ],
}

const FRESH: Freshness = { last_updated: new Date().toISOString(), stale_after: 300, stale: false }
const STALE: Freshness = {
  last_updated: new Date(Date.now() - 40 * 60_000).toISOString(),
  stale_after: 300,
  stale: true,
}

export function Styleguide() {
  const tokens = useLiveTokens()
  const charts = useMemo(() => {
    try {
      return JSON.parse(tokens.__charts ?? '{}') as {
        categorical?: string[]
        sequential?: string[]
      }
    } catch {
      return {}
    }
  }, [tokens.__charts])

  const [range, setRange] = useState<DateRange>(() => ({ from: '', to: '' }))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [scanned, setScanned] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [lines, setLines] = useState({
    inputs: [{ item: 'Tender coconuts', qty: 600, uom: 'kg' }],
    outputs: [{ item: 'Bulk water', qty: 500, uom: 'kg' }],
    spoilage: [{ item: 'Husk and shell loss', qty: 95, uom: 'kg' }],
  })

  return (
    <div className="page styleguide">
      <div className="section-head">
        <div>
          <h2>Design system</h2>
          <p className="muted">
            Tokens, palette and components, rendered from the live stylesheet. Switch the theme
            (top bar) and both palettes re-prove in place. Prose reference: docs/overhaul/DESIGN_SYSTEM.md.
          </p>
        </div>
        <ThemeToggle className="btn btn-light" />
      </div>

      <div className="card">
        <h3>Colour tokens</h3>
        <div className="swatch-grid">
          {TOKENS.map(([token, name]) => (
            <div key={token} className="swatch">
              <span className="swatch-chip" style={{ background: `var(${token})` }} />
              <code>{name}</code>
              <small>{tokens[token] || '—'}</small>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Chart colours</h3>
        <p className="muted">
          Categorical slots in fixed order (slot 1 is the brand teal), sequential one-hue ramp —
          both validated for CVD separation and contrast (DESIGN_SYSTEM.md).
        </p>
        <div className="swatch-row">
          {(charts.categorical ?? []).map((hex, i) => (
            <div key={i} className="swatch">
              <span className="swatch-chip" style={{ background: hex }} />
              <small>slot {i + 1}</small>
            </div>
          ))}
        </div>
        <div className="swatch-row">
          {(charts.sequential ?? []).map((hex, i) => (
            <div key={i} className="swatch">
              <span className="swatch-chip" style={{ background: hex }} />
              <small>step {i + 1}</small>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Status palette</h3>
        <p className="muted">
          Colour + glyph + word, never colour alone. One stored status per palette state as the
          pages write it; <StatusBadge value="Available" /> stays the legacy neutral (no tone).
        </p>
        <div className="badge-grid">
          {STATUS_SAMPLES.map(({ state, stored }) => (
            <div key={state} className="badge-cell">
              <StatusBadge value={stored} />
              <small>
                {PALETTE[state]?.palette} · “{stored}”
              </small>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>KPI cards</h3>
        <div className="kpi-grid">
          {KPIS.map((card) => (
            <KpiCard key={card.key} card={card} invertDelta={card.key === 'spoilage'} />
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Freshness</h3>
        <p className="muted">
          The server's own verdict rides every figure — fresh says as-of, stale says so and stays
          until a refresh answers.
        </p>
        <p>
          <FreshnessChip {...FRESH} /> <FreshnessChip {...STALE} />
        </p>
      </div>

      <div className="card">
        <h3>Filters</h3>
        <FilterBar range={range} onRange={setRange}>
          <select className="input" aria-label="Sample filter">
            <option>All lines</option>
            <option>Line 1</option>
            <option>Line 2</option>
          </select>
        </FilterBar>
      </div>

      <div className="card">
        <h3>Chart card</h3>
        <p className="muted">Chart ↔ table relief, CSV of the same rows, freshness stamp.</p>
        <ChartCard chart={CHART} freshness={FRESH} onRefresh={() => undefined} />
      </div>

      <div className="card">
        <h3>DataTable</h3>
        <DataTable
          id="styleguide-lots"
          columns={LOT_COLUMNS}
          rows={LOTS}
          rowKey={(r) => r.lot}
          empty="No lots"
        />
      </div>

      <div className="card">
        <h3>Forms</h3>
        <Stepper
          steps={[
            { id: 'inputs', label: 'Inputs' },
            { id: 'outputs', label: 'Outputs' },
            { id: 'close', label: 'Close' },
          ]}
          current={1}
          onStep={() => undefined}
        />
        <SectionedForm
          sections={[
            {
              id: 'receipt',
              title: 'Goods receipt',
              hint: 'What arrived, from whom',
              children: <ScanInput label="Scan a pallet tag" onScan={setScanned} />,
            },
            {
              id: 'notes',
              title: 'Notes',
              hint: 'Anything the next reader needs',
              children: (
                <textarea className="input" rows={2} placeholder="Draft autosave is a page decision — the primitive is useDraft." />
              ),
            },
          ]}
          footer={
            <button type="button" className="btn btn-danger" onClick={() => setConfirmOpen(true)}>
              Void receipt
            </button>
          }
        />
        {scanned ? <p className="muted">Last scan: {scanned}</p> : null}
      </div>

      <div className="card">
        <h3>Transformation form</h3>
        <p className="muted">
          Inputs / outputs / spoilage with the mass-balance verdict folding live — the same
          isomorphic computeMassBalance the server's close gate enforces from.
        </p>
        <TransformationForm
          value={lines}
          onChange={setLines}
          items={{ 'Bulk water': { uom: 'kg' } }}
        />
        <p className="muted">Outside tolerance, said in words:</p>
        <MassBalanceBar
          inputs={[{ item: 'coconuts', qty: 600, uom: 'kg' }]}
          outputs={[{ item: 'bulk', qty: 400, uom: 'kg' }]}
          spoilage={[{ item: 'loss', qty: 95, uom: 'kg' }]}
          items={{}}
        />
      </div>

      <div className="card">
        <h3>Signature</h3>
        <p className="muted">
          Pointer events on a canvas — no dependency. {signature ? 'Signed ✓' : 'Blank.'}
        </p>
        <SignaturePad onChange={setSignature} label="QC reviewer signature" />
      </div>

      <div className="card">
        <h3>Loading</h3>
        <p className="muted">Skeletons hold the shape of what is coming, shimmering only when motion is welcome.</p>
        <KpiSkeleton />
        <Skeleton rows={3} />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Void this receipt?"
        body="The receipt and its stock lines are removed. This cannot be undone."
        confirmLabel="Void receipt"
        danger
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
