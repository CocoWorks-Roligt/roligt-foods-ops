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
import { inWindow } from '../reports/params.ts'
import type { ExportColumn } from './csv.ts'
import { procurementLotRows, type ProcurementLotRow } from '../reports/procurement.ts'
import { qualityReport } from '../reports/qualityReport.ts'
import { netNewOutputs } from '../reports/production.ts'
import { openBlendRuns } from '../blendStage.ts'
import { packFormatOf } from '../kpis/packing.ts'
import type { PurchaseOrder, SpoilageRecord } from '../contracts.ts'

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

/** The documents collections the module registers read — same shape as the
 *  lot report's adapter above. */
type WithDocs = Partial<AppState> & {
  purchase_orders?: PurchaseOrder[]
  spoilage_records?: SpoilageRecord[]
}

const docsState = (state: Partial<AppState>): WithDocs => state as WithDocs

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
  // ── P5 module registers (D1b): the Procurement and Grading & Extraction
  // dashboards' Export row folds these — windowed the same way their KPI folds
  // window, so the file and the chart cannot disagree.
  'purchase-orders': spec({
    key: 'purchase-orders',
    title: 'Purchase order register',
    pages: ['live-reports', 'procurement'],
    collections: ['purchase_orders', 'vendors'],
    // The funnel's own window rule: a PO with a promised day sits in its day's
    // window; an un-promised PO (a draft, usually) counts in whatever window is
    // open — hiding it would make the register shorter than the funnel's total.
    rows: (state, w) => {
      const s = docsState(state)
      const pos = (s.purchase_orders ?? []).filter((p) => !p.expectedOn || inWindow(p.expectedOn, w))
      const vendorName = (id: string): string => s.vendors?.find((v) => v.id === id)?.name || id || '—'
      return pos
        .sort((a, b) => a.number.localeCompare(b.number))
        .map((p) => ({
          number: p.number,
          vendor: vendorName(p.vendorId),
          // The funnel's own spelling — 'Sent', not 'sent' — so the register
          // and the chart it sits beside read the same word.
          status: p.status[0].toUpperCase() + p.status.slice(1),
          expectedOn: p.expectedOn ?? '',
          items: p.lines.map((l) => `${l.item} · ${l.qty} ${l.uom}`).join('; '),
          lines: p.lines.length,
          value: p.lines.reduce((t, l) => t + l.qty * l.rate, 0),
          receipts: p.receivedGrnIds.length,
        }))
    },
    columns: [
      { header: 'PO', value: (r) => r.number },
      { header: 'Vendor', value: (r) => r.vendor },
      { header: 'Status', value: (r) => r.status },
      { header: 'Expected on', value: (r) => r.expectedOn || '—' },
      { header: 'Items', value: (r) => r.items },
      { header: 'Lines', value: (r) => r.lines },
      { header: 'Ordered value', value: (r) => num(r.value, 2) },
      { header: 'Receipts linked', value: (r) => r.receipts },
    ],
  }),
  spoilage: spec({
    key: 'spoilage',
    title: 'Spoilage register',
    pages: ['live-reports', 'production'],
    collections: ['spoilage_records', 'batches'],
    // The pareto's own join: a record rides the window its BATCH sits in (the
    // close stamps both together), so the register and the chart count the same
    // records against the same window.
    rows: (state, w) => {
      const s = docsState(state)
      const batches = (state.batches ?? []).filter((b) => inWindow(b.date, w))
      const kindOf = new Map(batches.map((b) => [b.id, b.kind] as const))
      return (s.spoilage_records ?? [])
        .filter((r) => kindOf.has(r.batchId))
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((r) => ({
          batch: r.batchId,
          kind: kindOf.get(r.batchId) ?? '',
          stage: r.stage,
          reason: r.reasonCode,
          qty: r.qty,
          uom: r.uom,
          at: r.at,
          by: r.actor,
        }))
    },
    columns: [
      { header: 'Batch', value: (r) => r.batch },
      { header: 'Kind', value: (r) => r.kind },
      { header: 'Stage', value: (r) => r.stage },
      { header: 'Reason', value: (r) => r.reason },
      { header: 'Qty', value: (r) => r.qty },
      { header: 'Unit', value: (r) => r.uom },
      { header: 'Recorded at', value: (r) => r.at },
      { header: 'By', value: (r) => r.by },
    ],
  }),
  // ── P5 module registers (D2b): the Intermediates & Blending and Packing
  // dashboards' Export rows fold these — windowed the same way their KPI folds
  // window (blend runs by batch date, packing runs by run date), so the file
  // and the chart cannot disagree.
  'blend-runs': spec({
    key: 'blend-runs',
    title: 'Blend run register',
    pages: ['live-reports', 'production'],
    collections: ['batches', 'melanges', 'items'],
    // The fold's own window rule: a blend run rides its batch date. Status is
    // the fold's own vocabulary — openBlendRuns' predicate decides Open/Closed,
    // the same word the dashboard's runs-by-status chart prints.
    rows: (state, w) => {
      const itemName = (id: string): string => state.items?.find((i) => i.id === id)?.name || id
      const runs = (state.batches ?? [])
        .filter((b) => b.kind === 'Melange' && inWindow(b.date, w))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      const open = new Set(openBlendRuns(state.batches ?? []).map((b) => b.id))
      return runs.map((b) => ({
        batch: b.id,
        date: b.date,
        recipe: state.melanges?.find((m) => m.id === b.melangeId)?.name || itemName(b.blendLines?.[0]?.item ?? '') || b.id,
        status: open.has(b.id) ? 'Open' : 'Closed',
        drawn: (b.blendLines ?? []).map((l) => `${itemName(l.item)} · ${l.qty} ${l.uom ?? ''}`.trim()).join('; '),
        netNew: netNewOutputs(b).map((o) => `${o.qty} ${o.uom}`).join(' · '),
        spoiled: b.spoiled || 0,
        cost: (b.rmCost || 0) + (b.pmCost || 0) + (b.directCost || 0),
        costPerUnit: b.costPerL || 0,
      }))
    },
    columns: [
      { header: 'Batch', value: (r) => r.batch },
      { header: 'Date', value: (r) => r.date },
      { header: 'Recipe', value: (r) => r.recipe },
      { header: 'Status', value: (r) => r.status },
      { header: 'Components drawn', value: (r) => r.drawn },
      { header: 'Net-new output', value: (r) => r.netNew },
      { header: 'Spoiled', value: (r) => r.spoiled },
      { header: 'Total cost', value: (r) => num(r.cost, 2) },
      { header: 'Cost per unit', value: (r) => num(r.costPerUnit, 2) },
    ],
  }),
  'packing-runs': spec({
    key: 'packing-runs',
    title: 'Packing run register',
    pages: ['live-reports', 'packing'],
    collections: ['packingRuns', 'products'],
    // The fold's own window rule: a packing run rides its run date. The line
    // summary and the BIB count read the product master with the fold's own
    // packFormatOf, so the register's BIB share reconciles with the card's.
    rows: (state, w) => {
      const runs = (state.packingRuns ?? [])
        .filter((r) => inWindow(r.date, w))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      return runs.map((r) => {
        const lines = r.lines.map((l) => {
          const p = state.products?.find((x) => x.id === l.sku)
          return `${p ? packFormatOf(p) : l.sku} · ${l.packs} × ${p?.packName || p?.name || l.sku}`
        })
        return {
          run: r.id,
          date: r.date,
          batch: r.batchId,
          bulk: r.bulkItem || r.medium,
          packs: r.lines.reduce((a, l) => a + (l.packs || 0), 0),
          bibPacks: r.lines.reduce((a, l) => {
            const p = state.products?.find((x) => x.id === l.sku)
            return a + (p && packFormatOf(p) === 'bib' ? l.packs || 0 : 0)
          }, 0),
          lines: lines.join('; '),
          drawn: r.drawn,
          status: r.status,
        }
      })
    },
    columns: [
      { header: 'Run', value: (r) => r.run },
      { header: 'Date', value: (r) => r.date },
      { header: 'Batch', value: (r) => r.batch },
      { header: 'Bulk', value: (r) => r.bulk },
      { header: 'Packs', value: (r) => r.packs },
      { header: 'BIB packs', value: (r) => r.bibPacks },
      { header: 'Lines', value: (r) => r.lines },
      { header: 'Bulk drawn', value: (r) => r.drawn },
      { header: 'Status', value: (r) => r.status },
    ],
  }),
} satisfies Record<string, RegisteredExportSpec>

export type ExportReport = keyof typeof EXPORT_SPECS
export const EXPORT_REPORTS_LIST = Object.keys(EXPORT_SPECS) as ExportReport[]
export const exportSpec = (key: string): RegisteredExportSpec | undefined =>
  (EXPORT_SPECS as Record<string, RegisteredExportSpec>)[key]
