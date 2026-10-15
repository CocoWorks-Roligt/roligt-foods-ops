/**
 * The dashboards catalog (P5 D1b): one card per KPI module on Live Reports,
 * behind that module's own `dashboards_<module>` flag. The gate is the SAME
 * rule /api/kpis/:module enforces — flag on AND one of the module's KPI pages
 * held — pre-checked client-side so the catalog never offers a dashboard the
 * API would refuse; visibility and the wire cannot disagree.
 *
 * The dashboards themselves read useKpis (the one aggregation layer), so a
 * module's card, its charts and its export register all count the same rows.
 * Modules whose fold has not landed yet stay flag-OFF (the backfill seeds every
 * `dashboards_<module>` OFF); a flag staged early renders the API's honest
 * empty cards, never a client-side guess.
 */

import type { KpiModule } from './contracts.ts'
import { KPI_SPECS } from './kpis/index.ts'
import { canViewPage } from './pages.ts'
import type { FlagMap } from './rules/flags.ts'
import type { ReportKey } from './reports/index.ts'

export interface DashboardDef {
  module: KpiModule
  title: string
  /** One sentence for the catalog card. */
  blurb: string
  /** The records the module's figures fold — printed on the card. */
  sources: string
  /** The classic live reports the module's numbers also read — its "Reports"
   *  links. Empty where no classic report covers the module yet. */
  reports: readonly ReportKey[]
  /** Export register keys the module's Export row offers (EXPORT_SPECS keys —
   *  titles come from the spec, never restated here). */
  exports: readonly string[]
}

/** The DASHBOARDS agent's build order (overhaul §7) — the catalog shows them
 *  in process order, exactly the order the phases build them. */
export const DASHBOARDS: readonly DashboardDef[] = [
  {
    module: 'procurement',
    title: 'Procurement',
    blurb: 'Purchase orders by status, supplier on-time %, spend, pending deliveries and coconut intake.',
    sources: 'Goods receipts + purchase orders',
    reports: ['procurement-lots', 'fruits', 'lot-yield'],
    exports: ['procurement-lots', 'fruits', 'purchase-orders'],
  },
  {
    module: 'grading-extraction',
    title: 'Grading & Extraction',
    blurb: 'Grade mix and reject %, yield per 100 nuts, spoilage Pareto, mass-balance variance and cycle time.',
    sources: 'Goods receipts + production batches',
    reports: ['batch-wise', 'production'],
    exports: ['spoilage'],
  },
  {
    module: 'intermediates-blending',
    title: 'Intermediates & Blending',
    blurb: 'Blend runs, recipe variance, intermediate stock and expiry, output vs plan.',
    sources: 'Production batches + recipes + plans',
    reports: ['production', 'batch-wise'],
    exports: ['blend-runs'],
  },
  {
    module: 'packing',
    title: 'Packing',
    blurb: 'Throughput per shift, packed vs planned, glass vs BIB mix, fill wastage.',
    sources: 'Packing runs + plans',
    reports: ['production'],
    exports: ['packing-runs'],
  },
  {
    module: 'qc',
    title: 'Quality Control',
    blurb: 'Pass/fail trend, failed tests by category, pending queue aging, turnaround, quarantine volume.',
    sources: 'QC records + batches',
    reports: ['quality'],
    exports: ['quality', 'qc-records'],
  },
  {
    module: 'control-samples',
    title: 'Control Samples',
    blurb: 'Samples by batch, retention-expiry timeline, due and expiring.',
    sources: 'Packing runs',
    reports: [],
    exports: ['control-samples'],
  },
  {
    module: 'inventory',
    title: 'Inventory & Storage',
    blurb: 'Stock by category, near-expiry, slow-moving, reorder alerts, ageing.',
    sources: 'Ledger + item masters',
    reports: ['rm', 'storage'],
    exports: [],
  },
  {
    module: 'packaging-materials',
    title: 'Packaging Materials',
    blurb: 'Stock vs min/max, consumption trend, boxed vs loose ratio.',
    sources: 'Ledger + item masters',
    reports: ['pm'],
    exports: [],
  },
  {
    module: 'orders-dispatch',
    title: 'Orders & Dispatch',
    blurb: 'Order pipeline, fulfilment %, overdue orders, dispatch vs plan.',
    sources: 'Orders + dispatches',
    reports: ['dispatch'],
    exports: [],
  },
  {
    module: 'shipment-tracking',
    title: 'Shipment Tracking',
    blurb: 'Status board, on-time %, failed and returned reasons, agent performance.',
    sources: 'Shipments + dispatches',
    reports: ['dispatch'],
    exports: [],
  },
]

export const dashboardDef = (module: string): DashboardDef | undefined =>
  DASHBOARDS.find((d) => d.module === module)

/** The dashboards this caller may open: the module's flag is on AND they hold
 *  one of the module's KPI pages — /api/kpis/:module's own gate (the KPI
 *  registry's `pages`), so the card and the endpoint answer together. */
export function visibleDashboards(flags: FlagMap, held: readonly string[]): DashboardDef[] {
  return DASHBOARDS.filter(
    (d) =>
      flags.dashboards[d.module] === true &&
      KPI_SPECS[d.module].pages.some((p) => canViewPage(held, p)),
  )
}
