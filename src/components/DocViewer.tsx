import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { DetailView, type DetailSection } from './DetailView'
import { DocLink } from './DocLink'
import { labReportSection } from './labReportSection'
import { StatusBadge } from './StatusBadge'
import { DocViewerContext } from './docViewerContext'
import { useApp } from '../context/AppContext'
import { batchInputQty, batchLabel, batchOutputs, fmtBulk } from '../lib/batches'
import { categoryTitle, qcAttachments } from '../lib/qcCategories'
import { docRef } from '../lib/links'
import { itemName } from '../lib/stock'
import { scoreSensory } from '../lib/sensory'
import { fmtDate, fmtQty, inr } from '../lib/utils'
import type { AppState } from '../types'

/**
 * Follows a record number without going anywhere.
 *
 * A DocLink used to route you to the record's own page with its View dialog up — the
 * comment there called it "a record number you can follow", but following it cost you
 * the page you were on: search, filters and scroll are all component state, and the
 * route change threw them away. Clicking a batch number on a QC card to check one
 * thing and coming back to nothing was the cost of every link on every page.
 *
 * So a linked record now opens in a dialog where you stand. The essentials, the lab
 * reports, and everything DetailView already derives from the record number — what it
 * came from, what it went into, its history — travel with it. The record's own page
 * keeps the fuller View for when you went there on purpose; a stock item still routes
 * to Traceability, because what it opens is a search, not a record.
 */

/** What a record number shows in the viewer dialog. */
function docSections(state: AppState, id: string): { title: string; sections: DetailSection[] } | null {
  const ref = docRef(state, id)
  if (!ref) return null

  switch (ref.kind) {
    case 'grn': {
      const g = state.grns.find((x) => x.id === ref.id)
      if (!g) return null
      return {
        title: `Goods receipt · ${g.id}`,
        sections: [
          {
            title: 'Receipt',
            fields: [
              { label: 'Receipt', value: g.id },
              { label: 'Lot', value: g.lot },
              { label: 'Received', value: fmtDate(g.date) },
              { label: 'Product', value: `${g.productName || itemName(state, g.itemId || '')} · ${g.uom || 'Piece'}` },
              { label: 'Source', value: [g.farmerName || g.farmer, g.area].filter(Boolean).join(' · ') || '—' },
              { label: 'Quantity', value: `${fmtQty(g.total)} received · ${fmtQty(g.accepted)} accepted${g.free ? ` · ${fmtQty(g.free)} free` : ''}` },
              { label: 'Landed cost', value: `${inr(g.landed)} (${inr(g.usableCost)} / usable ${g.uom || 'piece'})` },
              { label: 'Status', value: <StatusBadge value={g.status} /> },
            ],
          },
        ],
      }
    }
    case 'batch':
    case 'melange': {
      const b = state.batches.find((x) => x.id === ref.id)
      if (!b) return null
      const reports = labReportSection(state, b.id)
      return {
        title: `${ref.kind === 'melange' ? 'Melange run' : 'Production batch'} · ${b.id}`,
        sections: [
          {
            title: ref.kind === 'melange' ? 'Melange run' : 'Batch',
            fields: [
              { label: 'Run' , value: b.id },
              { label: ref.kind === 'melange' ? 'Blended on' : 'Produced on', value: fmtDate(b.date) },
              { label: 'Recipe', value: batchLabel(state, b) },
              { label: 'Status', value: <StatusBadge value={b.status} /> },
              {
                label: 'Issued',
                value: `${fmtBulk(batchInputQty(b), b.inputUom || 'Litre')}`,
              },
              ...batchOutputs(b).map((o) => ({
                label: itemName(state, o.item),
                value: `${fmtBulk(o.qty, o.uom)}${o.costShare > 0 ? '' : ' · by-product'}`,
              })),
              { label: 'Cost / unit', value: inr(b.costPerL) },
              {
                label: 'QC records',
                value: state.qcs
                  .filter((q) => q.batchId === b.id)
                  .map((q) => `${itemName(state, q.item || '')} ${q.disposition}`)
                  .join(' · ') || 'None',
                wide: true,
              },
            ],
          },
          ...(reports ? [reports] : []),
        ],
      }
    }
    case 'qc': {
      const q = state.qcs.find((x) => x.id === ref.id)
      if (!q) return null
      const attachments = qcAttachments(q)
      return {
        title: `QC record · ${q.id}`,
        sections: [
          {
            title: 'QC record',
            fields: [
              { label: 'QC', value: q.id },
              { label: 'Batch', value: <DocLink doc={q.batchId} /> },
              { label: 'Product tested', value: itemName(state, q.item || '') },
              { label: 'Disposition', value: <StatusBadge value={q.disposition} /> },
              { label: 'Reviewed by', value: q.reviewedBy || '—' },
              { label: 'Reviewed at', value: q.reviewedAt ? fmtDate(q.reviewedAt) : '—' },
              { label: 'Reports attached', value: attachments.length ? attachments.map((a) => a.key).join(', ') : 'None' },
            ],
          },
        ],
      }
    }
    case 'packing': {
      const r = state.packingRuns.find((x) => x.id === ref.id)
      if (!r) return null
      return {
        title: `Packing run · ${r.id}`,
        sections: [
          {
            title: 'Packing run',
            fields: [
              { label: 'Run', value: r.id },
              { label: 'Packed on', value: fmtDate(r.date) },
              { label: 'Batch', value: <DocLink doc={r.batchId} /> },
              { label: 'Status', value: <StatusBadge value={r.status} /> },
              ...r.lines.map((l) => ({
                label: itemName(state, l.sku),
                value: `${l.packs} packs`,
              })),
            ],
          },
        ],
      }
    }
    case 'dispatch': {
      const d = state.dispatches.find((x) => x.id === ref.id)
      if (!d) return null
      return {
        title: `Dispatch · ${d.id}`,
        sections: [
          {
            title: 'Dispatch',
            fields: [
              { label: 'Dispatch', value: d.id },
              { label: 'Challan', value: d.challan },
              { label: 'Customer', value: d.customerName },
              { label: 'Dispatched', value: fmtDate(d.dispatchTime) },
              { label: 'Vehicle', value: d.vehicle || '—' },
              { label: 'Quantity', value: `${fmtQty(d.qty)} ${itemName(state, d.sku)} from ${d.batchId}` },
              { label: 'Status', value: <StatusBadge value={d.status} /> },
              { label: 'Received by (POD)', value: d.pod || '—' },
            ],
          },
        ],
      }
    }
    case 'order': {
      const o = state.orders.find((x) => x.id === ref.id)
      if (!o) return null
      return {
        title: `Order · ${o.id}`,
        sections: [
          {
            title: 'Order',
            fields: [
              { label: 'Order', value: o.id },
              { label: 'Customer', value: o.customerName },
              { label: 'Raised', value: fmtDate(o.date) },
              { label: 'Status', value: <StatusBadge value={o.status} /> },
              ...o.lines.map((l) => ({
                label: itemName(state, l.sku),
                value: fmtQty(l.qty),
              })),
            ],
          },
        ],
      }
    }
    case 'issue': {
      const i = (state.stockIssues || []).find((x) => x.id === ref.id)
      if (!i) return null
      return {
        title: `Stock issue · ${i.id}`,
        sections: [
          {
            title: 'Stock issue',
            fields: [
              { label: 'Issue', value: i.id },
              { label: 'Date', value: fmtDate(i.date) },
              { label: 'Reason', value: i.reason },
              { label: 'Issued to', value: i.recipient || '—' },
              ...i.lines.map((l) => ({
                label: itemName(state, l.item),
                value: `${fmtQty(l.qty)} ${l.uom} · ${l.lot}`,
                wide: true,
              })),
            ],
          },
        ],
      }
    }
    case 'material': {
      const l = state.ledger.find((x) => x.type === 'PM Receipt' && x.doc === ref.id)
      if (!l) return null
      return {
        title: `Packing material receipt · ${ref.id}`,
        sections: [
          {
            title: 'Receipt',
            fields: [
              { label: 'Receipt', value: ref.id },
              { label: 'Received', value: fmtDate(l.time) },
              { label: 'Material', value: itemName(state, l.item) },
              { label: 'Supplier lot', value: l.lot },
              { label: 'Supplier', value: state.vendors.find((v) => v.id === l.vendorId)?.name || 'Not recorded' },
              { label: 'Quantity', value: `${fmtQty(l.qtyIn)} ${l.uom} @ ${inr(l.unitCost)}` },
              { label: 'Where', value: l.location },
            ],
          },
        ],
      }
    }
    case 'report': {
      const r = state.labReports.find((x) => x.id === ref.id)
      if (!r) return null
      return {
        title: `Lab report · ${r.id}`,
        sections: [
          {
            title: 'Lab report',
            fields: [
              { label: 'Report', value: r.id },
              { label: 'Type', value: categoryTitle(state, r.category) },
              { label: 'Batch', value: r.batchId ? <DocLink doc={r.batchId} /> : r.batchLotDetails || '—' },
              { label: 'Sample', value: r.sampleName || '—' },
              { label: 'Date', value: fmtDate(r.scores ? r.sampleDate : r.issueDate) },
              ...(r.scores
                ? [
                    {
                      label: 'Decision',
                      value: scoreSensory(r.scores, r).decision,
                    },
                    { label: 'Score', value: `${fmtQty(scoreSensory(r.scores, r).score ?? 0)} / 100` },
                  ]
                : [{ label: 'Issued to', value: r.customerName || '—' }]),
            ],
          },
        ],
      }
    }
    default:
      return null
  }
}

export function DocViewerProvider({ children }: { children: ReactNode }) {
  const { state } = useApp()
  // A stack, not a slot: following a link inside the dialog replaces what it shows,
  // and Escape walks back to the record you were looking at before it.
  const [docs, setDocs] = useState<string[]>([])
  const navigate = useNavigate()
  const docId = docs[docs.length - 1] || null
  const view = docId ? docSections(state, docId) : null

  const openDoc = (id: string) => {
    const ref = docRef(state, id)
    // A stock item opens a trace, not a record — that is a page, and stays one.
    if (ref?.kind === 'stock') {
      navigate(`/traceability?q=${encodeURIComponent(ref.id)}`)
      return
    }
    if (ref) setDocs((d) => [...d, ref.id])
  }

  return (
    <DocViewerContext.Provider value={{ openDoc }}>
      {children}
      <DetailView
        open={!!view}
        title={view?.title || ''}
        sections={view?.sections || []}
        onClose={() => setDocs((d) => d.slice(0, -1))}
        record={docId || undefined}
      />
    </DocViewerContext.Provider>
  )
}
