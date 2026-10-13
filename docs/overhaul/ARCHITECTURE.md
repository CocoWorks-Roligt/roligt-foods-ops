# ARCHITECTURE.md — Phase 1 (LEAD+ARCHITECT, 2026-10-13)
Base: audit in AUDIT.md/DOMAIN.md. Strategy: ADDITIVE on the document store + isomorphic shared rules; no framework change, no data renames; every behavior change behind a feature flag with Classic view. "Tables" below = wire collections (documents) unless prefixed SQL (no physical schema change needed beyond existing documents/meta/counters).

## 1. Information architecture
Sidebar in PROCESS order (flag `shell_nav`; Classic keeps today's groups). Item — badge source (live via /api/events + snapshot):
1. Home (role landing) · holds+aging count
2. Procurement · PM below-min
3. Grading · RAW lots awaiting grading (staged mode only)
4. Extraction · runs in progress
5. Blending · blends awaiting QC
6. Packing · runs pending
7. Quality · pending QC ("QC: 7")
8. Control Samples · expiring ≤7d
9. Inventory · reorder alerts
10. Packing Materials · below min
11. Orders · open orders
12. Dispatch · staged/awaiting
13. Shipment Tracking · out for delivery ("Out for delivery: 4")
14. NPD · Stickers · Planning (Roster, Production Planning)
15. Records: Traceability · Reports · Dashboards · Audit
16. Masters · Settings · Administration (unchanged)
Role landings: Procurement officer→Procurement; Production operator→Extraction; Packing→Packing; QC analyst→Quality; Store/Dispatch→Dispatch; Delivery agent→My Deliveries (PWA); Manager/Admin→Home. Global search Ctrl/Cmd+K → GET /api/search?q= over lot, batch/run, order, challan, customer, vendor, storage location, shipment.

## 2. Data model deltas (additive; backfills one-off, tested, additive-only)
| collection | delta |
|---|---|
| items | +procurement_form RAW\|READY_EXTRACT\|DIRECT_USE (backfill: directUse→DIRECT_USE; type Raw→RAW; else READY_EXTRACT), +requires_grading, +requires_extraction, +shelf_life_days, +storage_condition ambient\|cold\|frozen, +density_kg_per_l, +avg_unit_weight (count items), +min_stock/+max_stock (keep reorder) |
| grns | +grading_mode embedded (today, default) \| staged (pipeline flag); staged → grades entered later via grading form |
| batches | +recipeId/+recipeVersion, outputLines[] +type MAIN\|CO_PRODUCT\|BY_PRODUCT\|INTERMEDIATE (backfill: Extraction first output→MAIN, rest→BY_PRODUCT; Melange→INTERMEDIATE), +stageTimes{started,inputsDone,outputsDone,closed} |
| NEW spoilage_records | {id, batchId, stage extraction\|blend\|fill, qty, uom, reasonCode, photoKey?, at, actor} — MANDATORY ≥1 per batch close (explicit zero = qty 0) |
| NEW spoilage_reasons | {stage, code, label, active} seeded from DECISIONS #3 (editable reference data) |
| melanges | +recipeId, +version, +status draft\|active\|retired; edits create new version row, old kept (versioned plain-data template; no DSL) |
| products | +packFormat glass\|bib, +bibSize (1\|2.5\|5 L) backfilled from SKU names |
| NEW carton_specs | {bibSize→cartonItemId, pouchesPerCarton, active} seeded DECISIONS #14 |
| customers | +dispatchPackaging BOXED\|LOOSE\|ASK (default ASK) |
| orders | lines[] +packaging override; +status Partially Dispatched (new legal value); +reservations[] (allocated lots per line, CAS-protected) |
| NEW shipments | {id, orderId, dispatchIds[], agentUserId?, vehicle, status, eta, stops[], times{created,dispatched,outForDelivery,delivered}, packaging mode roll-up} |
| NEW delivery_events | {id, shipmentId, type started\|arrived\|line_confirm\|signature\|otp\|failed\|rescheduled, at, gps?, payload} (append-only) |
| shipment signature | stored on shipment: {signatureKey (R2 png), printedName, phone, otpVerified?} |
| NEW challans | {id, number (series, FY prefix opt.), shipmentId, orderId, version, supersedesId?, reason?, pdfKey, taxFields{} (GSTIN/HSN/rate — FLAG accountant), lines[] snapshot, agentId, vehicle, deliveredAt} IMMUTABLE: corrections = new linked version |
| NEW returns | {id, shipmentId, lines[{item,lot,qty,reason,photoKey?}], qcDecision coldroom\|quarantine\|writeoff, decidedBy, ledgerRef} |
| qcs | results{} values +numeric {value,min,target,max}; disposition +REWORK |
| NEW flags | {key, enabled, note, updatedBy, updatedAt} — shell_nav, pipeline, batch_v2, qc_gate_v2, dispatch_v2, shipments, dashboards_* |
| meta.app_config | +massBalanceTolerancePct (2), +avgNutWeightG (500), +defaultDensityKgPerL (1.0), +coldChainTimeoutMin (30), +fefoMode strict\|relaxed, +qcAtReceiptDefault false, +otpAtDelivery false, +challanFyPrefix false |
| storage_locations | +zone ambient\|cold_room\|quarantine\|dispatch_staging (map: Cold Room→cold_room, Dry→ambient, Hold→quarantine, +new dispatch_staging, NPD stays tag) |
| RBAC | +action permissions `can.<action>` alongside page slugs (see RBAC.md); NEW roles delivery_agent etc. |
| NEW purchase_orders | {id, number, vendorId, lines[{item,qty,uom,rate}], status draft→sent→acknowledged→received→closed\|cancelled, expectedOn, receivedGrnIds[]} — PO funnel/lead-time/on-time KPIs (added per KPI.md review) |
| packing_runs | +shiftId; controlSamples[] +storageBin (KPI.md review) |
| storage_locations | +capacity? (occupancy KPI; KPI.md review) |

## 3. State machines (server-enforced via shared rules; roles per RBAC.md)
```mermaid
lot:      Receipt→Quarantine──pass──>Released──┐
              ││└──fail──>Rejected→writeoff    ├─>consumed(blend/pack) or dispatched
              │└──rework──>Quarantine(retest)  ┘
run:      Draft→InProgress→AwaitingQC→Closed(spoilage≥1, mass-balance ok)
order:    Open→PartiallyDispatched→Dispatched | Cancelled
shipment: Created→Dispatched→OutForDelivery→Delivered|PartiallyDelivered|Returned|Failed→(Failed→Rescheduled→OutForDelivery)
challan:  Issued→(correction)→Superseded(new version)
return:   Open→QcDecision→Closed(ledger posted)
```
Transition tables (entity.from→to | guard | roles): kept in RBAC.md matrix + encoded in src/lib/contracts.ts `LEGAL_TRANSITIONS`. Key guards: consume/dispatch require lot Released (qc_gate_v2 flag; today Quarantine blendable — Classic keeps old rule); run close requires spoilage record + |mass-balance variance| ≤ tolerance (base-unit conversion via items.avg_unit_weight/density); dispatch confirm = atomic carton+pouch decrement (BOXED) / pouch-only (LOOSE); challan create immutable + sequential (counters, Idempotency-Key).

## 4. Genealogy
GET /api/genealogy?seed=LOT:xxx|RUN:xxx|ORD:xxx&dir=forward|backward&depth=N. Server BFS over edges folded from documents: receipt(grn)→run inputs/outputs (batches.sourceLines/blendLines/outputLines)→packing_runs (bulk→pack lots)→orders/dispatches→shipments→challans. Returns {nodes[], edges[], truncated}. Same module feeds Traceability graph (replace client fold; keep d3 rendering).

## 5. Enforcement, concurrency, idempotency, sync answer
- ONE isomorphic rules module `src/lib/rules.ts` (+ `rules/` per domain): pure functions over documents. Client calls for instant pre-checks; api/commit + dedicated endpoints call the SAME functions as authority (audit notes verdict). No more client-only gates.
- CAS: documents.version already exists; commits carry expected version (optimistic lock; conflict → 409 + client re-sync).
- Idempotency: dedicated POST endpoints (below) require Idempotency-Key header; api/_lib dedupe by hash(key+body) stored 48h.
- Dual-write risk: new entities (shipments, challans, returns, spoilage_records, carton_specs, flags) are server-endpoint-only (NOT client-changeset tables) → no divergence. Existing tables keep changeset path but gain server rule re-check.
- Heavy ops as dedicated endpoints (all Idempotency-Key, audit): POST /api/transformations/close, /api/dispatch/confirm (carton math + FEFO + reservations), /api/shipments (+/:id/events, /:id/submit → signature + challan + PDF), /api/returns, /api/grading (staged mode).
- Freshness: GET /api/events (SSE, revision-keyed; poll fallback = existing /api/revision); every dashboard/report payload carries last_updated + stale_after.

## 6. Aggregation layer (single source for dashboards/reports/exports)
GET /api/kpis/:module — server folds documents per module (src/lib/kpis/ shared, memoized by revision; heavy ones cached in meta with computed_at). Dashboards, live reports, CSV/XLSX/PDF exports ALL read /api/kpis + /api/exports/:report (stream small; background job + status + notification for large; injection-guarded). Numbers match by construction.

## 7. Flags & rollback (per phase)
shell_nav (P2) → pipeline+batch_v2+qc_gate_v2 (P3) → shipments+dispatch_v2 (P4) → dashboards_* (P5, per module). Rollback = flag off (server endpoints stay, inert); data written by new flow is additive and readable by Classic where sensible. Hard-stop approval reserved for: any prod DB write, destructive migration (none planned).

## 8. Frozen contracts
`src/lib/contracts.ts` — ALL new entities, statuses, transitions, request/response types for endpoints above, consumed unchanged by BACKEND and SHELL. Changes after freeze require LEAD approval + minor version bump. KPI definitions → KPI.md; permissions → RBAC.md.
- v1.2 (2026-10-13, B4): +RevisionEvent — the GET /api/events SSE message (hello/revision/bye; heartbeat comments; poll fallback /api/revision).
- v1.1 (2026-10-13, LEAD): additive deltas from B1/B3 as-built — MelangeExtension +`recipeId?`; DispatchConfirmResponse +`challan?`; naming record: `ItemExtension.avgUnitWeight` is as-built for the count→kg conversion. SHELL builds against v1.1.
