import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FilterBar } from '../shell/FilterBar'
import { ChartCard } from '../shell/ChartCard'
import { FreshnessChip } from '../shell/FreshnessChip'
import { KpiCard } from '../shell/KpiCard'
import { Skeleton } from '../shell/Skeleton'
import { EmptyState } from '../EmptyState'
import { Select } from '../Select'
import { useApp } from '../../context/AppContext'
import { useKpis } from '../../lib/useKpis'
import { downloadExport } from '../../lib/exportJob'
import { exportSpec } from '../../lib/exports/index.ts'
import { reportDef } from '../../lib/reports/index.ts'
import type { DashboardDef } from '../../lib/dashboards'
import type { ExportFormat } from '../../lib/contracts'

/**
 * One module's dashboard (P5): KPI cards + charts over /api/kpis/:module — the
 * same fold the exports read — with the date window in the URL so any view an
 * operator reaches is a view they can link. The module's classic live reports
 * and its export register sit under the charts: the dashboard is the
 * at-a-glance half, the report rows are the proof.
 *
 * Every state is honest: skeletons while loading, the error's own words, and
 * an empty state when the window has no figures — never a zero that could be
 * read as "nothing ever".
 */
const FORMATS: ExportFormat[] = ['csv', 'xlsx', 'pdf']

export function ModuleDashboard({ def }: { def: DashboardDef }) {
  const { showToast } = useApp()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const kpis = useKpis(def.module, from || undefined, to || undefined)
  const [register, setRegister] = useState(def.exports[0] ?? '')
  const [busy, setBusy] = useState(false)

  const onRange = (r: { from: string; to: string }) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('from', r.from)
      next.set('to', r.to)
      return next
    })

  const runExport = async (format: ExportFormat) => {
    if (!register) return
    setBusy(true)
    try {
      const out = await downloadExport(register, { format, from: from || undefined, to: to || undefined })
      showToast(out.kind === 'job' ? 'Export ready — the file is downloading.' : 'Export downloaded.')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'The export could not run.')
    } finally {
      setBusy(false)
    }
  }

  const windowNote = from && to ? `${from} to ${to}` : 'the default six months'

  return (
    <div className="card module-dashboard">
      <div className="section-head">
        <div>
          <h3>{def.title} dashboard</h3>
          <span>{def.blurb} Window: {windowNote}.</span>
        </div>
        <div className="module-tools">
          {kpis.data ? <FreshnessChip last_updated={kpis.data.last_updated} stale={kpis.data.stale} /> : null}
          <button type="button" className="btn" onClick={kpis.refresh}>
            Refresh
          </button>
        </div>
      </div>

      <FilterBar range={{ from: from || defaultFrom(), to: to || todayKey() }} onRange={onRange} />

      {kpis.loading && !kpis.data ? (
        <div className="kpi-row" aria-busy="true" aria-label="Loading figures">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="kpi-card" rows={2} />
          ))}
        </div>
      ) : kpis.error ? (
        <div className="warning-note" role="alert">{kpis.error}</div>
      ) : !kpis.data?.cards.length && !kpis.data?.charts.length ? (
        <EmptyState
          filtered={false}
          empty={`No figures for ${def.title.toLowerCase()} over ${windowNote} — widen the range or check back after the next entry.`}
          onClear={() =>
            setParams((prev) => {
              const next = new URLSearchParams(prev)
              next.delete('from')
              next.delete('to')
              return next
            })
          }
        />
      ) : (
        <>
          {kpis.data?.cards.length ? (
            <div className="kpi-row" aria-label={`${def.title} figures`}>
              {kpis.data.cards.map((c) => (
                <KpiCard key={c.key} card={c} />
              ))}
            </div>
          ) : null}
          {kpis.data?.charts.length ? (
            <div className="chart-grid" aria-label={`${def.title} charts`}>
              {kpis.data.charts.map((ch) => (
                <ChartCard key={ch.key} chart={ch} freshness={kpis.data!} onRefresh={kpis.refresh} />
              ))}
            </div>
          ) : null}
        </>
      )}

      {def.reports.length || def.exports.length ? (
        <div className="module-under">
          {def.reports.length ? (
            <div className="module-reports">
              <h4>Reports</h4>
              {def.reports.map((key) => {
                const r = reportDef(key)
                if (!r) return null
                return (
                  <Link key={key} className="btn btn-chip" to={`/reports/live?type=${key}`}>
                    {r.title}
                  </Link>
                )
              })}
            </div>
          ) : null}
          {def.exports.length ? (
            <div className="module-export">
              <h4>Export</h4>
              <Select
                aria-label="Export register"
                value={register}
                onChange={(e) => setRegister(e.target.value)}
              >
                {def.exports.map((k) => (
                  <option key={k} value={k}>
                    {exportSpec(k)?.title ?? k}
                  </option>
                ))}
              </Select>
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="btn btn-chip"
                  disabled={busy}
                  onClick={() => void runExport(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="module-hint">
        Figures fold live off the records — the dashboard, its reports and every export read the same rows.
      </p>
    </div>
  )
}

/** parseKpiWindow's own default, mirrored — from = six months before today. */
const todayKey = (): string => new Date().toISOString().slice(0, 10)
const defaultFrom = (): string => {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - 6)
  return d.toISOString().slice(0, 10)
}
