# PROGRESS — Beverage Ops Platform Overhaul
Updated: 2026-10-14 | Branch: dev | Base commit: de4c13b | Phase 3 WORKFLOW through W9

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
