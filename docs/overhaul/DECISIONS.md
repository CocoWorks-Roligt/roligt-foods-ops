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
| 16 | Pipeline "stuck" threshold | MISSING | ASSUMED a stage row is stuck after 2 days waiting (config `app_config.pipelineStuckDays`, default 2 — src/lib/pipeline.ts); bottleneck notes on Pipeline Home flag stuck/hold/expiry/overdue |

## Dependency log (one line each; UI deps pre-approved, guardrails: ONE component lib + ONE chart lib, permissive license, no framework migration)
- exceljs@4.4.0 (P5 D0): XLSX export renderer, server-side only — SheetJS's npm build is stale/advisory-flagged, exceljs is the maintained MIT option.
- (SHELL 2026-10-13) echarts ^6 (Apache-2.0) — the ONE chart library; only it covers all six wire kinds (line/bar/stacked/treemap/heatmap/control); tree-shaken via src/components/shell/echartsChunk.ts, lazy chunk.
- (SHELL 2026-10-13) NO component library added — the existing hand-rolled set (Modal/Select/dropdown positioning/Toast) IS the one component system; a headless lib would duplicate patterns the codebase already owns and owns well.
- (SHELL 2026-10-13) SignaturePad hand-rolled (pointer events + canvas) — `signature-pad` is unpublished from npm (404), `react-signature-canvas` is alpha on old React peers; ~100 lines beats a bet on a small personal lib.
- (QA 2026-10-14, dev-only) @playwright/test — browser E2E for HEAVY journeys + multi-viewport screenshots + Lighthouse host; the prompt names Playwright first, one runner covers journey/screenshots (Cypress needs its own service), Apache-2.0, never ships to the client bundle.
- (SHELL 2026-10-13) QR/barcode input is scanner-gun-typed text input (ScanInput); camera decode deferred to SHIPMENT PWA where the delivery workflow needs it.

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

## W16 decisions (2026-10-14, WORKFLOW — Onboarding)
- Feedback button ASSUMED → clipboard + local outbox, NO endpoint (STATE's W16 law: no new
  writes). Words are copied ready to paste to an admin; a copy stays on the device
  (roligt_feedback_outbox, last 20). A centralized feedback endpoint is a later decision if
  the plant asks for it — it would need RBAC, audit and a collection.
- Tooltips = native `title` attributes fed from onboarding.ts's PAGE_HELP/STAGE_HELP — one
  wording source for tooltip + cheat sheet, coverage-tested; no tooltip library added (the
  ONE-component-system rule stays clean).
- In-app cheat sheet is the CALLER'S PAGES, not a role name — roles are runtime data
  (pages.ts), so "your role's cheat sheet" is honestly one line per screen the caller
  holds. The prompt's named-role pages live printable in docs/overhaul/cheatsheets/ (8
  roles; delivery-agent marked not-live-until-Phase-4).
- Tour "seen" mark is one device-local key (roligt_tour_done_v1) — first run only, "?" in
  the topbar replays. No server state, no per-account tracking.

## P4 decisions (2026-10-15, SHIPMENT)
- Challan numbering (#10): the counter series KEY is `challan` — the same forward-only belt the
  client's `nextId(draft,'challan')` pre-mints from (default format `{P}{N}/{YYYY}`, 4-digit pad →
  `DC0201/2026`); numbering.ts stays the one definition. Submit ADOPTS the member dispatches'
  shared Classic DC number when exactly one distinct non-empty number exists and no challan doc
  already holds it (two trips off one wave would collide) — mints fresh from the counter otherwise,
  so an adoption never consumes a number and a collision never overwrites.
- Challan tax fields (#11): printed only when `app_config.challanTax` is configured, and ALWAYS
  caveated "Tax details pending accountant sign-off — not valid for filing" (printed on the PDF).
  The business/accountant validation gate stays until they sign off.
- Packaging mode: reads 'LOOSE' until dispatch_v2 stamps real per-line packaging decisions — a
  MIXED roll-up today would lie. Revisit at dispatch_v2.
- Return decision ledger mapping: coldroom → ONE qtyIn line per return line, status Released, at
  the first ACTIVE Cold Room location's NAME (the ledger key); quarantine → Quarantine, writeoff →
  the terminal Written Off balance, both at the Hold Area. Missing location = honest 422
  (`location_missing`), never a silent post. unit_cost/expiry copied off the trip's own type-
  'Dispatch' ledger line when found (match doc ∈ dispatchIds + item + lot), else 0 — the return
  never invents a cost the dispatch did not carry.
- OTP at delivery (#12): presence of `signature.otp` in the submit IS what `otpVerified: true`
  means (server-side verification of a code channel does not exist — nothing to verify against
  yet). The PWA field is folded away and optional; per-customer flagging lands when a channel does.
- 404-never-403 for foreign shipment/challan ids read by agents — an external user must not learn
  that another id exists (RBAC §d).
- Shipment statuses vs PATCH: PATCH owns exactly Created→Dispatched (stamps times.dispatched) and
  Failed→Rescheduled; `started` walks Created→Dispatched→Out for Delivery (agent never stranded)
  and Rescheduled→Out for Delivery; the four outcomes of Out for Delivery are the submit's alone.
- Append-only delivery events (line_confirm/arrived/otp/signature) leave the trip doc's version
  alone — every reader's CAS token stays stable through an agent's round.
- (QA 2026-10-15) R2_ENDPOINT env override in api/_lib/r2.ts: when set, replaces the scheme+host
  of every presigned URL (any S3-compatible endpoint — the e2e r2-shim on :8112, or a MinIO box);
  unset = R2's own cloudflarestorage.com URL byte for byte. Unit-pinned (shape + signed host
  header follow the override). The e2e r2-shim is a bucket, not a verifier — SigV4 stays pinned
  by r2.test.ts.
- (QA 2026-10-15) The e2e stack runs on E2E_PORT (playwright.config webServer + qa-screens walk):
  :3000 belongs to the user's own unrelated server, and pointing a QA walk at it once produced a
  fully green run for the wrong site — caught only via the CDN image viewer. Harness ports
  (3100/8111/8112) are killed and verified free after every run.

## P5 decisions (2026-10-15, DASHBOARDS)
- D0 export engine (BACKEND, first Phase-5 slice): GET /api/exports/:report?format=csv|xlsx|pdf folds rows through the
  SAME src/lib/reports derivations the on-screen tables read (registry src/lib/exports/index.ts) — the file cannot
  disagree with the screen. Classic reports gate on page.live-reports (their open-tier Classic visibility, exactly);
  delivery agents 403 on all exports; read withholding per-collection rides the KPI layer's readModuleState.
- Stream-vs-job: ≤ 4000 rows (EXPORT_STREAM_MAX_ROWS) streams bytes with X-Last-Updated/X-Stale-After headers
  (contracts' streamed-file freshness rule); over it answers 202 + a meta row `export:<id>` whose FIRST POLL computes
  (serverless-honest: nothing idles), uploads to R2 exports/<id>.<ext> and presigns a 10-min download. Job files
  REQUIRE R2 (honest failure otherwise); stream files never touch it. Foreign/failing job reads 404, never 403.
- CSV header block = `# `-prefixed lines before the RFC-4180 table (title is the route's title, lines carry window +
  filters + generated-by + IST timestamp); a parser keyed on the header row skips them. XLSX renders the same block as
  bold lead rows; PDF as the title block. PDF text is Latin-1 (challanPdf constraint): ₹ prints as "Rs."; CSV/XLSX
  carry ₹ natively.
- exceljs added (dependency log, §2 pre-approved UI/report dep): XLSX renderer, MIT, Node-runtime. PDF reuses the
  in-tree jspdf + jspdf-autotable pair. exceljs hangs under vitest fake timers — the XLSX test runs real-time (pinned
  in exports.test.ts).
- Injection guard is ONE implementation (src/lib/exports/csv.ts guardCell + the XLSX eachCell pass in
  exportFormats.ts): client table exports re-export the shared toCsv. Exports are AUDITED (report.export rows, one
  per run, format + row count + window + job id).
- D1a fold honest gaps (declined, not missed): supplier LEAD TIME needs a sentAt the PO wire does not carry —
  avg(expectedOn) would be a guess, not a lead time. DAYS-OF-STOCK-LEFT needs the ledger fold + per-material
  conversions — lands with the Inventory module. Per-100 YIELD has no target line (batches carry recipeId but no
  seeded numeric targets — a window average is not a target and is not drawn). Mass-balance VARIANCE is charted per
  closed run with no tolerance row (tolerance is config, not data).
- D1a vocabulary pins: coconut-intake-by-supplier names suppliers with the lot report's receiptSupplier (Grn's
  farmer/farmerName — Grn has NO vendorId; the vendors join exists only PO-side). Un-promised POs count in any open
  window — hiding them would empty the funnel of drafts. Supplier on-time = FIRST linked receipt ≤ expectedOn; POs
  without a promised day never answer the question. Spend sums landed over ALL receipts (fruit included). Malai
  books uom 'Kg', water 'L' — per-100 yield never sums across units.

- D1b dashboards UI (DASHBOARDS + BACKEND, 2026-10-15): the module dashboards live ON Live Reports (`?dashboard=<module>` beside `?type=` — every view linkable), one card per KPI module in a Dashboards family at the top of the catalog, behind that module's OWN `dashboards_<module>` flag (the B1 backfill seeds every one OFF — the rollback position). visibleDashboards (src/lib/dashboards.ts) pre-checks the SAME flag × KPI-pages rule /api/kpis/:module enforces, so the catalog never offers a dashboard the endpoint would 403; delivery agents see none (the external clamp). All ten modules are catalogued now (process order); a flag staged early on an unbuilt module renders the API's honest empty state, never a client guess. page.dashboards (RBAC §c) still does not exist — the module-page gate IS the dashboard gate, per B4.
- D1b module export registers: `purchase-orders` (pages live-reports + procurement) windowed by the FUNNEL's own rule — an un-promised PO (a draft) rides every window or the register totals less than the funnel it sits beside; statuses print in the funnel's spelling. `spoilage` (pages live-reports + production) rides the PARETO's own join — a record windows with its BATCH (the close stamps both). Registers gate any-of their pages, mirroring the module KPI gate; classic report exports keep their live-reports gate.
- D1b export client (src/lib/exportJob.ts): stream → blob download with the server's Content-Disposition filename; 202 → poll /api/exports/jobs/:id (~1.5 s, capped ~a minute — a register fold slower than that is broken, not busy) → navigate the presigned URL. The DOM side is injectable so tests pin the decision, not the browser.

- D2a fold honest gaps (declined, not missed): per-SHIFT throughput needs a shiftId no packing run carries (shifts exist as staff×day assignments; nothing ties a run to one) — packs by month is the honest cut. PACKED-VS-PLANNED counts only stage-Packing plans entered in Packs; a Litre plan does not convert to packs without a product join the free-text plan product name cannot be trusted to make. FILL-STAGE SPOILAGE records have NO writer today — a packing run posts complete (W10: no close exists to file one) — so the pareto renders empty, honestly, until a fill-stage spoilage writer is designed (a DECISIONS decision, not a code whim). RECIPE-VS-ACTUAL needs no gap: components carry share as live data; the fold is mean (drawn share − recipe share) in pp over runs whose recipe resolves, recipe-listed-but-undrawn components included at −share; no run is named "milk" (which recipe is milk is live data — B1 seeded none), mirroring W9.
- D2a vocabulary pins: blend output is NET-NEW (production.ts's one method rule — outputs minus drawn, or the same litres print twice); run uoms spell both 'L' and 'Litre' by writer, so folds KEY NORMALIZED ('L'/'Litre' one bucket, kg its own — never summed). Intermediate stock is a POSITION (stockRows filtered Semi Finished, never windowed); near-expiry counts lots ≤30 d INCLUDING already-expired ones. Open blends = openBlendRuns (blendStage's export — the pipeline Blending tile's own predicate, one implementation). PLANNED-VS-MADE totals by month+uom, never per-product (name-matching boarded the wrong vehicle in HEAVY). FORMAT MIX reads a stamped packFormat first, else the B1 backfill's own `${name} ${type}`.includes('bib') derivation (W6 receiptStage precedent — form and eventual stamp cannot disagree); pack sizes are packLabel, the pack catalog's own label.

- D2b module registers (2026-10-16): `blend-runs` (pages live-reports+production) windows by the FOLD's own rule — a blend run rides its BATCH date; its Status column prints Open/Closed off openBlendRuns (the runs-by-status chart's own word) and its net-new output column IS netNewOutputs (the output trend's own arithmetic). `packing-runs` (pages live-reports+packing) rides its RUN date; the line summary and BIB-packs column read packFormatOf, now EXPORTED from the fold — one implementation decides BIB everywhere (format chart, share card, register). Known edge, kept: a live-reports-only holder streams an EMPTY blend/packing register (the module's collections are page-withheld — the B4 read-withholding rule, same as every classic report); holding the module's page fills it.

- D3a fold honest gaps (declined, not missed): QC CONTROL CHARTS and numeric OUT-OF-SPEC ALERTS need parameter results as NUMBERS against configurable spec limits — a QC test records a Pass/Fail/Retest status, never a reading, and no limits collection exists anywhere. The discrete truth is charted instead: FAILED TESTS BY CATEGORY (qcStatuses over windowed records; built-in titles, admin-added keys fall back to their key — the fold never sees app_config, collections only). TURNAROUND counts DECIDED records only (Released/Rejected — a Retest is still on the bench), batch day → reviewedAt day, calendar days. QUARANTINE VOLUME is a POSITION (stockRows filtered status 'Quarantine', ledger-derived, unwindowed — the staged receipts' whole-load lines are its writers; qty never sums across uoms, the label carries the unit). CONTROL-SAMPLE LOCATION is not recorded (the record carries collectedBy/remark, no storage bin) — no by-location chart exists. Sample counts are ROWS (the tile's own unit), never bottles; kept/expiry timeline and due count are POSITIONS (unwindowed); destructions and product mix window by destroyed/run day. REGISTER BY BATCH is the D3b export register's job.
- D3a build note: the qc fold now imports qcCategories/sensory, pulling them into the api tsconfig project for the first time — their import paths gained .ts extensions and two lambdas annotations (the api-imported-closure rule, applied late but harmless client-side).

- D3b module registers (2026-10-16): `qc-records` (pages live-reports+quality) windows by the REPORT's own rule — a record rides its BATCH date; its Failed-tests and Turnaround columns ARE the fold's own arithmetic (qcStatuses' Fail count; decided-only batch-day→review-day), never a re-derivation. `control-samples` (pages live-reports+control-samples) IS the register's own rows (controlSampleRows, tracking-sheet order) windowed by the run day, status in sampleStatus' own words. The D2b edge generalizes and is kept: `batches` gates on page.production (tables registry), so a live-reports+quality holder streams qc-records EMPTY until they also hold production — B4's read-withholding rule, same as every classic report. qc catalog blurb now names what the fold really draws (failed tests by category), not the numeric-spec-limits reading KPI.md wanted (no numeric results exist — see D3a).

- D4a fold honest gaps (declined, not missed): PM BOXED-VS-LOOSE RATIO, PER-CUSTOMER CARTON USE and CARTON RECONCILIATION all need the §3.3-9 carton master + dispatch_v2's per-line packaging decisions, neither of which exists (shipments read LOOSE by design — B5a; W15 deferred the carton step) — no chart fabricated for them. COLD-ROOM CAPACITY is not recorded (no field exists) — the occupancy heatmap is ₹ value by room × category, not fill %. SLOW-MOVING's threshold has no config field (KPI.md's "> N days") — SLOW_MOVING_DAYS = 30 is the ASSUMED constant (exported; moves to config when a field exists). MIN/MAX bands beyond the single items.reorder wait on the §2 min_stock/max_stock fields.
- D4a vocabulary pins: the inventory fold is all POSITIONS (stockRows / fgOnHand / lotAgeing — unwindowed, the control-samples precedent); value (₹) is the only cross-category unit and a uom rides the label wherever a chart splits them. NEAR-EXPIRY follows the classic rule (Released FG inside config.expiryAlertDays, fgOnHand's own buckets and default); near-expiry BULK stays the blending module's card (ib-near-expiry) — the two never double-count. AGEING rides lotAgeing's own buckets (raw + Semi Finished, harvest-or-receipt age). SLOW-MOVING is a separate cut — no ledger line on the exact row (stockRowKey identity) for SLOW_MOVING_DAYS, all categories. LOOSE BIB BY SIZE = the BIB finished-goods position by packLabel (every BIB is stored loose, §3.3-6; glass never answers). PM position and window both ride itemFlows — the classic PM report's own engine (closing at a {today,today} window IS the balance of every line to today, never re-derived); BELOW-REORDER counts the report's own belowReorder flag (items.reorder > 0) while the sidebar badge keeps lowStockItems' lowStockPacks fallback — a pre-existing second rule for alerts, unchanged. RECEIPT_TYPES/ISSUE_TYPES/lineDay now EXPORTED from inventoryReports.ts so the consumption fold rides the report's own type lists.

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
