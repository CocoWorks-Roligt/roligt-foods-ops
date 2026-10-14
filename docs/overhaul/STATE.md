# STATE — Beverage Ops Platform Overhaul
Updated: 2026-10-14 | Phase: 3 WORKFLOW in progress — W1–W7 done (Pipeline Home, Batch Detail, PO endpoints, PO form, GRN↔PO linkage, Receipt stage form, Coconut Grading form); W8 Extraction stage form next | Branch: dev | Base: de4c13b

## Contracts
- v1.6 (2026-10-14, W7): +GrnVersionExtension — the D1 snapshot's grns carry documents.version
  (read-only ride-along, attached at snapshot parse; POST /api/grading's expectedVersion reads it);
  v1.5 (2026-10-13, W5): +POST /api/purchase-orders/:id/receive (GRN↔PO linkage);
  v1.4 (2026-10-13, W4): +PurchaseOrderVersionExtension (PO responses carry documents.version);
  v1.3 (2026-10-13, W3): +purchase-order wire shapes; v1.2 (2026-10-13, B4): +RevisionEvent (SSE); v1.1 (2026-10-13, LEAD): src/lib/contracts.ts — frozen v1 plus additive deltas (challan, recipeId, avgUnitWeight naming → file header + ARCHITECTURE.md §8). WORKFLOW builds against v1.5.

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

## W8 design notes (next slice — Extraction stage form, read before building)
- The client form for the extraction run: multi-output (water/malai/by-product) + MANDATORY
  spoilage, posting through the B3 close machinery (POST /api/transformations/close; contracts
  §-transformation). The SHELL TransformationForm primitive (live computeMassBalance) already
  exists — build the page on it, do not re-derive mass balance.
- batch_v2 stays OFF (DECISIONS #2: 3/14 historical batches close at 2%; the decision on
  unaccounted-loss/per-material tolerance/warn-first is open). Whatever form is built must run
  under the pipeline flag and read the CURRENT vocabulary (Classic Extraction batches +
  rulesGate close answers), exactly as W1/W2 did — the v2 run machine waits for the flag.
- Inputs: graded coconut lots (the Grading form's output — Available stock rows via
  canConsumeLot per lot, as W2's QC gate reads). Recipe/BOM templates are versioned plain data
  (ARCHITECTURE) — check what B1 stamped on items/melanges before wiring recipe variance.
- Spoilage reason codes are per-stage editable reference data (spoilage_reasons collection,
  B3 tests seed them) — offer the extraction stage's own codes only.

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
- If the split (multi-file) prompt version is adopted: do NOT copy its STATE/PROGRESS/DECISIONS
  templates over the live files, and rename its DOMAIN.md (business rules) before adding — the live
  DOMAIN.md is the current-state map and they collide.
