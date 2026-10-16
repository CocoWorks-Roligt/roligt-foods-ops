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
import { localDay } from '../utils.ts'
import type { ExportColumn } from './csv.ts'
import { procurementLotRows, type ProcurementLotRow } from '../reports/procurement.ts'
import { qualityReport } from '../reports/qualityReport.ts'
import { netNewOutputs } from '../reports/production.ts'
import { openBlendRuns } from '../blendStage.ts'
import { packFormatOf } from '../kpis/packing.ts'
import { qcStatuses } from '../qcCategories.ts'
import { controlSampleRows } from '../controlSamples.ts'
import { stockRows, locationLabel, itemTypeLabel } from '../stock.ts'
import { itemFlows, daysBetween } from '../reports/inventoryReports.ts'
import type { PurchaseOrder, SpoilageRecord, Challan, Shipment } from '../contracts.ts'

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
  /** A POSITION register: its rows are balances, not events, so the window
   *  applies to nothing — the header says "Position as of <today>" instead of
   *  a window that was never applied. The fold's rows ignore `w`. */
  position?: true
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
  position?: true
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
  challans?: Challan[]
  shipments?: Shipment[]
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
  // ── P5 module registers (D3b): the QC and Control Samples dashboards'
  // Export rows fold these — windowed and worded the same way their KPI folds
  // are, so the file and the chart cannot disagree.
  'qc-records': spec({
    key: 'qc-records',
    title: 'QC record register',
    pages: ['live-reports', 'quality'],
    collections: ['qcs', 'batches', 'items'],
    // The report's own window rule: a record rides its BATCH's date. The
    // turnaround and failed-tests columns ARE the fold's own arithmetic
    // (decided records only; qcStatuses' Fail count), never a re-derivation.
    rows: (state, w) => {
      const batchOf = (id: string) => state.batches?.find((b) => b.id === id)
      const itemName = (id: string) => state.items?.find((i) => i.id === id)?.name || id
      return (state.qcs ?? [])
        .filter((q) => inWindow(batchOf(q.batchId)?.date, w))
        .sort(
          (a, b) =>
            (batchOf(b.batchId)?.date || '').localeCompare(batchOf(a.batchId)?.date || '') ||
            a.id.localeCompare(b.id),
        )
        .map((q) => {
          const made = batchOf(q.batchId)?.date
          const reviewed = q.reviewedAt ? q.reviewedAt.slice(0, 10) : ''
          const decided = q.disposition === 'Released' || q.disposition === 'Rejected'
          return {
            record: q.id,
            batch: q.batchId,
            product: itemName(q.item || ''),
            disposition: q.disposition,
            failed: Object.values(qcStatuses(q)).filter((s) => s === 'Fail').length,
            reviewedBy: q.reviewedBy,
            reviewedAt: reviewed,
            turnaround: decided && made && reviewed
              ? Math.max(0, Math.floor((Date.parse(reviewed) - Date.parse(made)) / 86_400_000))
              : null,
          }
        })
    },
    columns: [
      { header: 'Record', value: (r) => r.record },
      { header: 'Batch', value: (r) => r.batch },
      { header: 'Product', value: (r) => r.product },
      { header: 'Disposition', value: (r) => r.disposition },
      { header: 'Failed tests', value: (r) => r.failed },
      { header: 'Reviewed by', value: (r) => r.reviewedBy },
      { header: 'Reviewed at', value: (r) => r.reviewedAt || '—' },
      { header: 'Turnaround (days)', value: (r) => r.turnaround ?? '—' },
    ],
  }),
  'control-samples': spec({
    key: 'control-samples',
    title: 'Control sample register',
    pages: ['live-reports', 'control-samples'],
    collections: ['packingRuns', 'products', 'items'],
    // The register's own rows (controlSampleRows — newest run first, the
    // tracking sheet's own order), windowed by the day the run filled them —
    // the fold's product-mix rule. Status is sampleStatus' own word.
    rows: (state, w, today) =>
      controlSampleRows(state as AppState, today)
        .filter((r) => inWindow(r.producedOn, w))
        .map((r) => ({
          run: r.run.id,
          batch: r.run.batchId,
          product: r.product,
          bottles: r.sample.count,
          producedOn: r.producedOn,
          collectedBy: r.sample.collectedBy || '',
          expiresOn: r.sample.expiresOn || '',
          status: r.status,
          destroyedOn: r.sample.destroyedOn || '',
          remark: r.sample.remark || '',
        })),
    columns: [
      { header: 'Run', value: (r) => r.run },
      { header: 'Batch', value: (r) => r.batch },
      { header: 'Product', value: (r) => r.product },
      { header: 'Bottles', value: (r) => r.bottles },
      { header: 'Produced on', value: (r) => r.producedOn },
      { header: 'Collected by', value: (r) => r.collectedBy || '—' },
      { header: 'Expires on', value: (r) => r.expiresOn || '—' },
      { header: 'Status', value: (r) => r.status },
      { header: 'Destroyed on', value: (r) => r.destroyedOn || '—' },
      { header: 'Remark', value: (r) => r.remark || '—' },
    ],
  }),
  // ── P5 module registers (D4b): the Inventory/Storage and Packaging
  // Materials dashboards' Export rows fold these — the stock position is the
  // Inventory page's own rows (stockRows), the PM flows are the classic PM
  // report's own engine (itemFlows), so the file and the chart cannot
  // disagree.
  'stock-position': spec({
    key: 'stock-position',
    title: 'Stock position register',
    pages: ['live-reports', 'inventory'],
    collections: ['ledger', 'items', 'storageLocations'],
    // A POSITION: the fold's every cut is unwindowed (D4a), so the register's
    // rows are too — a balance is not an event, and the header's Position line
    // names the day. Sorted as the FG report sorts: area, item, lot, expiry.
    position: true,
    rows: (state, _w, today) => {
      const s = state as AppState
      const name = (id: string) => s.items.find((i) => i.id === id)?.name || id
      return stockRows(s)
        .sort(
          (a, b) =>
            locationLabel(s, a.location).localeCompare(locationLabel(s, b.location)) ||
            name(a.item).localeCompare(name(b.item)) ||
            a.lot.localeCompare(b.lot) ||
            (a.expiry || '').localeCompare(b.expiry || ''),
        )
        .map((r) => ({
          item: name(r.item),
          type: itemTypeLabel(r.itemType),
          lot: r.lot,
          location: locationLabel(s, r.location),
          status: r.status,
          qty: r.qty,
          uom: r.uom,
          value: r.value,
          expiry: r.expiry || '',
          days: r.expiry ? daysBetween(today, r.expiry) : null,
        }))
    },
    columns: [
      { header: 'Item', value: (r) => r.item },
      { header: 'Type', value: (r) => r.type },
      { header: 'Lot', value: (r) => r.lot },
      { header: 'Location', value: (r) => r.location },
      { header: 'Status', value: (r) => r.status },
      { header: 'Qty', value: (r) => num(r.qty, 3) },
      { header: 'Unit', value: (r) => r.uom },
      { header: 'Value', value: (r) => num(r.value, 2) },
      { header: 'Expiry', value: (r) => r.expiry || '—' },
      { header: 'Days to expiry', value: (r) => r.days ?? '—' },
    ],
  }),
  'pm-flows': spec({
    key: 'pm-flows',
    title: 'Packing material flows',
    pages: ['live-reports', 'packing-materials'],
    collections: ['ledger', 'items'],
    // The classic PM report's own engine over the caller's window: opening →
    // received → issued → closing, closing below reorder flagged by the
    // report's own rule (items.reorder > 0).
    rows: (state, w) =>
      itemFlows(state as AppState, w, ['Packing Material']).map((r) => ({
        material: r.name,
        uom: r.uom,
        opening: r.opening,
        received: r.received,
        issued: r.issued,
        closing: r.closing,
        value: r.closingValue,
        reorder: r.reorder,
        below: r.belowReorder,
      })),
    columns: [
      { header: 'Material', value: (r) => r.material },
      { header: 'Unit', value: (r) => r.uom },
      { header: 'Opening', value: (r) => num(r.opening, 3) },
      { header: 'Received', value: (r) => num(r.received, 3) },
      { header: 'Issued', value: (r) => num(r.issued, 3) },
      { header: 'Closing', value: (r) => num(r.closing, 3) },
      { header: 'Closing value', value: (r) => num(r.value, 2) },
      { header: 'Reorder level', value: (r) => r.reorder ?? '—' },
      { header: 'Below reorder', value: (r) => (r.below ? 'Yes' : '—') },
    ],
  }),
  // ── P5 module registers (D5b): the Orders & Dispatch and Shipment Tracking
  // dashboards' Export rows fold these — windowed exactly as their KPI folds
  // window (dispatch lines by dispatch day; challans by their TRIP's created
  // day, the module's one rule), so the file and the chart cannot disagree.
  'dispatch-lines': spec({
    key: 'dispatch-lines',
    title: 'Dispatch line register',
    pages: ['live-reports', 'dispatch'],
    collections: ['dispatches', 'products'],
    // The fold's own window rule: a dispatch line rides its dispatch day. The
    // product name reads the product master (a name lookup, never a decision);
    // POD/delivered-at print what the dispatch row itself carries.
    rows: (state, w) => {
      const productName = (id: string): string => state.products?.find((p) => p.id === id)?.name || id
      return (state.dispatches ?? [])
        .filter((d) => inWindow(localDay(d.dispatchTime), w))
        .sort((a, b) => b.dispatchTime.localeCompare(a.dispatchTime) || a.id.localeCompare(b.id))
        .map((d) => ({
          challan: d.challan,
          day: localDay(d.dispatchTime),
          order: d.orderId || '',
          customer: d.customerName,
          product: productName(d.sku),
          qty: d.qty,
          vehicle: d.vehicle,
          status: d.status,
          pod: d.pod,
          deliveredAt: d.deliveredTime ? localDay(d.deliveredTime) : '',
          note: d.deliveryNote || '',
        }))
    },
    columns: [
      { header: 'Challan', value: (r) => r.challan },
      { header: 'Dispatched on', value: (r) => r.day },
      { header: 'Order', value: (r) => r.order || '—' },
      { header: 'Customer', value: (r) => r.customer },
      { header: 'Product', value: (r) => r.product },
      { header: 'Qty', value: (r) => r.qty },
      { header: 'Vehicle', value: (r) => r.vehicle },
      { header: 'Status', value: (r) => r.status },
      { header: 'POD', value: (r) => r.pod || '—' },
      { header: 'Delivered on', value: (r) => r.deliveredAt || '—' },
      { header: 'Note', value: (r) => r.note || '—' },
    ],
  }),
  challans: spec({
    key: 'challans',
    title: 'Challan register',
    pages: ['live-reports', 'shipments'],
    collections: ['challans', 'shipments'],
    // The module's one window rule (D5a): everything rides the trip's created
    // day — a challan windows with the trip that submitted it, exactly as the
    // fold counts. Status is the challan machine's own word; a superseded
    // correction names the number it replaced and why.
    rows: (state, w) => {
      const s = docsState(state)
      const createdById = new Map((s.shipments ?? []).map((t) => [t.id, localDay(t.times.created)] as const))
      const numberById = new Map((s.challans ?? []).map((c) => [c.id, c.number] as const))
      return (s.challans ?? [])
        .filter((c) => {
          const day = createdById.get(c.shipmentId)
          return day !== undefined && inWindow(day, w)
        })
        .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt) || a.number.localeCompare(b.number))
        .map((c) => ({
          number: c.number,
          status: c.status,
          trip: c.shipmentId,
          order: c.orderId,
          agent: c.agentId,
          vehicle: c.vehicle,
          deliveredAt: localDay(c.deliveredAt),
          lines: c.lines.map((l) => `${l.skuName} · ${l.qty} ${l.uom} · ${l.packaging}`).join('; '),
          version: c.version,
          supersedes: c.supersedesId ? (numberById.get(c.supersedesId) ?? c.supersedesId) : '',
          reason: c.reason || '',
        }))
    },
    columns: [
      { header: 'Challan', value: (r) => r.number },
      { header: 'Status', value: (r) => r.status },
      { header: 'Trip', value: (r) => r.trip },
      { header: 'Order', value: (r) => r.order },
      { header: 'Agent', value: (r) => r.agent },
      { header: 'Vehicle', value: (r) => r.vehicle },
      { header: 'Delivered on', value: (r) => r.deliveredAt },
      { header: 'Lines', value: (r) => r.lines },
      { header: 'Version', value: (r) => r.version },
      { header: 'Supersedes', value: (r) => r.supersedes || '—' },
      { header: 'Correction reason', value: (r) => r.reason || '—' },
    ],
  }),
} satisfies Record<string, RegisteredExportSpec>

export type ExportReport = keyof typeof EXPORT_SPECS
export const EXPORT_REPORTS_LIST = Object.keys(EXPORT_SPECS) as ExportReport[]
export const exportSpec = (key: string): RegisteredExportSpec | undefined =>
  (EXPORT_SPECS as Record<string, RegisteredExportSpec>)[key]
