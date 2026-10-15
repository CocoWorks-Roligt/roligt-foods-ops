/**
 * The export registry (ARCHITECTURE §6): GET /api/exports/:report folds each
 * report's rows over the SAME lib/reports derivations the on-screen live
 * reports read, so the file an operator downloads can never disagree with the
 * table they are looking at. The api side (api/_lib/exports.ts) owns RBAC,
 * the format renderers, the stream-vs-job verdict and the audit row.
 *
 * Specs land per module in Phase 5 (BACKEND first); this file opens with the
 * three that prove the pattern. Every classic report keeps its Classic key so
 * a link someone saved keeps answering.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

import type { AppState, ViewId } from '../../types.ts'
import type { ReportWindow } from '../reports/params.ts'
import type { ExportColumn } from './csv.ts'
import { procurementLotRows, type ProcurementLotRow } from '../reports/procurement.ts'
import { qualityReport } from '../reports/qualityReport.ts'

export type { ExportColumn }

export interface ExportSpec<R> {
  key: string
  title: string
  /** RBAC: the pages whose holders may run this export. The classic reports
   *  ride the open-tier Live Reports page, so that is their gate — visibility
   *  exactly what the on-screen report allows (agents hold no such page). */
  pages: readonly ViewId[]
  /** AppState keys / documents collections the fold reads — also what the
   *  page-based read withholding drops before the fold sees them. */
  collections: readonly string[]
  columns: ExportColumn<R>[]
  rows: (state: Partial<AppState>, w: ReportWindow, today: string) => R[]
  /** Extra filter keys the fold honours beyond the window, for the header. */
  filterKeys?: readonly string[]
}

/** A spec with its row type existentially erased, so heterogeneous specs sit in
 *  one record. The column functions take `never` (bottom — accepts every R,
 *  contravariance doing the erasing); the fold returns `unknown[]`. Consumers
 *  that render cast columns once, to ExportColumn<unknown>[]. */
export interface RegisteredExportSpec {
  key: string
  title: string
  pages: readonly ViewId[]
  collections: readonly string[]
  columns: { header: string; value: (row: never) => string | number | null | undefined }[]
  rows: (state: Partial<AppState>, w: ReportWindow, today: string) => unknown[]
  filterKeys?: readonly string[]
}

const spec = <R>(s: ExportSpec<R>): RegisteredExportSpec => s as RegisteredExportSpec

/** The lot report's columns — the fruits export IS the lot report filtered to
 *  fruit (its Classic definition), so the two specs share one column list. */
const LOT_COLUMNS: ExportColumn<ProcurementLotRow>[] = [
  { header: 'GRN', value: (r) => r.grnId },
  { header: 'Lot', value: (r) => r.lot },
  { header: 'Date', value: (r) => r.date },
  { header: 'Supplier', value: (r) => r.supplier },
  { header: 'Farmer', value: (r) => r.farmer },
  { header: 'Product', value: (r) => r.product },
  { header: 'Unit', value: (r) => r.uom },
  { header: 'Total', value: (r) => r.total },
  { header: 'Free', value: (r) => r.free },
  { header: 'Grade A', value: (r) => r.a },
  { header: 'Grade B', value: (r) => r.b },
  { header: 'Grade C', value: (r) => r.c },
  { header: 'Reject', value: (r) => r.reject },
  { header: 'Accepted', value: (r) => r.accepted },
  { header: 'Rate', value: (r) => r.rate },
  { header: 'Transport', value: (r) => r.transport },
  { header: 'Landed', value: (r) => num(r.landed, 2) },
  { header: 'Usable cost', value: (r) => num(r.usableCost, 2) },
  { header: 'Per accepted', value: (r) => num(r.perAccepted, 2) },
]

const lotState = (state: Partial<AppState>): Parameters<typeof procurementLotRows>[0] =>
  ({ grns: state.grns ?? [], purchaseProducts: state.purchaseProducts ?? [] }) as Parameters<typeof procurementLotRows>[0]

const num = (n: number | undefined | null, digits = 0): number =>
  n == null ? 0 : Number(n.toFixed(digits))

export const EXPORT_SPECS = {
  'procurement-lots': spec({
    key: 'procurement-lots',
    title: 'Procurement lot report',
    pages: ['live-reports'],
    collections: ['grns', 'purchaseProducts'],
    rows: (state, w) => procurementLotRows(lotState(state), w),
    columns: LOT_COLUMNS,
  }),
  fruits: spec({
    key: 'fruits',
    title: 'Fruits procurement',
    pages: ['live-reports'],
    collections: ['grns', 'purchaseProducts'],
    rows: (state, w) => procurementLotRows(lotState(state), w, { fruitsOnly: true }),
    columns: LOT_COLUMNS,
  }),
  quality: spec({
    key: 'quality',
    title: 'Quality report',
    pages: ['live-reports'],
    collections: ['qcs', 'batches', 'items'],
    rows: (state, w) => {
      const report = qualityReport(
        {
          qcs: state.qcs ?? [],
          batches: state.batches ?? [],
          items: state.items ?? [],
        },
        w,
      )
      return report.byProduct.map((s) => ({
        product: s.key,
        records: s.records,
        released: s.released,
        rejected: s.rejected,
        retest: s.retest,
        pending: s.pending,
        releaseRate: s.releaseRate,
        rejectRate: s.rejectRate,
      }))
    },
    columns: [
      { header: 'Product', value: (r) => r.product },
      { header: 'Records', value: (r) => r.records },
      { header: 'Released', value: (r) => r.released },
      { header: 'Rejected', value: (r) => r.rejected },
      { header: 'Retest', value: (r) => r.retest },
      { header: 'Pending', value: (r) => r.pending },
      { header: 'Release rate %', value: (r) => r.releaseRate ?? '—' },
      { header: 'Reject rate %', value: (r) => r.rejectRate ?? '—' },
    ],
  }),
} satisfies Record<string, RegisteredExportSpec>

export type ExportReport = keyof typeof EXPORT_SPECS
export const EXPORT_REPORTS_LIST = Object.keys(EXPORT_SPECS) as ExportReport[]
export const exportSpec = (key: string): RegisteredExportSpec | undefined =>
  (EXPORT_SPECS as Record<string, RegisteredExportSpec>)[key]
