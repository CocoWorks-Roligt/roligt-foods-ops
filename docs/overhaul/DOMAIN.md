# DOMAIN.md — current-state domain map (audit) + overhaul targets
Repo: React 19 SPA + Vercel BFF; D1 document-store (26 wire collections, `src/lib/tables.ts`); ALL business rules client-side (`src/lib/posting.ts`, `src/context/domains/*`). Ledger is the single stock truth (append-only movements; every balance folds from it).

## Current flow per domain → overhaul §3 target
| domain | today (files) | gap vs §3 |
|---|---|---|
| Receipt produce | GRN form posts grades+rate+transport, mints LOT-YYYYMMDD-NN, 1 ledger 'Receipt' line (Available), no inspection (`Procurement.tsx`, `lib/grn.ts`) | no PO, no QC-at-receipt option, no shelf-life/storage-condition on Item |
| Receipt PM / ready-extract | PM tab: 1 'PM Receipt' ledger line, no doc; non-graded produce = whole load grade A | no procurement_form tri-state (only Item.directUse bool ≈ DIRECT_USE) |
| Grading | A/B/C+reject+free inside GRN form, Piece-uom only, hard-coded scale, one lot carries all grades | no grade-level lot split, scale not configurable |
| Extraction | Batch kind Extraction: multi-lot sourceLines at stock cost → multi outputLines (MAIN 100% costShare, by-product 0%), outputs Semi Finished into Quarantine (Released if qcExempt), stockId BAT-…/n (`ExtractionBatches.tsx`, `lib/posting.ts`) | no recipe target, no unit-aware mass balance (mixed units summed raw), no output typing (MAIN/CO/BY/INTERMEDIATE) |
| Spoilage | one number per batch (Batch.spoiled) + derived wastage value; NOT mandatory for melange; no codes/photo | §3.2 mandatory record + per-stage editable reason codes + photo |
| Intermediates | malai = by-product lot (costShare 0) — first-class stock; coconut milk expressible as Melange run (blendLines draw malai+water+direct-use) | recipes are unversioned shares; no INTERMEDIATE typing; anti-double-consumption works (lots consumed once) but nothing server-enforced |
| Blending | Batch kind Melange; guards client-side: no raw non-directUse, all named components, output ≠ component | Quarantine blendable (inconsistent with packing's Released-only); no server enforcement |
| Packing | packing_run: batch+bulkItem → pack lines (SKU+count), bulk drawn, PM per BOM, FG inherits bulk QC verdict; PACK_TYPES free text ('BiB','Glass Bottle') (`Packing.tsx`, `lib/posting.ts`) | no loose-vs-boxed, no carton logic; 1L/2.5L/5L are SKUs (no format flag) |
| Cartons | PM item with single reorder level only | §3.3-9 carton engine absent: no min/max, pouch→carton config, dispatch deduction, reconciliation |
| Storage | StorageLocation types Cold Room/Dry/Hold/NPD; rules: bulk never dry, Hold=Rejected only, NPD pairing; moves + Send-to-NPD (`Storage.tsx`, `lib/stock.ts`) | no ambient/frozen split, bins, capacity, cold-chain timers |
| QC | per-output QcRecord; dispositions Pending/Retest/Rejected/Released; batch roll-up; tests configurable categories | no Rework, no numeric spec limits (→no control charts), enforcement client-only |
| Control samples | captured in packing modal; draw bulk+PM cost (absorbed), never stock; register tracks retention/destroy (`ControlSamples.tsx`) | no storage bin, no parent-batch link beyond run, no post-run add (deduction EXISTS = matches §3 default) |
| Orders | Order lines sku+qty; raised only when stock exists; dispatch = all-or-nothing on one challan number; FEFO-seeded allocations (`Orders.tsx`, `lib/ordersView.ts`) | no packaging preference (BOXED/LOOSE/ASK), no partial shipment, no reservations |
| Dispatch | dispatches row per sku/batch line: challan string (DC series, `lib/numbering.ts`), vehicle free text, status manual, PoD typed name + photos R2, times | no shipment entity/trip view, no agent, no GPS, no signature canvas, no challan PDF/immutability, no tax fields |
| Returns | status dropdown offers Returned/Partially Delivered/Failed but no Return record, no stock effect, no QC decision | §3.10 returns absent |
| Traceability | farmer↔customer d3-force graph from ledger (`Traceability.tsx`) | genealogy works client-side; no server genealogy endpoint |
| Reports | Lab Reports (documents) + Live Reports (derived, `src/lib/reports/*` 7 modules) | no export engine (CSV/XLSX/PDF) with injection guards, no last_updated/stale, no server aggregation |

## Entity/status vocabulary today (stored keys → label)
- Ledger status: Available, Quarantine, Released, Rejected, Pending(→"Awaiting QC"), NPD.
- Batch status: Released / Partly Released (+ derived Rejected/On Hold roll-up).
- Order: Open / Dispatched / Cancelled. Dispatch: Dispatched / In Transit / Delivered / Partially Delivered / Returned / Failed.
- QC disposition: Pending / Retest / Rejected / Released. No Rework.
- Item types: Raw / Packing / Semi Finished / Finished. Melange = blend recipe (outputItem + component shares).

## Overhaul target model (from OVERHAUL_PROMPT §3, to be detailed by ARCHITECT in ARCHITECTURE.md)
- procurement_form RAW|READY_EXTRACT|DIRECT_USE; requires_grading (coconuts only); requires_extraction; shelf life; storage condition ambient/cold/frozen; density or avg-unit-weight; min/max.
- transformation + transformation_input/output + spoilage as concrete records; versioned recipe templates; output typing MAIN/CO_PRODUCT/BY_PRODUCT/INTERMEDIATE; unit-aware mass balance in base units; mandatory spoilage (explicit zero ok).
- Server-enforced QC release gate (Hold/Passed/Failed/Rework); zones Ambient/Cold Room/Quarantine/Dispatch Staging.
- Dispatch packaging decision (BOXED/LOOSE/ASK + pouch→carton config, atomic deduction, cold-chain out-time); shipments, delivery events, signatures, versioned challans, returns.
