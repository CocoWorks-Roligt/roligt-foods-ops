import { useEffect, useRef, useState } from 'react'
import type { Freshness, KpiChart } from '../../lib/contracts.ts'
import { exportCsv } from '../../lib/export.ts'
import { chartColors, seriesColor } from '../../lib/chartTheme.ts'
import { fmtQty } from '../../lib/utils'
import { FreshnessChip } from './FreshnessChip'

/**
 * Every dashboard chart wears the same card (overhaul §2 SHELL): a title, the
 * freshness stamp, a chart the operator can flip to a table (the relief rule —
 * a chart whose colours fall under 3:1 on the surface is legal only because
 * the table and labels ship with it), and a CSV of the same rows. One lazy
 * chunk carries ECharts for every kind; nothing chart-shaped loads on boot.
 */
export function ChartCard({
  chart,
  freshness,
  height = 260,
  onRefresh,
}: {
  chart: KpiChart
  freshness: Freshness
  height?: number
  onRefresh?: () => void
}) {
  const [asTable, setAsTable] = useState(false)

  const download = () =>
    exportCsv(chart.label, [
      { header: 'Series', value: (r: typeof chart.rows[number]) => r.series ?? '' },
      { header: chart.label, value: (r: typeof chart.rows[number]) => r.label },
      { header: 'Value', value: (r: typeof chart.rows[number]) => r.value },
    ], chart.rows)

  return (
    <div className="chart-card">
      <div className="chart-head">
        <h4>{chart.label}</h4>
        <div className="chart-tools">
          <FreshnessChip {...freshness} />
          {onRefresh ? (
            <button type="button" className="icon-btn" aria-label="Refresh" onClick={onRefresh}>
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M9.6 6a3.6 3.6 0 1 1-1.1-2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M9.8 1.6v2.2H7.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-chip"
            aria-pressed={asTable}
            onClick={() => setAsTable((t) => !t)}
          >
            {asTable ? 'Chart' : 'Table'}
          </button>
          <button type="button" className="btn btn-chip" onClick={download}>
            CSV
          </button>
        </div>
      </div>
      {asTable ? (
        <ChartTable chart={chart} />
      ) : (
        <EChart kind={chart.kind} rows={chart.rows} label={chart.label} height={height} />
      )}
    </div>
  )
}

function ChartTable({ chart }: { chart: KpiChart }) {
  const hasSeries = chart.rows.some((r) => r.series)
  return (
    <div className="dt-scroll chart-table">
      <table>
        <thead>
          <tr>
            {hasSeries ? <th scope="col">Series</th> : null}
            <th scope="col">{chart.label}</th>
            <th scope="col" className="num">Value</th>
            {chart.rows.some((r) => r.min != null) ? <th scope="col" className="num">Min</th> : null}
            {chart.rows.some((r) => r.target != null) ? <th scope="col" className="num">Target</th> : null}
            {chart.rows.some((r) => r.max != null) ? <th scope="col" className="num">Max</th> : null}
          </tr>
        </thead>
        <tbody>
          {chart.rows.map((r, i) => (
            <tr key={`${r.series ?? ''}|${r.label}|${i}`}>
              {hasSeries ? <td>{r.series ?? ''}</td> : null}
              <td>{r.label}</td>
              <td className="num">{fmtQty(r.value)}</td>
              {chart.rows.some((x) => x.min != null) ? <td className="num">{r.min != null ? fmtQty(r.min) : '—'}</td> : null}
              {chart.rows.some((x) => x.target != null) ? <td className="num">{r.target != null ? fmtQty(r.target) : '—'}</td> : null}
              {chart.rows.some((x) => x.max != null) ? <td className="num">{r.max != null ? fmtQty(r.max) : '—'}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The canvas itself. ECharts is imperative, so this owns the whole lifecycle:
 * one dynamic import (the app's single chart chunk), option built from the
 * wire rows, re-init on theme flip (a canvas cannot re-read CSS tokens — the
 * observer watches the attribute that carries the theme), and dispose on
 * unmount so navigating away lets the chart go.
 */
function EChart({ kind, rows, label, height }: { kind: KpiChart['kind']; rows: KpiChart['rows']; label: string; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    let chart: { setOption: (o: unknown) => void; resize: () => void; dispose: () => void } | null = null
    let ro: ResizeObserver | null = null
    let mo: MutationObserver | null = null

    const build = async () => {
      try {
        const echarts = await import('./echartsChunk.ts')
        if (disposed || !ref.current) return
        const c = chartColors()
        echarts.useAll()
        chart = echarts.init(ref.current)
        chart.setOption(buildOption(kind, rows, label, c))
        ro = new ResizeObserver(() => chart?.resize())
        ro.observe(ref.current)
        // Theme flips rewrite the tokens; a canvas holds its pixels, so watch
        // the carrier attribute and rebuild the option in the new palette.
        mo = new MutationObserver(() => {
          if (!disposed && chart) chart.setOption(buildOption(kind, rows, label, chartColors()))
        })
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      } catch {
        setFailed(true)
      }
    }
    void build()

    return () => {
      disposed = true
      ro?.disconnect()
      mo?.disconnect()
      chart?.dispose()
    }
  }, [kind, rows, label])

  if (failed) return <div className="chart-fallback" style={{ height }}>Chart unavailable — the table view carries the same numbers.</div>
  return <div ref={ref} style={{ height, width: '100%' }} role="img" aria-label={`${label} chart`} />
}

/** The wire rows → one ECharts option, per the six chart kinds on the wire. */
function buildOption(
  kind: KpiChart['kind'],
  rows: KpiChart['rows'],
  label: string,
  c: ReturnType<typeof chartColors>,
): Record<string, unknown> {
  const seriesNames = [...new Set(rows.map((r) => r.series).filter((s): s is string => s != null))]
  const labels = [...new Set(rows.map((r) => r.label))]
  const color = (series: string | undefined) =>
    series == null ? seriesColor(c, 0) : seriesColor(c, Math.max(0, seriesNames.indexOf(series)))

  const grid = { left: 8, right: 12, top: seriesNames.length > 1 ? 34 : 14, bottom: 4, containLabel: true }
  const axis = (extra: Record<string, unknown> = {}) => [
    { type: 'category', data: labels, axisLine: { lineStyle: { color: c.hair } }, axisTick: { show: false }, axisLabel: { color: c.inkSoft, fontSize: 11 }, ...extra },
    { type: 'value', splitLine: { lineStyle: { color: c.hair } }, axisLabel: { color: c.inkSoft, fontSize: 11 } },
  ]
  const lineBar = (type: 'line' | 'bar', stacked: boolean) => ({
    ...c.base,
    grid,
    legend: seriesNames.length > 1 ? { top: 0, textStyle: { color: c.inkSoft, fontSize: 11 } } : undefined,
    tooltip: { ...c.base.tooltip, trigger: 'axis' },
    xAxis: axis()[0],
    yAxis: axis()[1],
    series: (seriesNames.length ? seriesNames : [undefined]).map((name) => {
      const own = rows.filter((r) => r.series === name)
      return {
        name: name ?? label,
        type,
        data: own.length ? own.map((r) => r.value) : labels.map((l) => rows.find((r) => r.label === l && r.series === name)?.value ?? null),
        ...(stacked && seriesNames.length > 1 ? { stack: 'total' } : {}),
        itemStyle: { color: color(name), ...(type === 'bar' ? { borderRadius: [4, 4, 0, 0], borderColor: c.panel, borderWidth: stacked ? 1 : 0 } : {}) },
        lineStyle: type === 'line' ? { width: 2, color: color(name) } : undefined,
        symbolSize: type === 'line' ? 8 : undefined,
        emphasis: { focus: 'series' },
      }
    }),
  })

  switch (kind) {
    case 'line':
      return lineBar('line', false)
    case 'bar':
      return lineBar('bar', false)
    case 'stacked':
      return lineBar('bar', true)
    case 'control': {
      const base = lineBar('line', false) as { series: Record<string, unknown>[] }
      const limits = rows[0]
      const marks = [
        limits?.min != null ? { yAxis: limits.min, name: 'Min' } : null,
        limits?.target != null ? { yAxis: limits.target, name: 'Target' } : null,
        limits?.max != null ? { yAxis: limits.max, name: 'Max' } : null,
      ].filter((m): m is { yAxis: number; name: string } => m != null)
      if (marks.length && base.series[0]) {
        base.series[0].markLine = {
          silent: true,
          symbol: 'none',
          lineStyle: { type: 'dashed', width: 1 },
          label: { formatter: '{b}', color: c.inkSoft, fontSize: 10 },
          data: marks,
        }
      }
      return base
    }
    case 'treemap':
      return {
        ...c.base,
        tooltip: { ...c.base.tooltip, formatter: '{b}: {c}' },
        series: [
          {
            type: 'treemap',
            data: rows.map((r) => ({ name: r.label, value: r.value, itemStyle: { color: color(r.series) } })),
            label: { color: c.ink, fontSize: 11 },
            breadcrumb: { show: false },
            itemStyle: { borderColor: c.panel, borderWidth: 2, gapWidth: 2 },
            upperLabel: { show: false },
          },
        ],
      }
    case 'heatmap': {
      // Rows carry series=y, label=x, value=heat — a matrix folded flat.
      const ys = seriesNames.length ? seriesNames : [label]
      const data = rows.map((r) => [labels.indexOf(r.label), ys.indexOf(r.series ?? label), r.value])
      return {
        ...c.base,
        grid: { left: 8, right: 12, top: 14, bottom: 40, containLabel: true },
        tooltip: { ...c.base.tooltip, formatter: (p: { data: [number, number, number] }) => `${ys[p.data[1]] ?? ''} · ${labels[p.data[0]]}: ${fmtQty(p.data[2])}` },
        xAxis: { type: 'category', data: labels, axisLabel: { color: c.inkSoft, fontSize: 11 } },
        yAxis: { type: 'category', data: ys, axisLabel: { color: c.inkSoft, fontSize: 11 } },
        visualMap: {
          min: Math.min(...rows.map((r) => r.value), 0),
          max: Math.max(...rows.map((r) => r.value), 1),
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          inRange: { color: c.sequential },
          textStyle: { color: c.inkSoft, fontSize: 10 },
        },
        series: [{ type: 'heatmap', data, itemStyle: { borderColor: c.panel, borderWidth: 2 } }],
      }
    }
  }
}
