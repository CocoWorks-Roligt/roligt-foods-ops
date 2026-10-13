/**
 * The app's ONE chart chunk (guardrail: one chart library). Everything
 * chart-shaped imports ECharts through this module, tree-shaken to the six
 * kinds on the wire (line, bar, stacked, treemap, heatmap, control — control
 * is a line with mark lines). Loaded lazily by ChartCard, precached by the
 * service worker with the rest, so offline dashboards keep their charts.
 */
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, TreemapChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

let used = false

/** Idempotent registration — every mount may call it, only the first pays. */
export function useAll() {
  if (used) return
  used = true
  echarts.use([
    LineChart,
    BarChart,
    TreemapChart,
    HeatmapChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    MarkLineComponent,
    VisualMapComponent,
    CanvasRenderer,
  ])
}

export const init = echarts.init
