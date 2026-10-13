# STATE — Beverage Ops Platform Overhaul
Updated: 2026-10-14 | Phase: 3 WORKFLOW in progress — W1–W6 done (Pipeline Home, Batch Detail, PO endpoints, PO form, GRN↔PO linkage, Receipt stage form); W7 Coconut Grading form next | Branch: dev | Base: de4c13b

## Contracts
- v1.5 (2026-10-13, W5): +POST /api/purchase-orders/:id/receive (GRN↔PO linkage);
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

## W7 design notes (next slice — Coconut Grading form, read before building)
- The client form for POST /api/grading (staged lots W6 now creates). Pipeline's Grading stage
  tile (pipeline.ts id 'grading') currently hrefs '/procurement' — point its rows at the form.
- OPEN QUESTION to solve first: the endpoint wants expectedVersion against the D1 documents
  version, but client state carries no grn versions. Either ride versions on /api/snapshot's
  grns (additive; check d1Snapshot.ts first) or add a GET. Prefer the snapshot ride-along —
  one read, no new endpoint, matches how flags ride.
- Form: pick a pending staged lot (gradingMode 'staged', !gradedOn), grades a/b/c/reject must
  sum to the counted total (same QTY_EPSILON wording as priceGrn), optional free override.
  After 200 the lot leaves the Grading queue (gradedOn) — the ledger's paired Grading lines
  (Quarantine→Available/Rejected) are the server's, never re-derived client-side.
- If the PO link from W6 is still pending on a lot (GRN has poId but the PO lacks it),
  the ReceiptTab sweep heals it on next visit — no grading-form involvement needed.

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
- If the split (multi-file) prompt version is adopted: do NOT copy its STATE/PROGRESS/DECISIONS
  templates over the live files, and rename its DOMAIN.md (business rules) before adding — the live
  DOMAIN.md is the current-state map and they collide.
