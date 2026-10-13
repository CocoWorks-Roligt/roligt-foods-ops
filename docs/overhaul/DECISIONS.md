# DECISIONS.md — assumptions register, dependency log, blocked list
Verdicts from audit slice 2 (2026-10-13). RULE: ASSUMED/PARTIAL items are built as CONFIGURABLE values (meta.app_config or new config rows), never hard-coded; surfaced in Phase 1 summary. Tax/compliance fields need business/accountant validation before relied upon.

## Assumptions Register
| # | item | verdict | evidence / default to build (configurable) |
|---|---|---|---|
| 1 | Grading scale | EXISTS-IN-APP | A/B/C+reject+free, Piece-uom only (`lib/grn.ts`); keep, add config for scale labels |
| 2 | Mass-balance tolerance | PARTIAL | yieldTolerance/pmTolerance are variance-vs-history alerts only; ADD mass-balance tolerance, ASSUMED default 2%, per-material override; unit conversions (avg nut weight ASSUMED ~500 g configurable; density ASSUMED ~1.0 kg/L configurable). AUDIT 2026-10-13 (`scripts/overhaul/mass-balance-audit.ts`, prod dump 10-12): 3/14 historical batches pass at 2% — every Extraction fails at 35–54% (unweighed husk/shell; two blends 17–23%). DECISION OPEN before batch_v2 enforcement: (a) recorded unaccounted-loss/by-product line at close, (b) per-material tolerance, or (c) warn-first mode. Not a data problem: real coconut mass splits ~1/3 water. |
| 3 | Spoilage reason codes | MISSING | per-stage editable reference data; ASSUMED defaults — extraction: rotten, cracked, overripe, pulp loss; blend/fill: spillage, burst pouch, line loss; any: QC reject |
| 4 | Malai storage | PARTIAL | all bulk → one Cold Room type today; ASSUMED malai = chilled (not frozen); storage-condition field added to material master |
| 5 | QC-at-receipt | MISSING | ASSUMED default OFF (receipts post Available as today); per-material flag to route receipt lots to Quarantine |
| 6 | Control-sample stock deduction | EXISTS-IN-APP | samples draw bulk+PM cost today (absorbed, never stock) — matches §3 default "yes, via explicit movement": ADD explicit sample ledger movement for visibility |
| 7 | Cold-chain limits | MISSING | ASSUMED alert at 30 min out-of-cold (configurable), loading timestamp recorded |
| 8 | FEFO rules | PARTIAL | pick lists FEFO-sorted + allocations seeded; make enforced + configurable (strict/relaxed) |
| 9 | QC spec limits | PARTIAL | TestParameter has method/unit only, results Pass/Fail strings; ADD numeric min/target/max per parameter (enables control charts); ASSUMED initial limits empty until lab supplies |
| 10 | Challan numbering | EXISTS-IN-APP | DC series configurable (`lib/numbering.ts`); ADD challan document (PDF, immutable, versioned, FY prefix option ASSUMED FY-Apr–Mar India) |
| 11 | Tax / e-way fields | MISSING | Customer.gst exists; challan gets configurable tax fields (GSTIN, HSN, tax rate) — FLAG: business/accountant must validate before production use |
| 12 | OTP at delivery | MISSING | ASSUMED optional, default OFF, flag per customer |
| 13 | procurement_form tri-state | PARTIAL | Item.directUse bool ≈ DIRECT_USE; extend to RAW/READY_EXTRACT/DIRECT_USE + shelf life, storage condition, min/max |
| 14 | Pouch→carton config | MISSING | ASSUMED defaults per BIB size (1L/2.5L/5L → carton type + pouches/carton) entered as editable reference data at rollout |
| 15 | Partial dispatch | MISSING (blocked by design today) | overhaul adds partial + packaging decision per line |

## Dependency log (one line each; UI deps pre-approved, guardrails: ONE component lib + ONE chart lib, permissive license, no framework migration)
- (Phase 2 SHELL will append: component library, chart library, signature-capture, etc.)

## LEAD review 2026-10-13 (decisions + open items from the B1–B3 review)
- Contracts v1.1 recorded (challan on DispatchConfirmResponse; melanges.recipeId; avgUnitWeight is the as-built name). SHELL consumes v1.1.
- can.release_lot: enforcement seam shipped (qc_gate_v2 release arm, `gateQcReleases`/`mayReleaseLot`). PROXY: page.quality stands in for the can.release_lot slug until role seeding issues action slugs — a Manager ticking the QC page carries the release write. Ship can.* slugs (seed-rbac + sessionPermissions) with B4/SHELL.
- delivery_agent default-deny: REQUIRED before the PWA ships — external users must hold an explicit role; zero slugs on an external account must NOT fall back to the Operator open tier (today it would — RBAC model note).
- Snapshot projection is a WITHHOLD list, not an allowlist: collections with writePermission but no page (items, melanges, vendors, products, …) are readable by any signed-in caller, so a delivery agent would still read masters. The agent projection must invert to an allowlist (shipments slice only) before page.my-deliveries goes live.
- /api/search as built (B3): delivery_agent → 403 (no own-id search); RBAC.md row corrected to match.
- Procurement KPIs kept; `purchase_orders` entity + PO form are REQUIRED — PO form added to the WORKFLOW stage-form list (Receipt stage). No PO form, no funnel/on-time/lead-time/calendar numbers.
- Manager role: page ticks carry WRITES (not read-only) — disclosed in RBAC.md; if business wants managers read-only, that is a role-seed decision at B4.
- Zoho/flags: verified structurally safe (gated endpoints 503 without D1 env; flags collection exists only in D1). Operational rule in STATE.md invariants until engine deletion (2026-10-19).
- Rollback gap: backfill has no reverse script. Before any apply: scratch apply + `D1_SMOKE=1 npm test` first; prod apply (user-only) takes a D1 Time Travel bookmark or export beforehand. Still deferred — LEAD does the scratch apply before flags go on.

## Blocked
- batch_v2 enablement — blocked on the DECISIONS #2 mass-balance resolution (3/14 pass; extractions cannot close under enforcement).
- can.* action slugs not yet issued by any role seed (release arm runs on the page.quality proxy).

## B4 decisions (2026-10-13, BACKEND)
- ASSUMED → configurable: `kpiStaleAfterSec` in meta app_config (default 300 s) drives Freshness.stale_after/stale on /api/kpis; SSE params (poll 5 s, heartbeat 15 s, stream life 4 min < the 300 s function cap) are code constants, not config — surface in DECISIONS if the plant wants them tunable.
- Module key on the wire is `shipment-tracking` (contracts KPI_MODULES); KPI.md's header line said `shipments` — KPI.md corrected to the contract key.
- KPI gate = hold ANY of the module's page slugs (RBAC.md §c "module's page slug OR page.dashboards" — page.dashboards does not exist yet; revisit in P5 if dashboards get their own page). Delivery agents: 403 on all modules.
- Read withholding honored per-collection: a collection the caller's snapshot withholds is folded without (e.g. qc with page.quality only → no batch dates → windowed counts read 0), mirroring /api/search.
- Fulfilment % (orders-dispatch skeleton) = window-dispatched qty ÷ window-ordered qty (KPI.md formula); per-order-line fulfilment refinement lands with the module's full build (P5).
- Meta cache rows `kpi:<module>` never bump app_revision (cache, not document) — first cached module: shipment-tracking (empty fold until SHIPMENT P4); heavy-fold users arrive in P5.
- qc fold delegates to qualityReport (widened to Pick<AppState,'qcs'|'batches'|'items'>) — dashboards/reports cannot diverge; orders-dispatch fold is own-math (dispatchRows' per-cell grouping is heavier than the module needs).
- SSE delivery-agent scoping to own shipments deferred to SHIPMENT (P4) — the revision token itself leaks nothing (RBAC'd reads happen on refetch).
