/**
 * The one aggregation layer (ARCHITECTURE §6): every module's KPIs, the live
 * reports and the CSV/XLSX/PDF exports all read folds under this directory, so
 * the numbers match by construction. Definitions live in KPI.md; the wire
 * shape (KpiCard/KpiChart/KpiModuleResponse) is frozen in contracts.
 *
 * B4 skeleton: the registry, the window parsing, and two reference folds
 * (qc, orders-dispatch). The remaining modules are registered with their page
 * gates and source collections but no fold — they answer empty cards/charts
 * until their module's build (Phase 5, BACKEND-first per module). The server
 * side (api/_lib/kpis.ts) adds revision-keyed memoization and the meta-cache
 * for heavy folds.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { ViewId } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import type { KpiModule } from '../contracts.ts'
import { collectionOf } from '../tables.ts'
import type { AppState } from '../../types.ts'
import { qcKpis, type KpiPayload } from './qc.ts'
import { ordersDispatchKpis } from './ordersDispatch.ts'

export type { KpiPayload }

export type KpiFold = (state: Partial<AppState>, w: ReportWindow, today: string) => KpiPayload

export interface KpiSpec {
  /** The page slugs whose holders may read the module (RBAC.md §c: the
   *  module's page slug; a module spanning pages is readable holding any). */
  pages: readonly ViewId[]
  /** AppState keys / documents collections the fold reads — also what the
   *  page-based read withholding drops before the fold sees them. */
  collections: readonly string[]
  fold?: KpiFold
  /** Heavy folds: served from the meta cache (`kpi:<module>`) within this TTL
   *  and a matching revision, per KPI.md's cached refresh marks. */
  cacheTtlSec?: number
}

export const KPI_SPECS: Record<KpiModule, KpiSpec> = {
  // PO metrics (funnel, on-time, lead time, calendar) are blocked on the
  // purchase_orders entity + PO form (DECISIONS 2026-10-13) — fold lands with it.
  procurement: { pages: ['procurement'], collections: ['grns', 'vendors', 'items'] },
  'grading-extraction': {
    pages: ['procurement', 'production'],
    collections: ['grns', 'batches', 'items', 'melanges'],
  },
  'intermediates-blending': {
    pages: ['production'],
    collections: ['batches', 'items', 'melanges', 'productionPlans'],
  },
  packing: {
    pages: ['packing'],
    collections: ['packingRuns', 'productionPlans', 'products', 'batches', 'items'],
  },
  qc: { pages: ['quality'], collections: ['qcs', 'batches', 'items'], fold: qcKpis },
  'control-samples': { pages: ['control-samples'], collections: ['packingRuns'] },
  inventory: { pages: ['inventory'], collections: ['items', 'storageLocations'] },
  'packaging-materials': { pages: ['packing-materials'], collections: ['items'] },
  'orders-dispatch': {
    pages: ['orders', 'dispatch'],
    collections: ['orders', 'dispatches', 'items', 'customers', 'batches'],
    fold: ordersDispatchKpis,
  },
  // The shipments/challans entities land with SHIPMENT (Phase 4); the module
  // is registered now so the layer's cached-fold path has a real first user.
  'shipment-tracking': { pages: ['dispatch'], collections: ['shipments', 'dispatches'], cacheTtlSec: 3600 },
}

export const KPI_MODULES_LIST = Object.keys(KPI_SPECS) as KpiModule[]

/** The documents collection a spec key reads — CollectionKey keys resolve
 *  through the tables registry; overhaul-only collections (shipments, …)
 *  are their own wire names. */
export const wireCollectionOf = (key: string): string => collectionOf(key as never)?.table ?? key

/** The trailing-6-months default when the caller sends no window. */
export function parseKpiWindow(q: Record<string, unknown>): ReportWindow {
  const to = typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : localToday()
  const from =
    typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from)
      ? q.from
      : sixMonthsBefore(to)
  return from <= to ? { from, to } : { from: to, to: from }
}

const localToday = (): string => new Date().toISOString().slice(0, 10)

const sixMonthsBefore = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 6)
  return d.toISOString().slice(0, 10)
}

/** stale_after default (seconds) — configurable via meta app_config
 *  `kpiStaleAfterSec` (DECISIONS); Freshness.stale is the server's own verdict
 *  at read time. */
export const DEFAULT_STALE_AFTER_SEC = 300
