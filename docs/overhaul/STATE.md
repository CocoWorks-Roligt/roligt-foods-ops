# STATE — Beverage Ops Platform Overhaul
Updated: 2026-10-14 | Phase: 3 WORKFLOW COMPLETE — W1–W16 done (Pipeline Home, Batch Detail, PO endpoints, PO form, GRN↔PO linkage, Receipt stage form, Coconut Grading form, Extraction stage form, Blend stage form, Packing stage form, QC test entry form, control sample destruction shelf, Storage put-away queue, Order desk, Dispatch stage form, Onboarding); next: Phase 3 QA LIGHT re-run + HEAVY once (Journey A through dispatch) | Branch: dev | Base: de4c13b

## Contracts
- v1.7 (2026-10-14, W8): +BatchVersionExtension — the snapshot's batches carry documents.version
  too (read-only ride-along, column over stale embed; the close form's expectedVersion reads it);
  v1.6 (2026-10-14, W7): +GrnVersionExtension — the D1 snapshot's grns carry documents.version
  (read-only ride-along, attached at snapshot parse; POST /api/grading's expectedVersion reads it);
  v1.5 (2026-10-13, W5): +POST /api/purchase-orders/:id/receive (GRN↔PO linkage);
  v1.4 (2026-10-13, W4): +PurchaseOrderVersionExtension (PO responses carry documents.version);
  v1.3 (2026-10-13, W3): +purchase-order wire shapes; v1.2 (2026-10-13, B4): +RevisionEvent (SSE); v1.1 (2026-10-13, LEAD): src/lib/contracts.ts — frozen v1 plus additive deltas (challan, recipeId, avgUnitWeight naming → file header + ARCHITECTURE.md §8). WORKFLOW builds against v1.7.

## DB target — CONFIRMED 2026-10-13 (audit slice 3)
- Unit/integration: local better-sqlite3 in-memory against real `scripts/d1/schema.sql` (what `npm test` does).
- Remote integration/smoke: `roligt-ops-scratch` (D1 id 28356095-…, staging, verified copy of prod @ 2026-10-12 cutover). `.env` pins scratch.
- PROHIBITED: `roligt-ops-prod` (id de8175f2-…) — never execute, never point scripts at it. Prod schema applies only at deploy time by the user.
- Schema changes = additive edits to `scripts/d1/schema.sql` (no migrations dir); re-apply to scratch via
  `npx wrangler d1 execute roligt-ops-scratch --remote --file scripts/d1/schema.sql --yes`; refresh views `node scripts/d1/views.mjs`.
- Live smoke (opt-in, writes+cleans on scratch): `D1_SMOKE=1 npm test`.
- Prod-like local copy: `npx wrangler d1 export roligt-ops-scratch --remote --output scripts/d1/dump-<date>.sql`, load `--local` only.
- Never print secret values; mask tokens in command output.

## Locks
- none

## W16 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Onboarding behind the pipeline flag: first-run tour (once per device,
  roligt_tour_done_v1; "?" replays), tooltips = native title from the ONE source
  (PAGE_HELP/STAGE_HELP, onboarding.ts — coverage-tested), cheat sheet = the caller's
  own pages ("?" → My cheat sheet; printable per-role pages in cheatsheets/), feedback =
  clipboard + local outbox, NO endpoint (DECISIONS W16). Tour step with a missing/hidden
  anchor renders a centered card, never skipped.

## After W16 — Phase 3 close-out (next session)
- QA LIGHT re-run on the W16 diff (gates were green at slice end: tsc -b, 1077 tests,
  lint 10 baseline, build), then HEAVY once: Journey A as far as it exists (coconut PO →
  … → dispatch; signature/challan legs wait for Phase 4). No Playwright exists yet —
  decide browser-E2E tooling + one-line DECISIONS entry before writing HEAVY journeys
  (dev-only dep, needs justification). Multi-viewport screenshots + Lighthouse per QA §6.

## W15 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Dispatch form = 3rd Orders tab behind pipeline; posts through the SAME dispatchOrder
  over the modal's own folds (seedAllocations + the extracted
  allocationsFromPicks/allottedFor/shortLineOf); cartons deferred (no carton master —
  SHIPMENT-era §3.3-9); Orders tile rows stay /orders?tab=desk, Dispatch tile rows stay
  /dispatch (in-flight dispatches owe a POD, not a dispatch write).

## W14 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Order desk = "Order desk" tab on Orders behind pipeline; open orders in ship-by order
  (overdue first) each line vs releasedPacksBySku as a guide; raise/edit through the SAME
  saveOrder; draftFromOrder/linesFromDraft extracted to ordersView (Classic modal shares
  them); the Orders tile's rows link /orders?tab=desk.

## W13 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Put-away = "Put away" tab on Inventory behind pipeline; posts through the SAME moveStock;
  queue = the app's OWN flags where stock sits (areaRefusal → inactive room → roomSuits
  unusual), NOT the Stock tile's held lots (they owe a verdict/write-off, not a move —
  tile rows keep href /inventory).

## W12 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Destruction shelf = "Destruction shelf" tab on Control Samples behind pipeline; posts
  through the SAME updateControlSample; dueSamples pinned to the tile's kept-in-7-day
  predicate, nearest expiry first; samples stay NEVER-stock (no inventory write exists).

## W11 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- QC test entry = "Test entry" tab on Quality behind pipeline; posts through the SAME
  saveQc (disposition computed by qcDecision, never picked); pendingQc pinned to the
  tile; reports/raising records stay on the register.

## W10 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Packing form = 5th Production card behind pipeline; ONE write through the SAME
  createPackingRun (no close — a run posts complete, so no queue mode and the
  pipeline Packing tile stays an activity tile); pools = the write path's own folds
  (DRAWABLE bulk by batch, product master's packs); cartons never touched
  (dispatch-time decision, §3.3-9).

## W9 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Blend form = 4th Production card behind pipeline; offers every ACTIVE recipe (milk among
  them — B1 seeded none, so none is named), posts kind 'Melange' via the SAME createBatch
  (spoiled: 0, Classic contract — the close's spoilage records are the durable word), then
  closes via runCloseApi; component pool = the Classic form's own DRAWABLE fold.

## W8 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Extraction form = 3rd Production card behind pipeline; posts through the SAME createBatch,
  then closes via POST /api/transformations/close; batch version rides the snapshot (v1.7);
  sources follow checkBatch's Available-only pool (NOT canConsumeLot — deliberate, logged).

## W7 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Grading form = 5th Procurement tab behind pipeline; grn version rides the snapshot (v1.6);
  queue = same predicate as the pipeline tile; costs/ledger stay the server's.

## W6 notes (done 2026-10-14 — kept one line: see PROGRESS log)
- Receipt form = 4th Procurement tab behind pipeline; variants per item procurementForm;
  staged loads book whole into ledger 'Quarantine' via the same createGrn; PO link is
  GRN-first (poId rides the doc), then receivePurchaseOrderCall via the poId sweep effect.

## Rollback markers
- Phase 0 touches docs/overhaul/* only. Rollback = remove those files.

## Invariants watch
- tsc gate is `tsc -b` (root tsconfig is solution-style; `tsc --noEmit` checks nothing).
- api-imported src/lib files need .ts import extensions (the numbering/grn/stockIds closure now has them — keep it that way).
- User-facing word is "blend(s)", never "melange" (code/data names may keep it).
- Flags are a D1-engine concern only: gated endpoints 503 when D1 env is unset (postRoutes), and the
  Zoho commit arm never reads the flags collection. Never enable qc_gate_v2/batch_v2 on any deployment
  that can still reach Zoho (engine deletion planned 2026-10-19); flag toggles are LEAD-only until then.
- batch_v2 stays OFF everywhere until the mass-balance decision lands (DECISIONS #2: 3/14 historical
  batches pass at 2% — extraction cannot close under enforcement today).
- shell_nav (and every UI flag) rides /api/snapshot as raw rows folded through the isomorphic
  readFlags — client and server can never disagree. Hand-staging a flag row does NOT bump
  app_revision: a staged flag lands on the next poll/SSE-driven snapshot (≤20 s), it cannot force one.
- useRevisionFeed is ONE EventSource per tab (module-level singleton + subscriber set). Do not add
  another EventSource consumer for the same feed — subscribe through the hook (browser cap ~6/tab).
- Staged receipts (gradingMode 'staged', W6) book the WHOLE load into ledger status 'Quarantine'
  with grades zero; only POST /api/grading may stamp grades/gradedOn (paired Grading lines move
  the load out). Classic updateGrn refuses typed grades and re-counts on staged docs — keep that
  refusal if the edit path is ever reworked; a staged lot is deleted-and-re-received, not edited.
- ReceiptTab's PO link must stay GRN-first, link-second (poId rides the GRN doc; the sweep effect
  links any poId-carrying GRN the PO's receivedGrnIds lacks — do not swap in createGrn's return
  value as the grnId; it is 'ok' whenever the setState updater does not run eagerly).
- The grn version ride-along (v1.6) is READ-ONLY: attached at snapshot parse for grns only, the
  documents.version COLUMN overwrites any stale embedded value, and no write path consults the
  field (client writes preflight their own versions server-side). Keep it that way if the
  snapshot or grading paths are reworked; and the grading form never derives costs or ledger
  lines client-side — priceGrn is a preview, the endpoint's math is the record.
- The batch version ride-along (v1.7) is READ-ONLY the same way (batches too, column over
  stale embed, no write path consults the field). The stage close forms (ExtractionTab,
  BlendTab) NEVER guess
  version 1: after createBatch they wait for the snapshot copy that carries the version (the
  commit's own revision bump wakes the feed), with a "Leave it open" escape — keep that if
  either form is reworked.
- CLOSED_BATCH in pipeline.ts AND navBadges.ts includes 'Closed' (what the close endpoint
  stamps): the two sets must stay in step or a closed run keeps counting as open work.
  openExtractionRuns (extractionStage.ts) and openBlendRuns (blendStage.ts) mirror them,
  each pinned to pipelineStages' count under test.
- A blend batch books spoiled: 0 — the Classic contract; a blend's loss is implied in the
  balance and the durable spoilage record is the close's (mandatory there). BlendTab's
  component pool (blendableLots, blendStage.ts) mirrors the Classic form's own DRAWABLE
  fold exactly: quarantine bulk is drawable and offered, press-only raw is not (checkBatch
  refuses it — the anti-double-consumption edge). Keep both if the blend paths are reworked.
- Stage forms offer spoilage reasons from the frozen SPOILAGE_REASON_SEEDS (their stage +
  'any'); the server's editable spoilage_reasons collection stays the authority and the
  close's 422 is its word — never read spoilage_reasons client-side.
- The Packing stage form (PackingTab) posts through the SAME createPackingRun and has NO
  close or queue mode: a packing run posts complete. The pipeline Packing tile stays an
  activity tile (runs posted today) whose rows link the register — do not convert it to a
  queue unless a close concept is added. packingStage.ts pools mirror the write path
  (bulkByBatch = checkPacking's own DRAWABLE rows; packsForBulk hides retired packs while
  fillableBulk keeps a retired-only bulk offered — Classic's own fold), and packing never
  counts a carton: the carton decision is dispatch-time (§3.3-9, SHIPMENT-era).
- The QC test-entry form (QcEntryTab) posts through the SAME saveQc and the disposition is
  COMPUTED, never picked: the form's live preview IS qcDecision (the same fold the save
  runs) — never re-derive a verdict or a required-tests list client-side. saveQc's
  hold-area refusal is its own toast; a null return must leave the form open. pendingQc
  (qcStage.ts) is pinned to the pipeline QC tile's count, and the tile's rows link
  /quality?tab=entry — keep the two in step if either is reworked. Lab reports and
  evaluations attach only from the register's Review, and startQc (raising records for
  pre-per-product batches) stays register-side.
- Control samples are NEVER stock (controlSamples.ts's own law): they draw bulk and
  packing material on the packing run and from then on are only a record — the
  destruction shelf (SamplesTab) writes nothing but updateControlSample. dueSamples
  (sampleStage.ts) is pinned to the pipeline samples tile's kept-in-7-days count and the
  tile's rows link /control-samples?tab=shelf — keep the two in step. No sample move,
  issue or dispatch path may ever exist.
- The put-away queue (putAwayRows, storageStage.ts) is ONLY the app's own flags where
  stock sits — areaRefusal, a deactivated area, then roomSuits' unusual home — and NEVER
  the pipeline Stock tile's held lots: quarantine owes a QC verdict, hold-area stock owes
  a write-off, and moveStock changes where stock sits, never its QC status. The form
  (PutAwayTab) posts through the SAME moveStock with destinations from areaChoices
  verbatim — do not add a stricter placement rule client-side, and do not re-point the
  Stock tile's held rows at it.
- draftFromOrder/linesFromDraft (ordersView.ts) are the ONE order-draft rebuild/flatten —
  the Classic raise/edit modal and the Order desk both call them; keep them in step if
  either form is reworked. The desk's fill preview is releasedPacksBySku (the dispatch
  path's own pool) as a guide only — never a reservation; openOrderRows stays pinned to
  the pipeline Orders tile's Open count, and the tile's rows link /orders?tab=desk.
- allocationsFromPicks / allottedFor / shortLineOf (ordersView.ts) are the ONE
  picks→allocation / allotted-meter / short-line fold — the Classic dispatch modal and
  the Dispatch stage form (DispatchTab) both call them; keep them in step if either is
  reworked. The dispatch form seeds from seedAllocations and its button is disabled by
  shortLineOf only — every other refusal ("only N left", hold-area stock) stays
  dispatchOrder/checkOrderDispatch's own toast. It never decides cartons: §3.3-9's
  BOXED/LOOSE/carton step needs a carton master (none exists — AUDIT: PARTIAL) and is
  SHIPMENT-era. The linked-?id effect must not re-seed on state changes under an open
  form (deps [linkedId] with the disable comment — a re-render must never wipe picks).
- PAGE_HELP / STAGE_HELP (src/lib/onboarding.ts) are the ONE wording source for the
  sidebar tooltips, the cheat-sheet rows and the tour's page claims; the coverage tests
  (every catalog page, every pipeline stage id) keep a tooltip from ever rendering blank.
  Tour state is device-local only (roligt_tour_done_v1); HelpMenu writes NOTHING
  server-side — feedback is clipboard + localStorage outbox (roligt_feedback_outbox,
  last 20); adding a feedback endpoint is a DECISIONS decision, not a code whim.
- The tour's anchor rule: a step whose `data-tour` anchor is missing or measures zero
  (phone's collapsed sidebar, an off flag) renders as a centered card — never skipped,
  never spotlit at 0,0. Keep that if the tour is reworked.
- If the split (multi-file) prompt version is adopted: do NOT copy its STATE/PROGRESS/DECISIONS
  templates over the live files, and rename its DOMAIN.md (business rules) before adding — the live
  DOMAIN.md is the current-state map and they collide.
