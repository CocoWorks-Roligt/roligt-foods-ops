# PROGRESS — Beverage Ops Platform Overhaul
Updated: 2026-10-14 | Branch: dev | Base commit: de4c13b | Phase 3 WORKFLOW complete (W16 done)

| Task | Agent | Status | Files | Next action |
|---|---|---|---|---|
| P0: init memory + confirm DB target | LEAD | done | PROGRESS.md, STATE.md | — |
| P0: audit slices 1-3 | AUDITOR | done | AUDIT.md, DOMAIN.md, GLOSSARY.md, DECISIONS.md | — |
| P0: commit docs | LEAD | done | docs/overhaul/* @ aa92cf3 | — |
| P1: ARCHITECTURE.md (IA, model, state machines, genealogy, enforcement) | ARCHITECT | done | ARCHITECTURE.md | — |
| P1: contracts artifact src/lib/contracts.ts | ARCHITECT | done | src/lib/contracts.ts, handoffs/contracts.md | frozen |
| P1: freeze contracts, 15-line summary, commit | LEAD | done @ 1be46d3 | docs/overhaul/* | — |
| P2/B1: backfill + seed scripts | BACKEND | done @ b0fda9a | src/lib/backfillPhase2.*, scripts/overhaul/backfill-phase2.mjs | dry-run drill ok (703 docs); apply to scratch deferred to LEAD |
| P2/B2: rules engine + commit-gate enforcement | BACKEND | done @ 3c204b9 | src/lib/rules*, api/_lib/rulesGate.ts, d1Commit.ts | 869 tests green |
| P2/B3: endpoints (close/dispatch/grading/genealogy/search/idempotency) | BACKEND | done @ efb1e07 | api/*, src/lib/genealogy.ts, handoffs/b3.md | 935 tests green (429 had killed the subagent mid-run; verified+committed by LEAD) |
| P2/LEAD: review fixes — contracts v1.1, domain.ts dedupe, release arm, reconciliation test, mass-balance audit | LEAD | done @ df995da, fdc62be | contracts.ts, api/_lib/domain.ts + 11 src/lib files, rulesGate*, scripts/overhaul/mass-balance-audit.ts | see DECISIONS 2026-10-13 review section |
| P2/B4: /api/kpis skeleton + /api/events SSE | BACKEND | done | src/lib/kpis/*, api/_lib/kpis.ts, api/_lib/events.ts, api/kpis/[module].ts, api/events.ts, handoffs/b4.md | 955 tests green; folds: qc + orders-dispatch; rest registered for P5 |
| P2: SHELL tokens + status palette + chart theme | SHELL | done @ 5a73273 | index.css (light+dark tokens), theme.ts, statusPalette.ts, StatusBadge/StatusIcons, chartTheme.ts, DESIGN_SYSTEM.md | 967 tests |
| P2: SHELL shell primitives + charts | SHELL | done @ 5a73273 | shell/: Skeleton, ConfirmDialog, FreshnessChip, KpiCard, FilterBar, DataTable, ChartCard + echartsChunk (echarts 6, the ONE chart lib) | validated palettes both modes |
| P2: SHELL live shell (flags→client, badges, process nav, palette) | SHELL | done @ 7b4e3bb | api/snapshot.ts flags ride-along, rulesGate.readFlagRecords, AppContext flags, useRevisionFeed (one ES/tab), useKpis, navBadges.ts, shell/CommandPalette.tsx, Layout.tsx shell_nav branch | 973 tests; Classic byte-identical when flag off |
| P2: SHELL workflow forms | SHELL | done @ a331a32 | useDraft.ts, shell/SectionedForm+Stepper, TransformationForm (live computeMassBalance), SignaturePad (hand-rolled), ScanInput | 981 tests |
| P2: SHELL /styleguide + QA LIGHT | SHELL | done | pages/Styleguide.tsx, App.tsx route; gates tsc -b / vitest / lint 10 / build | QA LIGHT re-run below |
| P2: QA LIGHT | QA | done (SHELL self-run) | — | gates green at each slice; see log |
| P3/W1: Pipeline Home (flag pipeline) | WORKFLOW | done @ 6b844b1 | src/lib/pipeline.*(+test), src/pages/Pipeline.tsx, App.tsx, Layout.tsx, pages.ts, types.ts, index.css | 992 tests |
| P3/W2: Batch/Lot Detail (flag pipeline) | WORKFLOW | done @ 45b3e5e | src/lib/batchDetail.*(+test), src/pages/BatchDetail.tsx, App.tsx, Layout.tsx, index.css | 998 tests |
| P3/W3: PO endpoints (contracts v1.3) | WORKFLOW | done | api/_lib/purchaseOrders.ts(+po.test), api/purchase-orders.ts, api/purchase-orders/[id].ts, contracts.ts, DECISIONS #16, RBAC §c | 1008 tests; W4 stage forms next |
| P3/W4: PO form + register (contracts v1.4) | WORKFLOW | done | src/lib/poApi.ts, src/pages/PurchaseOrdersTab.tsx, Procurement.tsx tab, contracts.ts, index.css | 1008 tests; W5 Receipt forms next |
| P3/W5: GRN↔PO linkage endpoint (contracts v1.5) | WORKFLOW | done | api/_lib/purchaseOrders.ts (+receive, po.test), api/purchase-orders/[id]/receive.ts, contracts.ts, RBAC §c | 1014 tests; W6 Receipt stage form next |
| P3/W6: Receipt stage form (×3 by procurement form + staged grading) | WORKFLOW | done | src/pages/ReceiptTab.tsx, Procurement.tsx (4th tab), src/lib/receiptStage.*(+test), grn.ts(+test), context/domains/procurement.ts(+test), poApi.ts (receivePurchaseOrderCall), types.ts (Grn.poId), api/_lib/gradingPost.ts (gradedOn fix, b3.test) | 1032 tests; W7 Coconut Grading form next |
| P3/W7: Coconut Grading form (staged lots; contracts v1.6) | WORKFLOW | done | src/pages/GradingTab.tsx, Procurement.tsx (5th tab), src/lib/gradingStage.*(+test), gradingApi.ts, poApi.ts (shared helpers exported), pipeline.ts (Grading rows → form), api/_lib/d1Snapshot.ts (grn version ride-along), contracts.ts v1.6, types.ts (Grn.version), d1Engine.test, b3.test | 1041 tests; W8 Extraction stage form next |
| P3/W8: Extraction stage form (press & close; contracts v1.7) | WORKFLOW | done | src/pages/ExtractionTab.tsx, Production.tsx (3rd card, pipeline), src/lib/extractionStage.*(+test), extractionApi.ts, api/_lib/d1Snapshot.ts (batch version ride-along), contracts.ts v1.7, types.ts (Batch.version), pipeline.ts+navBadges.ts (Closed status), ExtractionBatches.tsx (filter option), index.css | 1047 tests; W9 Coconut Milk batch form next |
| P3/W9: Blend stage form — intermediate runs incl. coconut milk | WORKFLOW | done | src/pages/BlendTab.tsx, Production.tsx (4th card, pipeline), src/lib/blendStage.*(+test), src/lib/extractionApi.ts→runCloseApi.ts (rename: shared close client), ExtractionTab.tsx (import), pipeline.ts (Blending rows → ?stage=blend), index.css (stage-picker-4) | 1051 tests (+4); contracts stay v1.7 (no new wire); W10 Packing stage form next |
| P3/W10: Packing stage form (bottles + loose BIB pouches) | WORKFLOW | done | src/pages/PackingTab.tsx, Production.tsx (5th card, pipeline), src/lib/packingStage.*(+test), index.css (stage-picker-5) | 1056 tests (+5); contracts stay v1.7 (no new wire); W11 QC test entry next |
| P3/W11: QC test entry form (bench queue) | WORKFLOW | done | src/pages/QcEntryTab.tsx, Quality.tsx (Test entry tab, pipeline), src/lib/qcStage.*(+test), pipeline.ts (QC rows → ?tab=entry) | 1059 tests (+3); contracts stay v1.7 (no new wire); W12 Control Sample register next |
| P3/W12: Control sample destruction shelf | WORKFLOW | done | src/pages/SamplesTab.tsx, ControlSamples.tsx (Destruction shelf tab, pipeline), src/lib/sampleStage.*(+test), pipeline.ts (samples rows → ?tab=shelf) | 1061 tests (+2); contracts stay v1.7 (no new wire); W13 Storage put-away next |
| P3/W13: Storage put-away queue | WORKFLOW | done | src/pages/PutAwayTab.tsx, Inventory.tsx (Put away tab, pipeline), src/lib/storageStage.*(+test) | 1065 tests (+4); contracts stay v1.7 (no new wire); W14 Order stage form next |
| P3/W14: Order desk | WORKFLOW | done | src/pages/OrderDeskTab.tsx, Orders.tsx (Order desk tab, pipeline), src/lib/orderStage.*(+test), ordersView.ts (draftFromOrder/linesFromDraft extracted), pipeline.ts (orders rows → ?tab=desk) | 1069 tests (+4); contracts stay v1.7 (no new wire); W15 Dispatch stage form next |
| P3/W15: Dispatch stage form | WORKFLOW | done | src/pages/DispatchTab.tsx, Orders.tsx (3rd tab + modal onto shared folds), OrderDeskTab.tsx (dispatch link), ordersView.ts (allocationsFromPicks/allottedFor/shortLineOf), ordersView.test.ts | 1072 tests (+3); contracts stay v1.7 (no new wire); W16 Onboarding next |
| P3/W16: Onboarding — tour, tooltips, feedback, cheat sheets | WORKFLOW | done | src/lib/onboarding.ts(+test), src/components/shell/Tour.tsx, src/components/shell/HelpMenu.tsx, Layout.tsx (anchors+help+tour), Pipeline.tsx (tile titles), index.css, docs/overhaul/cheatsheets/ (8 roles) | 1077 tests (+5); contracts stay v1.7; Phase 3 QA LIGHT re-run + HEAVY (Journey A) next |

## Log
- 2026-10-13 Phase 0 complete. Baseline green (745 tests, tsc -b, lint, build @ de4c13b). DB target confirmed:
  local in-memory sqlite for tests, roligt-ops-scratch (remote) for smoke; prod DB prohibited.
  Key audit finding: NO server-side business logic — all rules client-side; server gates are net-new work.
  15 assumptions-register items logged in DECISIONS.md (3 EXISTS, 5 PARTIAL, 7 MISSING).
- 2026-10-13 LEAD review session. B3 verified (935 green) and committed. Contracts bumped to v1.1
  (challan on DispatchConfirmResponse, melanges.recipeId, avgUnitWeight naming). B3 deviation 3 closed:
  src/lib closure now .ts-extensioned; domain.ts delegates to numbering/grn/stockIds (one implementation).
  qc_gate_v2 gained the release arm (can.release_lot seam; page.quality proxy — see DECISIONS).
  Spoilage↔ledger reconciliation test added. Historical mass-balance audit (scripts/overhaul/mass-balance-audit.ts
  over dump-prod-export-2026-10-12): 3/14 batches pass at 2% — batch_v2 enforcement NOT viable without an
  unaccounted-loss/by-product line, per-material tolerance, or warn-first (decision open in DECISIONS #2).
  Zoho/flags verified structurally safe: gated endpoints 503 when D1 unset; flags live only in D1.
  938 tests green, tsc -b, lint 10 warnings (baseline), build pass.
- 2026-10-13 B4 done. KPI aggregation layer live (ARCHITECTURE §6): registry + revision-keyed
  memo + meta cache (kpi:<module>, never bumps revision) + page-withholding honored per collection;
  reference folds qc (delegates to qualityReport) and orders-dispatch; contracts v1.2 (+RevisionEvent,
  SSE hello/revision/bye). /api/events SSE streams the D1 revision token (4-min life < 300 s cap;
  poll fallback /api/revision). KPI.md module key corrected to shipment-tracking. Gates: tsc -b,
  955 passed, lint 10 (baseline), build pass. B contracts complete — SHELL next (builds against v1.2).
- 2026-10-13 SHELL done, three slices (5a73273, 7b4e3bb, a331a32 + styleguide). (1) Tokens:
  light + full dark theme (value-only overrides, color-scheme, print sheets stay paper-white);
  status palette color+glyph+word with exact-key table over substring families (readStatus);
  chartTheme with dataviz-validated palettes both modes (brand teal #0d9488 slot 1; sequential
  OKLCH-even teal ramps; light-mode categorical contrast WARNs covered by the relief rule —
  ChartCard ships table view + labels); DESIGN_SYSTEM.md written. (2) Primitives: Skeleton,
  ConfirmDialog, FreshnessChip, KpiCard (delta glyph+sign, invertDelta), FilterBar (date presets),
  DataTable (sticky header, sort, density, column chooser, per-device prefs), ChartCard (six kinds,
  chart↔table, CSV, freshness) on tree-shaken echarts 6 lazy chunk (DECISIONS dependency log).
  (3) Live shell: flags ride /api/snapshot (Zoho answers none = all-OFF = Classic) and fold
  through the same isomorphic readFlags in AppContext; useRevisionFeed is ONE EventSource per tab
  (module singleton — browser cap near six), /api/revision poll fallback; useKpis owns
  /api/kpis/:module + freshness + revision refetch; navBadges folds AppState→counts on existing
  page vocabularies (QC Pending, orders Open, batch roll-ups, PM reorder, sample retention —
  Packing/Dispatch/Home deferred until their phases); Layout renders the process-order sidebar
  with badges + Ctrl/Cmd+K CommandPalette (GET /api/search) when shell_nav is on, Live Reports
  shown as "Dashboards" (GLOSSARY); Classic untouched when off. Forms: useDraft localStorage
  autosave, SectionedForm/Stepper, TransformationForm folding the same isomorphic
  computeMassBalance as the close gate, hand-rolled SignaturePad (pointer+canvas), ScanInput
  (keyboard-wedge half; camera deferred to SHIPMENT PWA). /styleguide route (no catalog entry)
  renders tokens/palette/components live. Gates at each slice: tsc -b, 981 tests (baseline 955
  +26), lint 10 (baseline), build pass. NOTE for LEAD: hand-staging a flag row does not bump
  app_revision — the snapshot ride-along carries it on the next poll/SSE tick anyway, but a
  staged flag will not force one; toggle visibility may lag up to one poll (20 s).
- 2026-10-13 WORKFLOW W1+W2 (6b844b1, 45b3e5e). W1 Pipeline Home behind the `pipeline` flag: pure
  fold pipelineStages(state,today) over the same AppState navBadges reads (numbers match by
  construction — no new backend), 10 stages in process order with stuck/hold/expiry/overdue bottleneck
  notes (DECISIONS #16: pipelineStuckDays ASSUMED 2, configurable), stage tiles drill into filtered
  DataTables whose rows link to /batch/:id; '/' redirects by role when pipeline is on (roleLandingPath,
  guarded against loops); Layout prepends Pipeline to the process nav. W2 Batch/Lot Detail: batchDetail
  folds an honest timeline from existing timestamps, forward/backward genealogy (GENEALOGY_DEFAULT_DEPTH
  + truncation note), and ONE primary next action gated by page holds — the QC gate reads STOCK ROW
  status via bulkVerdict (canConsumeLot per lot), not the batch.status roll-up; refused actions render
  with their why (GUARD_EXPLANATIONS). Classic batches keep flow actions (QC verdict/pack/blend/dispatch);
  the v2 run machine waits for batch_v2 forms. Gates each slice: tsc -b, 992→998 tests, lint 10, build.
- 2026-10-13 WORKFLOW W3. Purchase orders — the plant's first upstream document (AUDIT: "No POs"),
  needed before the Receipt stage form (KPI.md: no PO form, no funnel/on-time/lead-time numbers).
  contracts v1.3 (additive): PO create/patch/response/list wire shapes. api/_lib/purchaseOrders.ts owns
  the verdicts: POST mints from the `po` counter (seeded B1), validates vendor+lines against held
  masters (unknown vendor refused, not stored broken), starts draft unless caller says sent; PATCH runs
  the shared purchaseOrder machine + fully_received guard (proxy: ≥1 linked GRN until W4 lands the
  GRN↔PO linkage); GET newest-first for the PO form. All three page.procurement-only, Idempotency-Key
  POST/PATCH with replay, one atomic writeBatch each (PO+counter+audit+receipt / upsert+audit+receipt).
  PATCH route reuses the POST contract inline (postAdapter is POST-only). Not flag-gated: a collection
  nothing Classic reads is inert by construction. 10 service tests over the b3 FakeD1 harness. Gates:
  tsc -b, 1008 passed, lint 10 (baseline), build pass.
- 2026-10-13 WORKFLOW W4. The PO form and register, on Procurement as a third tab (pipeline flag;
  lazy chunk — Classic never loads it). Building it exposed a v1.3 gap: PATCH wants expectedVersion
  but the wire carried no version — v1.4 adds PurchaseOrderVersionExtension, every PO the endpoints
  RETURN carries documents.version (stored docs stay version-less; create→1, patch→observed+1).
  src/lib/poApi.ts: fetch client with adminApi session semantics + Idempotency-Key per intent
  (randomUUID) and PoApiError {code, details} so the form branches on the guard that refused.
  PurchaseOrdersTab: DataTable register (purchase-orders), row → order card with lines +
  receivedGrnIds + ONLY the machine-legal moves as buttons (legalTargets), each labelled with its
  guard's plain-language note (guardsRequired→explainGuard); SectionedForm create form with a lines
  repeater (items datalist), useDraft remembering the last supplier + expected-on day (data-entry
  reduction), client-side field checks mirroring the server's own questions. Gates: tsc -b, 1008
  passed, lint 10 (baseline), build pass.
- 2026-10-13 WORKFLOW W5. POST /api/purchase-orders/:id/receive (contracts v1.5): the Receipt form's
  linkage call. Links a booked GRN to its PO append-once (a repeat is a no-op success — the linkage
  is a set), lands an acknowledged PO in received (the machine's own arrow), keeps it there on
  part-receipts; sent/draft refuse with po_not_acked ("get it acknowledged before booking receipts"),
  unknown GRN grn_not_found, CAS 409, Idempotency-Key replay, audit po.received {grnId, from, to}.
  Route api/purchase-orders/[id]/receive.ts reuses the inline-adapter pattern ([id].ts beside it
  answers PATCH; Vercel's static-segment-wins routing keeps them apart). 6 new service tests (16 PO
  total). Gates: tsc -b, 1014 passed, lint 0 errors, build pass.
- 2026-10-14 WORKFLOW W6. The Receipt stage form — a fourth Procurement tab ("Receive goods",
  pipeline flag, lazy chunk; contracts stay v1.5 — every wire it uses already existed). One form
  whose questions follow the ITEM's procurementForm (receiptStage.ts: stamped flag first, then
  the B1 backfill's own derivation, so form and eventual master cannot disagree): RAW+piece →
  grade fields or "Grade later" (gradingMode:'staged'); everything else → count/rate/transport
  with a where-it-goes note (READY_EXTRACT → inventory as-is; DIRECT_USE → blending stock).
  Staged receipts post through the SAME createGrn: priceGrn gained a staged arm (whole load =
  accepted, provisional costs; grn.test) and the write path books grades zero, accepted=total,
  ledger Receipt line status 'Quarantine' — exactly the bucket gradingPost moves per grade.
  Classic updateGrn refuses typed grades and re-counts on staged docs ("Pipeline → Grading");
  farmer/area/harvest/notes stay editable (procurement.test). BUG FIX in gradingPost: it never
  stamped gradedOn, so a graded staged lot would sit in the Grading stage forever — now
  now.slice(0,10), pinned in b3.test. PO side: ScanInput + select of acknowledged/received
  orders (scan of a draft/sent order explains po_not_acked instead), per-line
  ordered/received/still table ("Receive this" seeds product+qty+rate), and the GRN-first
  link-second order: poId rides the GRN doc, and an effect links any poId-carrying GRN the
  order's list lacks (createGrn's returned id is unreliable under stubbed/concurrent setState —
  the poId sweep also self-heals a link that never landed; cas_version reloads and retries).
  Link failure surfaces a note; the receipt is never lost (append-once linkage). useDraft
  remembers last vendor + storage area. Gates: tsc -b, 1032 passed (+18), lint 10 (baseline),
  build pass.
- 2026-10-14 WORKFLOW W7. The Coconut Grading form — a fifth Procurement tab ("Grade coconuts",
  pipeline flag, lazy chunk) and the client half of POST /api/grading, which existed since B3
  with no form to call it. OPEN QUESTION from STATE solved by the snapshot ride-along (contracts
  v1.6): d1Snapshot now selects the documents version column and attaches it onto grns at parse
  time (grns only; the COLUMN overwrites any stale round-tripped embed; Grn.version is read-only,
  the write paths preflight their own versions) — the grading form's expectedVersion reads
  grn.version, no new GET. gradingStage.ts: pendingGrading (same predicate as the pipeline tile,
  oldest first), gradingInput (the staged lot re-priced as a gate-graded GrnInput) so the form's
  whole client check is priceGrn with the write path's own words and QTY_EPSILON; remainingToSort
  live hint. GradingTab: queue select + lot-number ScanInput, a/b/c/reject + free override
  (defaults to the gate's count, as the endpoint does), priced preview; after 200 the lot is
  hidden locally and the snapshot's gradedOn confirms it — the server's paired Grading ledger
  lines are never re-derived client-side. cas_version surfaces as "changed after you read it";
  already_graded drops the lot from the queue. Pipeline's Grading tile rows now href
  /procurement?tab=grading. Gates: tsc -b, 1041 passed (+9), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W8. The Extraction stage form — a third Production card ("Run a pressing",
  pipeline flag, lazy chunk; ?stage=run, the pipeline Extraction tile's rows link in with
  ?run=<id> pre-picked). Two writes through machinery that already exists: the run posts
  through the SAME Classic createBatch path the old form used (checkBatch answers first, in its
  own words; stock moves; one QC record per output), then POST /api/transformations/close files
  the mandatory spoilage and stamps the server-computed mass balance. Contracts v1.7: the v1.6
  snapshot version ride-along now covers batches too (Batch.version read-only, column over any
  stale embed; d1Engine.test pins both) — the close's expectedVersion reads it, and the form
  NEVER guesses version 1: after createBatch it waits for the snapshot copy that carries the
  version (the commit's own revision bump wakes the feed — a tick, not a poll), with a "Leave
  it open" escape if the wait stalls. extractionStage.ts folds: pressableLots (the Classic
  rmLots rule verbatim — Available-only, NOT canConsumeLot, because that guard answers
  blend/pack/dispatch while checkBatch judges sources against ['Available']; quarantined raw
  would be offered then refused), extractionReasonCodes (frozen DECISIONS #3 seeds,
  extraction+any stages; the server's editable spoilage_reasons stays the authority and the
  422 is its word), massBalanceItemsOf (the close endpoint's own items fold), openExtractionRuns
  (the pipeline tile's predicate + 'Closed', pinned to pipelineStages' count under test),
  runMassLines (client mirror of rulesGate.batchLines incl. the waterLitres/malaiKg fallback).
  ExtractionTab: graded-lot select + ScanInput (pooled by lot), outputs prefilled off the
  picked lot via bulksFrom (water main, malai by-product — numbers confirmed, not named),
  cost-seat select, mandatory spoilage (spoiled-at-press count + reason, optional kg/L loss
  lines), MassBalanceBar live over the same items fold (built on the SHELL primitive — the
  balance is never re-derived), useDraft remembering the cold room + usual reason. Queue mode:
  an already-open run reads its inputs/outputs back read-only and closes with only the spoilage
  asked. Vocabulary: pipeline.ts + navBadges.ts CLOSED_BATCH gain 'Closed' (what the close
  stamps) and the Classic register filter offers it — otherwise a closed run would still count
  as open work. Gates: tsc -b, 1047 passed (+6), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W9. The Blend stage form — a fourth Production card ("Run a blend",
  pipeline flag, lazy chunk; ?stage=blend, the pipeline Blending tile's open runs link in
  with ?run=<id> pre-picked). STATE's open question answered as it predicted: a coconut-milk
  run IS a blend run — the form offers every ACTIVE recipe (B1 seeded no melanges; which one
  is milk is live data, so none is named), posts kind 'Melange' through the SAME createBatch
  the Classic form uses, and the run lands in the pipeline Blending queue, which is honest.
  blendStage.ts folds: blendableLots (the Classic form's own pool verbatim — Semi Finished +
  direct-use raw, DRAWABLE statuses, pooled by lot; quarantine bulk IS offered because the
  write path accepts it, and press-only raw is NOT because checkBatch refuses it — the
  anti-double-consumption edge), blendReasonCodes (frozen blend+any seeds), openBlendRuns
  (pinned to pipelineStages' Blending count incl. 'Closed'), activeRecipes. Form: recipe
  select lays out one draw row per component in recipe order (Classic's pickRecipe), lot
  select per row + ScanInput (a scanned lot fills a same-component row first), Classic's
  incomplete-draw and no-stock refusals verbatim before checkBatch answers, offRecipe
  >2-points note, drawn-by-uom gap as the spoilage placeholder, mandatory close-time
  spoilage (stage 'blend'), MassBalanceBar live over the SAME items fold (massBalanceItemsOf/
  runMassLines shared from extractionStage — one implementation), useDraft remembering the
  cold room + usual reason. A blend batch books spoiled: 0 exactly as the Classic form posts
  it — the durable spoilage record is the close's (mandatory there). Close queue mode reads
  a run back read-only and asks only the spoilage. extractionApi.ts renamed runCloseApi.ts
  (it was never extraction-only). Contracts stay v1.7: every wire the form uses existed.
  Gates: tsc -b, 1051 passed (+4), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W10. The Packing stage form — a fifth Production card ("Run a
  packing", pipeline flag, lazy chunk; ?stage=pack). ONE write through machinery that
  already exists: createPackingRun, the SAME Classic path the Packing register uses —
  there is NO close step (a packing run posts complete, which is why the pipeline
  Packing tile stays an activity tile and this form has no queue mode). Contracts stay
  v1.7 (no new wire). packingStage.ts folds: fillableBulk (Classic's `fillable`
  verbatim — a retired-only pack keeps the bulk offered so the empty state can
  explain), bulkByBatch/packableBatches (the rows checkPacking itself draws —
  DRAWABLE, so rejected bulk is invisible exactly as its refusal says; the W8
  pressableLots lesson), packsForBulk (the product master's own: bulkItemOf, retired
  hidden, clashing labels named apart — both of a clash, the dropdown's own rule),
  isLoosePouch (the §3.3-6 free-text formats BiB/Pouch). Form: bulk select with
  per-bulk batch counts (one fillable bulk auto-picks), batch select + ScanInput (a
  scanned BAT id finds the batch under ANY fillable bulk and switches the bulk),
  pack-lines repeater with per-line bulk draw, materials preview IS packingNeeds —
  the same walk the save gate runs — with shortfall flags, control-sample rows
  (Classic's own fields incl. the other-container arm and its "pick what each was
  filled into" refusal verbatim), useDraft remembering the usual room, and the BIB
  note when a pouch format is picked: stored loose, the pouch is the tracked unit,
  cartons are decided at dispatch — never here (§3.3-9 stays dispatch-time, so no
  carton logic exists in packing). Client gate = checkPacking's own words first,
  then createPackingRun re-checks. Gates: tsc -b, 1056 passed (+5), lint 10
  (baseline), build pass.
- 2026-10-14 WORKFLOW W11. The QC test-entry form — a "Test entry" tab on Quality behind
  the pipeline flag (lazy chunk; Classic register untouched when off; the pipeline QC tile's
  rows now link /quality?tab=entry). NO new write: the form posts through the SAME saveQc
  the register's Review dialog uses, which decides the disposition from the results
  themselves (qcDecision), moves stock in place (Released/Rejected; anything else back to
  awaiting QC), rolls the batch up, and owns the hold-area refusal toast (a null return
  leaves the form open). qcStage.ts is one fold: pendingQc — the tile's own Pending
  predicate, oldest batch first, count pinned to pipelineStages under test (a record whose
  batch is missing keeps its blank date sorting first, as the tile ages it). The form:
  queue select + ScanInput (batch or QC id; a scan of a two-record batch says the sibling
  stays queued), one qc-review-card per testsShownFor test (status select in statusLabel
  words, note), and the decision preview IS qcDecision — the register modal's own sentence
  (outstanding required tests named via categoryTitle, packs-vs-bulk consequence) — so the
  form can never promise a disposition the save would not stamp. After a save the form
  advances to the next-oldest record. Lab reports/evaluations attach from the register's
  Review (upload + generated-report machinery stays there); raising records for
  pre-per-product batches stays on the register too (startQc) — every batch posted since
  gets its records on booking. Contracts stay v1.7 (no new wire). Gates: tsc -b, 1059
  passed (+3), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W12. The Control Sample destruction shelf — a "Destruction shelf" tab
  on Control Samples behind the pipeline flag (lazy chunk; Classic register untouched when
  off; the pipeline Control samples tile's rows now link /control-samples?tab=shelf).
  Samples are recorded on the packing run that kept them back (W10's form) and are NEVER
  stock; the only thing a kept sample still owes is its destruction date, so that is the
  form's one question. NO new write: it posts through the SAME updateControlSample the
  register's Mark Destroyed uses (refusals are its own toasts — before the production day,
  future day, clearing who collected them; the date input bounds itself exactly as the
  register dialog does, min producedOn max today). sampleStage.ts is one fold: dueSamples —
  the tile's own kept-and-inside-the-7-day-horizon predicate (controlSampleRows/sampleStatus,
  never re-derived), ordered NEAREST EXPIRY FIRST (past-expiry first — the tile's expiry
  flag names exactly them), count pinned to pipelineStages under test. The form: shelf
  select + ScanInput (run or batch id), picked sample shows product/bottles/produced/expiry
  with a past-expiry warning-note, destroyedOn defaults to TODAY on pick (the shelf's one
  job starts filled), collectedBy/remark editable, and after a save the form advances to
  the next sample. Contracts stay v1.7 (no new wire). Gates: tsc -b, 1061 passed (+2),
  lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W13. The Storage put-away form — a "Put away" tab on Inventory behind
  the pipeline flag (lazy chunk; Classic snapshot untouched when off). The queue is NOT the
  pipeline Stock tile's held lots (its design-note guess) — checked first, and held lots owe
  nothing a move can pay: a Quarantine lot owes a verdict (W11's bench) and Rejected stock
  parked in a hold area owes a write-off (Stock Issues); a move changes where stock sits,
  never its QC status. The honest queue is stock the app's OWN rules flag where it sits:
  storageStage.putAwayRows = areaRefusal (an area that no longer takes it — e.g. a Released
  lot still standing in a hold area, the exact stock saveQc's "move it back out" refusal
  names, or a room whose master is gone) → a deactivated room (the state areaDeleteBlocker's
  "deactivate it instead" advice leaves behind) → roomSuits' merely-unusual home (the same
  flag every picker shows), worst first, soonest expiry within a band. NO new write: the
  form posts through the SAME moveStock the Move dialog uses (two Stock Transfer lines +
  audit; its refusals are its own toasts); destinations ARE areaChoices and the unusual-
  destination warning IS roomSuits — the dialog's own folds, never re-derived. qty defaults
  to the whole row (put-away carries the pallet), scan matches stock ID / lot / item name.
  pipeline.ts untouched: the Stock tile's held rows keep href /inventory — re-pointing them
  at a move form would lie about what they owe. Contracts stay v1.7 (no new wire). Gates:
  tsc -b, 1065 passed (+4), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W14. The Order stage form — an "Order desk" tab on Orders behind the
  pipeline flag (lazy chunk; Classic register untouched when off; the pipeline Orders tile's
  rows now link /orders?tab=desk). orderStage.openOrderRows = the tile's own Open predicate,
  soonest ship-by first with overdue (the tile's flag) at the head and undated last, count
  pinned to pipelineStages under test; each line is held against releasedPacksBySku — the
  dispatch path's own pool (Released, hold areas unofferable) — as a GUIDE, never a
  reservation, with the register modal's own all-or-nothing words. NO new write: raise and
  edit both post through the SAME saveOrder; its refusals are its own toasts. The draft
  rebuild and flatten (openEdit's inline picked/formats/qtys + the onSave flatten loop) were
  EXTRACTED into ordersView.ts as draftFromOrder/linesFromDraft — one implementation, the
  Classic modal and the desk both call them now. The desk's form mirrors the modal's own
  drinks/formats/qtys blocks (drinkCatalog + resolveBlocks, orphan blocks included), the
  client checks ask saveOrder's own questions (customer, ship-by, ≥1 line), and useDraft
  remembers the last customer. Dispatch itself is NOT here — it is W15's form (with the
  §3.3-9 packaging step). Contracts stay v1.7 (no new wire). Gates: tsc -b, 1069 passed
  (+4), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W15. The Dispatch stage form — a third "Dispatch" tab on Orders behind the
  pipeline flag (lazy chunk; ?id=<order> pre-picks, the desk's "Dispatch this order" links in).
  NO new write: it posts through the SAME dispatchOrder the register's Dispatch modal uses —
  picks seeded by the modal's own seedAllocations (oldest released stock first), vehicle
  remembered by useDraft, refusals are its own toasts (short line, "only N left", hold-area
  stock), and a null return leaves the form open. The modal's inline picks→allocations /
  allotted meter / short-line folds were EXTRACTED into ordersView.ts as
  allocationsFromPicks / allottedFor / shortLineOf — one implementation, the Classic modal
  and the dispatch form both call them (the W14 draftFromOrder precedent) — pinned by a
  reconciliation test (seed → unpack → checkOrderDispatch ACCEPTS, rows oldest-expiry-first).
  Client checks mirror only the all-or-nothing question (shortLineOf disables the button);
  per-lot "only N left" stays the save's own word. After a dispatch the form advances to the
  next open order, seeded exactly as a pick seeds it. Cartons NOT decided here: §3.3-9's
  BOXED/LOOSE/carton suggestion needs a carton master that does not exist (AUDIT: PARTIAL) —
  deferred to SHIPMENT-era, as the design note ruled. The pipeline Orders tile keeps
  href /orders?tab=desk (a short order owes an edit only the desk offers; the desk's card
  links onward once the order fills); the Dispatch tile's in-flight rows keep /dispatch
  (they owe a POD, not a dispatch). Contracts stay v1.7 (no new wire). Gates: tsc -b,
  1072 passed (+3), lint 10 (baseline), build pass.
- 2026-10-14 WORKFLOW W16 — Onboarding, the last Phase-3 item. All behind the pipeline
  flag; Classic untouched; NO new write anywhere (tour/feedback state is device-local).
  onboarding.ts is the ONE wording source: PAGE_HELP (one line per catalog page — feeds
  the sidebar's native-title tooltips AND the cheat sheet; coverage test pins every page)
  and STAGE_HELP (every pipeline tile's "what this count means"; pinned to the stage ids
  pipelineStages emits). First-run tour: once per device (roligt_tour_done_v1), offered
  the moment the pipeline flag reaches an operator; "?" beside search replays it.
  Tour.tsx spotlights the shell's own data-tour anchors (pipeline row, process nav,
  search, theme, help); a step whose anchor is missing or measures zero (phone drawer,
  off flag) renders a centered card — the tour never depends on the viewport, and it
  never spotlights at 0,0. Keyboard: →/← walk, Esc ends, focus rides Next. HelpMenu.tsx:
  "?" popover (tour / cheat sheet / feedback). The cheat sheet IS the caller's pages —
  roles are runtime data, so "your role's cheat sheet" is one line per screen they hold,
  in sidebar order (cheatSheetRows), grouped like the nav; the prompt's named-role pages
  live printable in docs/overhaul/cheatsheets/ (8 roles; delivery-agent honestly marked
  not-live-until-Phase-4). Feedback: textarea → clipboard copy (toast confirms, failure
  keeps the words and says how to copy by hand) + a device outbox (last 20) — NO
  endpoint invented (DECISIONS W16). Gates: tsc -b, 1077 passed (+5), lint 10
  (baseline), build pass. Phase 3 WORKFLOW complete: next is QA LIGHT re-run + HEAVY
  once (Journey A through dispatch) in a fresh session.
- 2026-10-15 QA W17 — Phase 3 close-out: LIGHT re-run + HEAVY once, both green; QA_REPORT.md
  delivered (first one — duty 7). HEAVY: Journey A 10/10 through dispatch + genealogy (boot
  1/1) on the e2e harness; the spec's settle guard (per-tab spill keys → clean mirror, 90s)
  is what makes the throttle-queued late legs honest, and failOnPageErrors now exempts the
  commit CAS 409 (refused-whole/adopt/re-save protocol event) alongside 429. LIGHT on the
  full diff: tsc -b clean, 1080 passed (+3 sync regression), lint 10 (baseline), build +
  build:e2e + assert-no-apptics clean. Lighthouse (§5): a11y 98/100/100 on
  pipeline/production/orders after fixing FOUR real defects Lighthouse found: Select
  forwarded no aria-label (nameless comboboxes, 8 call sites), the desk quick-order
  form's Customer/Order-date/Ship-by were unnamed (Orders' raise-order modal too),
  bottom-nav "More" name didn't contain its visible text, and 13 type-tabs strips
  declared role=tablist they never honoured (role removed — they are button strips).
  §6 visual: 39 screenshots (13 screens × 3 widths) in .artifacts/screenshots/, zero
  horizontal scroll (measured), zero color-only chips; perf mobile-sim 64-65 is the
  218KB snapshot boot over simulated slow 4G (TBT 0/CLS 0), desktop preset 96 with
  FCP 0.9s — inside the <2s-LAN duty; snapshot size/split is a Phase-6 item. QA
  observation filed (no action): toasts say Posted while the commit throttle still
  queues the write — "saved on this device / queued" state is a Phase-6 UX item.
  Phase 3 CLOSED. Next: Phase 4 SHIPMENT in a fresh session.
