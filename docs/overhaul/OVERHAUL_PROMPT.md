################################################################################
# MASTER EXECUTION PROMPT: BEVERAGE OPS PLATFORM OVERHAUL (FINAL)
# Mode: Multi-agent or sequential role-switching, token-budgeted, disk-based memory
################################################################################

# 0. RUNTIME DIRECTIVE
You are the LEAD ARCHITECT & ORCHESTRATOR of eight specialist agents (Section 7).
Agents are identified by NAME, not number: AUDITOR, ARCHITECT, BACKEND, SHELL, WORKFLOW,
SHIPMENT, DASHBOARDS, QA. Execution order is defined only by the Section 8 roadmap.
- If subagents are supported, spawn each with ONLY its own section plus Sections 1-6.
  All agents work SEQUENTIALLY on one working tree. Parallel work is allowed only in
  separate git worktrees against a frozen contract file.
- If single-agent, run roles in order. Before each switch output exactly:
  "=== AGENT: <Role Name> ===" and obey only that role's scope.
- No pleasantries, recaps, or filler. Start executing immediately.

# 1. MISSION
Overhaul a DEPLOYED, LIVE production/inventory dashboard for a coconut-water-led beverage
manufacturer. Production dept complaints: (a) the UI is bad, (b) the flow is confusing.
Also add Shipment Tracking with digital proof of delivery and delivery challans.
INVARIANT: preserve all existing data, behavior, and API contracts. Extend incrementally
via additive migrations and feature flags. Never rewrite from scratch.

# 2. PROJECT CONFIG (fill in; blanks are inferred by the Auditor from the repo)
Repo path: [ ]  Frontend: [ ]  Backend: [ ]  DB: [ ]  Auth/roles today: [ ]
Languages: [English / others]   Region: [India; tax fields configurable]   Timezone: [ ]
Roles: Procurement officer, Production operator, Packing, QC analyst, Store/Dispatch,
Delivery agent (limited, external), Manager, Admin.
Rule: extend the existing stack. UI/frontend dependencies are PRE-APPROVED: SHELL, WORKFLOW,
SHIPMENT, and DASHBOARDS may freely add whatever component library, charting, form,
signature-capture, PWA, or utility plugins fit best — log each choice as one line in
DECISIONS.md for the record; no justification or approval needed. Guardrails that still
apply: ONE component library and ONE chart library (no overlapping sets), must run on the
existing frontend stack (no framework migration), maintained with a permissive license.
Non-UI/backend dependencies still need a one-line justification in DECISIONS.md.

# 3. BUSINESS DOMAIN

3.1 Intake
- Raw coconuts: the ONLY graded intake. Record lot, count/weight, qty per grade, rejects.
- Non-graded: tea powders, fruits, lemons, condiments, sweeteners, flavours.
- Material master flags: procurement_form = RAW | READY_EXTRACT | DIRECT_USE;
  requires_grading (coconuts only); requires_extraction; shelf life; storage condition
  (ambient / cold room / frozen); base UoM; optional density or avg-unit-weight; min/max.
  RAW = needs in-house extraction (coconuts, lemons, fruits).
  READY_EXTRACT = procured juice/tea extract, skips extraction, goes to inventory.
  DIRECT_USE = powders, stabilizers, sweeteners, go straight to blending.
- Packaging materials: glass bottles, BIB pouches (1L, 2.5L, 5L), caps, labels, cardboard
  cartons for BIBs. Tracked as consumable stock with min/max reorder.

3.2 Transformation engine (extraction, intermediates, blending)
Implement as CONCRETE tables and ONE service: transformation, transformation_input,
transformation_output, spoilage. Recipes/BOMs are versioned plain data templates.
NO rules DSL, plugin system, or dynamic workflow builder.
- Batch = inputs[lot, qty, unit] -> outputs[lot, qty, unit, type] + spoilage.
- Output types: MAIN, CO_PRODUCT, BY_PRODUCT, INTERMEDIATE. Each output becomes a lot with
  its own number, expiry, QC status, and storage location.
- Spoilage is MANDATORY: a batch cannot close without a spoilage record (explicit zero
  allowed). Fields: qty, unit, reason code, optional photo. Reason codes are PER STAGE
  (e.g., extraction: rotten, cracked, overripe, pulp loss; blending/filling: spillage,
  burst pouch, line loss; any: QC reject). Codes are editable reference data.
- Mass balance runs in BASE UNITS using each material's conversion (count-based coconuts use
  configured avg weight per coconut; litres use density). Flag unexplained variance above a
  configurable tolerance. Never compare raw mixed units.
- Yield % and spoilage % per batch, material, grade, and supplier lot. Record actual vs
  recipe variance.

3.3 Production chain and anti-double-consumption invariants
 1 Procurement -> Receiving -> Inspection (QC at receipt is configurable).
 2 Coconut grading (coconuts only).
 3 Extraction: one coconut lot -> Coconut Water lot + Coconut Malai lot + husk/shell
   by-product + spoilage. The source lot is consumed ONCE, never per output.
 4 Intermediates, e.g. Coconut Milk: inputs malai lot(s) + water lot(s) + other recipe
   components (stabilizer, sweetener, salt, water) -> Coconut Milk lot (own QC, shelf life,
   storage, spoilage). Downstream blends consume the MILK lot, never the original coconuts
   or source malai.
 5 Blending: water, malai, milk, tea extract/powder, juice, condiments -> bulk product WIP
   lot (smoothies, iced teas, other beverages).
 6 Packing: glass bottles = standard flow. BIB pouches (1L/2.5L/5L) = stored LOOSE in the
   cold room; the pouch is the finished-goods unit tracked by lot, size, location.
 7 QC and Control Samples. HARD GATE: Hold / Passed / Failed / Rework. Lots not released
   cannot be blended, packed, or dispatched (server-enforced). A control sample links to its
   parent batch with timestamp, storage bin, and retention expiry. Whether samples deduct
   stock from the lot is an ASSUMPTION to log (default: yes, via explicit sample movement).
 8 Inventory/Storage: zones Ambient, Cold Room, Quarantine, Dispatch Staging. Cross-cutting
   layer, not a dead-end screen. Intermediates are first-class stock.
 9 Orders and dispatch packaging decision (BIBs):
   - Customer default dispatch_packaging = BOXED | LOOSE | ASK; order line can override.
   - Config table: pouch size -> carton type -> pouches per carton.
   - At pick/pack the system suggests carton type/count; operator confirms or edits;
     partial cartons allowed.
   - On confirm, ONE transaction decrements pouches and (if BOXED) cartons, linked to the
     dispatch line. LOOSE dispatch must leave carton stock untouched.
   - Record cold-room out-time and loading time; alert on configurable time-out-of-cold.
   - Reports: carton use per customer/period, carton stock vs min/max, boxed vs loose ratio,
     carton reconciliation (issued / used / damaged).
 10 Shipment tracking and proof of delivery (SHIPMENT agent).
 Returns: rejected or damaged items on delivery create a Return record linked to the
 shipment; QC decides inventory effect (back to cold room / quarantine / write-off).

# 4. ASSUMPTIONS REGISTER (anti-hallucination rule)
Every business parameter the client has not stated is logged in DECISIONS.md as
ASSUMED / CONFIRMED / EXISTS-IN-APP. This includes: grading scale, mass-balance tolerance,
spoilage reason codes, malai storage (chilled/frozen), QC-at-receipt, control-sample stock
deduction, cold-chain limits, FEFO rules, spec limits, challan numbering, tax/e-way fields,
OTP at delivery. Phase 0 checks the app first and marks what already exists. Agents must NOT
treat ASSUMED items as fact: build them as configurable values and surface them in the
Phase 1 summary. Tax/compliance fields on challans must be flagged for business or
accountant validation.

# 5. DISK MEMORY AND TOKEN DISCIPLINE (HARD RULES, ALL AGENTS)
Use ONE memory directory: docs/overhaul/ (relative to the repo root; if a different
directory already holds progress files from earlier work, use that one instead and never
create a second tree).
Files, each under ~150 lines:
 PROGRESS.md (Task | Agent | Status | Files | Next action), STATE.md (phase, locks,
 rollback markers), DECISIONS.md (assumptions register, dependency log, Blocked list),
 AUDIT.md, ARCHITECTURE.md, KPI.md, DESIGN_SYSTEM.md, GLOSSARY.md, DOMAIN.md, RBAC.md,
 handoffs/ (max 250 words each), cheatsheets/ (one page per role).
Rules:
1. On every session start or context reset, read PROGRESS.md and STATE.md first and resume.
2. Never paste large files into chat. Write to disk; report path + 3-line summary.
3. Inspect code with grep and line ranges; do not re-read what PROGRESS.md summarizes.
4. One task = one slice under ~6k output tokens. Split larger work and log the split.
5. Build large files in parts (skeleton, then section by section).
6. Code must be complete, typed, modular. No "rest of code" placeholders.
7. Commit small: one slice per commit with a clear message.
8. If a task fails twice: log under "Blocked" in DECISIONS.md and move to the next
   independent task.
9. On a token or output limit: save partial work, record the exact resume point, never
   restart a task from scratch. Instruct the user to resume in a fresh session by
   re-running this prompt file.
10. Update PROGRESS.md after every task.

COST MODEL: cost = requests x context size. Fewer, larger, well-planned steps beat many
small ones.
- ONE PHASE = ONE SESSION. At phase end: update PROGRESS.md/STATE.md, write the handoff,
  then STOP and tell the user to /clear and start the next phase.
- Hard stop at ~80k context: finish the current slice, save state, tell the user to clear.
- Do NOT spawn parallel subagents. Max ONE subagent at a time, only for read-heavy work
  (audit, large greps). Write-heavy work stays in the main session.
- Batch work: each slice should touch several files per request and use multi-file edits.
  Do not commit or update PROGRESS.md after every tiny task, only per slice/phase.
- Run commands with quiet output (tail -n 30, --silent, summary reporters). Never print full
  test logs, migrations output, or diffs.
- Read each file once; keep notes in PROGRESS.md instead of re-reading.
- Load only the current phase's agent section (kept in docs/overhaul/agents/<NAME>.md),
  not the whole prompt.

# 6. ENGINEERING STANDARDS (BACKEND AND PLATFORM INVARIANTS)
- ENVIRONMENT SAFETY: never connect to the production database or production secrets. Work
  only against a staging DB or a restored copy. Never print or commit secrets. Confirm the
  DB target in STATE.md before the first migration or test run.
- Migrations: additive and reversible, tested on a copy of production-like data, zero
  downtime. No drops or renames; deprecate in stages. Breaking API changes get /v2. Match
  the existing API style (REST or otherwise). Backfill legacy batches into the new model
  with a tested script that preserves old records.
- Source of truth: inventory balances and KPIs come from backend ledger/queries only, via
  ONE shared aggregation layer used by dashboards, reports, and exports so numbers match.
- Concurrency: transactions plus optimistic locking (version column) on stock movements,
  allocations, and state changes.
- Idempotency keys on receiving, batch completion, stock movement, dispatch confirm,
  signature submit, and challan creation.
- RBAC (least privilege, server-side on every route, export, and file URL). Deliverable:
  RBAC.md with a role x endpoint x action matrix. Delivery agents see ONLY assigned
  shipments and their own challans; no internal stock, costs, or other customers' data.
  Signed, expiring URLs for files.
- Audit log (who/what/when/old->new) on state changes, stock movements, exports,
  signatures, challans, config edits.
- Exports: CSV/XLSX/PDF with guards against CSV/formula injection; header shows title,
  filters, generated-by, timestamp; small = stream, large = background job + status +
  download-ready notification.
- Freshness: every dashboard and report shows last_updated and a visible STALE indicator
  past a configured age. No silent stale data. Live updates via SSE/WebSocket with polling
  fallback.
- Feature flags and a "Classic view" toggle for every phase; rollback plan per phase.
- Timestamps stored in UTC, shown in the facility timezone.
- UI standards: status is never color-only (color + icon + text); one palette: Pending, In
  Progress, On Hold, Passed, Failed, Rework, Released, Dispatched, Out for Delivery,
  Delivered, Returned. WCAG AA, touch targets >= 44px, usable on a 10" tablet and phone,
  light and dark mode, i18n-ready strings from GLOSSARY.md. Every screen has loading
  skeleton, empty state, and error state.

# 7. AGENTS

## AUDITOR (read-only)
1. Map screens, routes, APIs, DB entities, tests into AUDIT.md (terse tables).
2. Trace current flow UI -> API -> DB; compare to the Section 3 flow. Rank friction points
   by severity (extra clicks, duplicate entry, unclear labels, dead ends, inconsistent nav,
   missing feedback).
3. Check how the app records today: grading, extraction yield, spoilage, coconut milk,
   BIB/carton handling, dispatch, returns. List gaps and mark which Assumptions Register
   items already EXIST-IN-APP.
4. Run existing tests; record baseline pass/fail. List chartable data (exists vs missing)
   and a risk list for current users.
5. Extract UI labels into GLOSSARY.md; flag confusing ones.
Output: AUDIT.md, GLOSSARY.md, DOMAIN.md draft, DECISIONS.md register.

## ARCHITECT (docs and contracts only)
1. IA: sidebar in process order with live count badges ("QC: 7 pending", "Out for delivery:
   4"); role-based landing pages; global search (Ctrl/Cmd+K) across lot, batch, PO, order,
   challan, customer, location.
2. Data model: material flags, transformation tables, intermediate lots, recipe versions,
   grading, spoilage codes, carton specs, customer packaging preference, dispatch packaging
   lines, shipments, delivery events, signatures, challans (versioned), returns.
3. State machines (Mermaid + transition table with role permissions): lot/batch lifecycle
   incl. hold/release/rework/reject, order, dispatch, shipment/delivery.
4. Genealogy query design, forward and backward, across multi-input batches (coconut
   -> extraction -> malai/water -> milk -> blend -> packed BIB -> dispatch -> shipment).
5. FROZEN CONTRACTS: publish API schemas/shared types as a single contract artifact
   (OpenAPI or shared types file) that BACKEND and SHELL consume without changing.
6. KPI.md: per module metric, formula, source tables, refresh rate, chart type.
7. RBAC.md matrix.
GATE: post a 15-line summary (flow, data model, state machines, Assumptions Register
highlights) then AUTO-PROCEED. Hard stop ONLY for destructive or irreversible actions
(destructive migrations, production-data backfills), which need explicit human approval.

## BACKEND (manufacturing systems engineer; one slice per task, in order)
1. Migrations, indexes, backfill scripts.
2. Transformation service: multi-input/output, mandatory spoilage, unit-aware mass balance,
   yield/spoilage calc, recipe variance, intermediate lots.
3. State machine engine: legal transitions, QC release gate, role checks, locks, audit.
4. Receipt flows (RAW / READY_EXTRACT / DIRECT_USE) and coconut grading (coconuts only).
5. Genealogy endpoint.
6. Packaging engine: carton specs, customer preference, suggestion, atomic deduction,
   reconciliation, cold-room time-out tracking.
7. Shared aggregation layer with caching or materialized views for heavy KPIs; no N+1.
8. Live feed with last_updated and stale flags.
9. Report/export engine and print endpoints (Batch Record, QC Certificate/COA, Dispatch
   Note). Optional scheduled email reports per role behind a flag.
10. Shipment, delivery event, return, and challan endpoints (with SHIPMENT).
Tests: unit (state machines, mass balance with unit conversion, yield, carton math, KPIs)
and integration per endpoint.

## SHELL (design system engineer; starts only after BACKEND's contracts are frozen and merged)
1. Tokens, light/dark, accessible status palette. Document in DESIGN_SYSTEM.md; add a
   /styleguide route.
2. Components: AppShell, collapsible Sidebar with live badges, TopBar with command palette,
   StatusBadge, KpiCard (trend delta), DataTable (sticky header, column toggle, saved
   filters, server pagination or virtualization, sort, bulk actions, density), FilterBar
   (date presets), SectionedForm/Stepper with autosave drafts, ConfirmDialog, EmptyState,
   Skeleton, ErrorBoundary, ChartCard (tooltip, legend, view-as-table, export,
   last_updated/stale), TransformationForm (input/output/spoilage grid with live
   mass-balance indicator), SignaturePad, QR/barcode input.

## WORKFLOW (pipeline & production engineer)
1. Pipeline Home: horizontal stage tracker with counts; bottlenecks highlighted (aging,
   stuck > configurable hours, on hold, near-expiry intermediates); click-through to
   filtered lists; role-based landing redirects.
2. Batch/Lot Detail: forward/backward genealogy tree, stage timeline, ONE primary "Next
   action" button showing only legal actions for the role; disabled actions explain why in
   plain language.
3. Stage forms, one per task, prefilled from the previous stage: Receipt (3 forms by
   procurement_form), Coconut Grading, Extraction (multi-output + spoilage), Coconut Milk
   batch, Blend Mixing (live inventory checks), Packing (glass vs BIB loose), QC test entry,
   Control Sample register, Storage put-away (incl. cold room), Order, Dispatch (with
   packaging step per 3.3-9).
4. Reduce data entry: remember last values, QR/barcode scan, inline plain-language
   validation.
5. Onboarding: first-run tour, tooltips, feedback button, role cheat sheets.

## SHIPMENT (tracking & proof-of-delivery engineer)
New sidebar item "Shipment Tracking" after Dispatch.
1. Internal board (desktop): all dispatched orders with status Dispatched -> Out for
   Delivery -> Delivered / Partially Delivered / Returned / Failed. Columns: order, customer,
   dispatch date, agent, vehicle, packaging mode, items, status, ETA, delivered-at, challan
   link. Filters, KPIs (on-time %, pending, failed, avg delivery time), exports, agent
   reassignment, failed-delivery reasons and reschedule.
2. Delivery-agent PWA (mobile-first, limited role, assigned shipments only):
   - List and open a shipment: items, quantities, packaging (boxed/loose, carton count),
     customer address/contact, notes.
   - "Start delivery" -> Out for Delivery (timestamp, optional GPS).
   - Per-line confirmation: full, partial, or rejected/damaged with reason (creates a Return
     record), optional photo.
   - Customer signature on a canvas pad with printed name and phone; optional OTP (flagged).
   - Offline tolerant: local queue with retry, idempotency keys, clear sync state.
3. Challan: on valid submission the server generates a PDF delivery challan with unique
   sequential number (configurable series/financial-year prefix), company and customer
   details, order and dispatch refs, lines with batch/lot numbers, quantities, packaging
   details, vehicle and agent, delivery timestamp, embedded signature, configurable tax
   fields (flag for validation). Challans are IMMUTABLE: corrections create a linked new
   version with reason and audit entry. Stored in file storage; retrievable from order page,
   shipment page, and a searchable Challans register; optional share link by email/WhatsApp.
4. Reports: deliveries by agent, on-time %, failed/returned reasons, challan register,
   BIB/carton returns.

## DASHBOARDS (reports engineer; one module per task; one chart library, lazy-loaded)
Order: Procurement -> Grading & Extraction -> Intermediates & Blending -> Packing -> QC ->
Control Samples -> Inventory/Storage -> Packaging Materials -> Orders & Dispatch ->
Shipment Tracking.
Per module: Dashboard tab (KPI cards + charts) and Reports tab (live report with last_updated
+ stale indicator + manual refresh; filters with date presets and batch/material/supplier/
line/shift/customer/status; saved views; CSV/XLSX/PDF export with filters applied; large
export job progress and toast; chart-segment click-through to filtered records). Every chart
has tooltip, legend, empty state, table fallback.
Catalog:
- Procurement: PO status funnel; supplier on-time % and lead time; spend trend; pending
  deliveries calendar; days-of-stock-left; coconut intake by supplier.
- Grading: grade distribution per lot; grade mix trend; reject %.
- Extraction: water and malai yield per 100 coconuts vs target; spoilage Pareto by reason,
  supplier lot, grade; mass-balance variance; cycle time.
- Intermediates and blending: milk batches, recipe vs actual variance, malai/water
  consumption, intermediate stock and expiry, batches by stage, output vs plan.
- Packing: throughput per shift; packed vs planned; glass vs BIB mix; pack-size mix;
  rejects and wastage.
- QC: pass/fail trend; parameters vs spec limits as control charts (limits configurable);
  out-of-spec alerts; pending queue aging; turnaround; quarantine volume.
- Control Samples: register by batch; retention-expiry timeline; due/expiring; location.
- Inventory: stock by category (treemap/stacked bar); cold-room occupancy heatmap;
  near-expiry and slow-moving; reorder alerts; ageing; loose BIB stock by size.
- Packaging materials: stock vs min/max; consumption trend; boxed vs loose ratio; per-
  customer carton use; carton reconciliation.
- Orders and dispatch: pipeline; fulfilment %; overdue; dispatch vs plan.
- Shipment tracking: status board; on-time %; failed/returned reasons; agent performance.

## QA (security, performance & visual verification engineer)
Runs in two tiers:
- LIGHT (after each phase and every two dashboard modules): unit, integration, and RBAC
  matrix tests, lint/typecheck, and a smoke test of touched screens only.
- HEAVY (Phase 6 only, plus once after Phase 3 for Journey A as far as it exists — through
  dispatch, since the signature/challan legs need SHIPMENT from Phase 4): full E2E journeys
  A-E, multi-viewport screenshots, Lighthouse, performance profiling. Do not run HEAVY at
  intermediate gates unless a LIGHT check fails and the cause cannot be found otherwise.
Duties (LIGHT runs the test-level subset of these after each phase; HEAVY runs all):
1. E2E journeys (Playwright/Cypress):
  A Coconut PO -> receipt -> grading -> extraction (spoilage) -> coconut milk -> blend ->
    BIB pack -> cold room -> boxed dispatch -> delivery signature -> challan.
  B Ready-extract intake -> blend -> glass bottle pack -> dispatch (no grading/extraction).
  C Loose BIB dispatch: carton stock untouched.
  D QC failure -> quarantine -> blocked blend/pack/dispatch verified server-side.
  E Delivery return: rejected items -> Return record -> QC-decided inventory effect.
2. Negative tests: concurrent stock allocation, double-submit retries (idempotency),
   mass-balance violations and unit-conversion errors, illegal transitions, offline
   sync replay.
3. Security: verify RBAC.md matrix by test (delivery agent cannot read unassigned shipments,
   others' challans, or internal stock), export injection guards, expiring file URLs, no
   secrets in client bundle, audit coverage.
4. Performance: API p95 < 500 ms on primary lists; dashboard first meaningful paint < 2 s on
  LAN; delivery PWA usable on 4G; query plans for heavy KPIs; before/after numbers.
5. Accessibility (keyboard, ARIA, contrast; Lighthouse >= 90 on key screens).
6. VISUAL VERIFICATION: capture screenshots of key screens (Pipeline Home, Batch Detail,
   each stage form, each dashboard, Shipment board, delivery PWA, challan PDF) at desktop,
   tablet, and phone widths; review against a written checklist (status not color-only, no
   overflow or horizontal scroll, 44px targets, empty/error/loading states, stale
   indicators, readable charts). Defects go back to the owning agent by handoff note.
7. Deliver QA_REPORT.md, ROLLOUT.md (checklist and rollback per phase), and a usability
   test script (5 tasks with success criteria) for 3-5 real users before and after.

# 8. EXECUTION ROADMAP (STRICTLY SEQUENTIAL)
Phase 0  Read/create PROGRESS.md and STATE.md; confirm the DB target (staging or restored
         copy, never production) in STATE.md. Run AUDITOR.
Phase 1  Run ARCHITECT. Post the 15-line summary, then auto-proceed (hard stop only for
         destructive/irreversible actions). Freeze contracts.
Phase 2  BACKEND (migrations, transformation engine, state machines, genealogy) ->
         then SHELL (design system + app shell) consuming frozen contracts. QA LIGHT.
         Flag: shell + nav.
Phase 3  WORKFLOW (Pipeline Home + Batch Detail, then stage forms one at a time) with
         BACKEND slices as needed. QA LIGHT, then HEAVY once: Journey A as far as it
         exists (through dispatch). Flag: pipeline + batch.
Phase 4  SHIPMENT (Shipment Tracking, delivery PWA, signature, challan) with BACKEND
         shipment/challan endpoints. QA LIGHT.
Phase 5  DASHBOARDS builds dashboards + reports one module at a time, BACKEND supplies each
         module's KPI/export endpoints first. QA LIGHT after every two modules.
Phase 6  QA HEAVY full pass (E2E A-E, security, performance, accessibility, visual
         verification). Fix defects, cleanup, docs, rollout/rollback plans, cheat sheets.
At each phase end: update PROGRESS.md and STATE.md; post a max 10-line status (done / next /
risks / new assumptions); continue.

# 9. ACCEPTANCE CRITERIA
- A new operator completes their role's primary task in <= 3 screens without training.
- Pipeline Home shows every batch's stage and blocked/aging batches at a glance.
- Only coconuts are graded; READY_EXTRACT skips extraction; DIRECT_USE skips to blending.
- Every extraction and milk batch has a spoilage record and passes a unit-aware mass balance.
- Coconut milk is its own intermediate lot, traceable back to the coconut receipt lot, and
  blends consume the milk lot (no double consumption).
- Unreleased or quarantined lots cannot be blended, packed, or dispatched (server-enforced).
- BIBs are stored loose; carton decision happens at dispatch; BOXED decrements pouches and
  cartons atomically; LOOSE leaves carton stock untouched.
- Shipment Tracking lists all dispatched orders; a delivery agent captures the customer
  signature and an immutable, sequentially numbered challan PDF is generated, stored, and
  retrievable from the order; delivery agents see only their own assigned data.
- Every module has a dashboard and a live report, exportable to CSV/XLSX/PDF, with
  last_updated and stale indicators; dashboard and report numbers match.
- Every ASSUMED business parameter is logged and configurable.
- Screenshots reviewed at three viewport sizes with no open critical visual defects.
- No regression on legacy data; all tests pass; Lighthouse >= 90 on key screens.
- No phase ever connected to the production database or exposed secrets; STATE.md records
  the confirmed DB target before the first migration.

# 10. START
Begin immediately with Phase 0. Output exactly:
"Resuming from: <state read from PROGRESS.md/STATE.md, or Phase 0 (Audit) if none>"
followed by Agent 1's first tool call.
################################################################################
