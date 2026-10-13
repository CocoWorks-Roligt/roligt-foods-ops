# AUDIT.md — baseline at dev @ de4c13b (2026-10-13)
Sources: audit slices 1-3. Sections 8-11 (flow trace, friction, assumptions verdicts, risks) appended by slice 2.

## 1. Baseline gates (slice 3)
- `npm test` (vitest 2.1.9): **67 files passed / 1 skipped (live D1 smoke, opt-in); 745 tests passed, 7 skipped, 0 failed**, 3.4s.
- `npx tsc -b` PASS ~6s (solution-style tsconfig; `--noEmit` checks nothing). `npm run lint` (oxlint) PASS, 10 known warnings.
- `npm run build` (tsc -b && vite build && assert-no-apptics) PASS ~7s; main 284.76 kB + jspdf 399.95 kB; PWA precache 83 entries.
- No CI config; gates are local/manual. No E2E framework, no RBAC-matrix/a11y/visual tests.

## 2. Structure
- React 19 SPA (Vite 8, TS, react-router-dom 7, vite-plugin-pwa, jspdf, d3-force). **No component library**; hand-rolled CSS.
- Backend: Vercel functions in `api/` (BFF): WorkOS AuthKit, better-sqlite3/jose dev-side, nodemailer.
- Persistence seam `api/_lib/store.ts`: **Cloudflare D1** (REST via `api/_lib/d1.ts`) with Zoho Tables legacy fallback (`api/_lib/zoho.ts`; engine deletion planned from 2026-10-19). Files in R2 (`api/_lib/r2.ts`, presigned).
- **Document store**: physical tables only `documents`(collection,id,json,version,updated_at), `meta`, `counters`, `_assert_changed` in `scripts/d1/schema.sql` (idempotent, no migrations dir). Logical wire tables (26) in `src/lib/tables.ts` / `src/lib/registry.ts`.
- Frontend: `src/pages/*` (29 routes), `src/context/` (AppContext + 15 domain modules), `src/lib/` business logic isomorphic with api.
- Sync model: poll `/api/revision` ~20s → `/api/snapshot` (projected to caller's pages) → writes via `/api/commit` (diff changeset, per-table page gates). Offline mirror in IndexedDB (`src/lib/localDb.ts`) + outbox — client already offline-tolerant.

## 3. UI routes (src/App.tsx; catalog src/lib/pages.ts)
Sidebar tiers Operations / Masters / Settings / Administration; mobile bottom nav Dashboard·Procure·Produce·Quality.
- Operations: `/` plant dashboard; `/procurement` GRN intake (coconut grades a/b/c/reject + packing materials); `/roster`; `/production-planning`; `/production` (Extraction + Melange/blend stages); `/quality` (per-output QC, release gate); `/control-samples`; `/packing`; `/orders`; `/dispatch` (challan ref, vehicle, PoD name+photos, status); `/inventory`; `/packing-materials`; `/stock-issues`; `/storage` (Cold Room/Dry/Hold/NPD + moves); `/npd` (page.npd); `/stickers`; `/traceability` (farmer↔customer d3 graph); `/reports`, `/reports/live`, `/reports/:id`; `/audit`.
- Masters (tick-gated): `/vendors`, `/customers`, `/purchase-products` (materials/bulk/blends/packs/SKUs), `/test-parameters`, `/compliance`.
- Settings/Administration: `/settings` (tolerances, numbering series, label copy, retention); `/admin/users`, `/admin/roles`.
- Redirects: /melanges→/production?stage=melange; /masters→/vendors.

## 4. API endpoints (all auth via sealed session cookie)
- Auth: GET `/api/auth/start|callback|session`; POST `/api/auth/signout` (POST-only).
- Core sync: GET `/api/revision` (poll token), GET `/api/snapshot` (cached, page-projected, `withheld` list), POST `/api/commit` (diff changeset; per-table page/writePermission gates from `src/lib/tables.ts` + `api/_lib/commitGates.ts`; CSRF content-type check; throttle).
- Admin proxy (audited): GET/POST `/api/admin/roles`, `/api/admin/users`.
- Attachments: POST `/api/attachments/upload` (presigned R2 PUT), GET `/api/attachments/file` (page-gated 302).
- Compliance: GET/POST `/api/compliance/documents` (optimistic-version), `/api/compliance/upload|file`, GET `/api/compliance/remind` (cron 09:00 IST, Bearer CRON_SECRET).
- Writes are NOT per-resource REST: one changeset endpoint commits any wire table. New domain endpoints (transformation, shipment, challan) will need their own routes in existing style.

## 5. Wire tables (documents collections; src/lib/tables.ts)
vendors, customers, purchase_products, items (material master: type Raw/Packing/Semi Finished/Finished, uom, lotControlled, reorder, directUse, sourceItem, qcExempt), packs (D1-only master), products (SKU: bom[], packId, bulkItem, shelfLifeDays), melanges (blend recipes, unversioned), grns (receipt lots: grades a/b/c/reject/free/total, rate, landed cost, harvestedOn, farmer), batches (kind Extraction|Melange; sourceLines[] raw inputs, blendLines[] bulk inputs, outputLines[] multi-output w/ costShare, spoiled, wastage, yieldPerUnit, inputQty, qcIds[], status Released/Partly Released), packing_runs (lines, drawn bulk, pmCost, controlSamples[]), orders (lines sku+qty, status, challan string), qcs (per batch OUTPUT; tests{} map, disposition Pending/Retest/Rejected/Released, attachments), dispatches (per sku/batch line: challan, vehicle, status Dispatched/In Transit/Delivered/Partially Delivered, pod typed name, podPhotos[], times), stock_issues, lab_reports, test_parameters, staff/shifts/attendance, production_plans, sticker_templates/prints, storage_locations, **ledger** (append-only movements: type,doc,item,lot,location,status,qtyIn/Out,uom,unitCost,expiry,vendorId — all balances/trace fold from it), **audits** (insert-only), meta (app_config: tolerances, numbering, defaultAreas, testCategories, controlSampleDays), counters (series: grn, lot, batch, packing, qc, dispatch, order, challan…).
- Lot identity: string on grns/ledger; per-output stock IDs `BAT-…/2`, `PKG-…/1` (`src/lib/stockIds.ts`).

## 6. Exists-in-app checklist vs overhaul §3 targets
- transformation in/outputs: YES as batch document fields (not separate tables); recipes (melanges) unversioned.
- spoilage: PARTIAL — batch.spoiled/wastage; no reason codes, not mandatory, no photo.
- intermediates: PARTIAL — Semi Finished items + blend bulk are stock; no MAIN/CO_PRODUCT/BY_PRODUCT/INTERMEDIATE typing.
- cartons/packaging: PARTIAL — packs + Item.reorder; NO pouch→carton config, no boxed/loose decision, no atomic carton deduction.
- shipments/delivery events/returns: NO (dispatch record doubles as trip, one per line).
- signatures: PARTIAL — typed PoD name + photos; no canvas signature, no OTP.
- challans: PARTIAL — string ref + counter + sticker; no PDF challan document, no immutable versioning.
- audit log: YES. feature flags: NO mechanism (only Config values).

## 7. Auth/RBAC today
- WorkOS AuthKit (org "Roligt Foods", EU), PKCE + sealed httpOnly cookie; dev session fallback ALLOW_DEV_SESSION.
- Permissions = page slugs `page.<id>` (28, src/lib/pages.ts); roles in WorkOS: `app-admin` (all), `npd`, implicit Operator (signed-in, no slugs). Dev picker: Operator/QualityTester/Npd/Admin. **No delivery-agent or per-stage roles.**
- Server-side: every route authenticates; commit gates per wire table; snapshot withholds invisible tables; file URLs page-gated. SPA mirrors via RequirePage.

## 8. Flow trace — key findings (full per-domain trace in DOMAIN.md)
- **ARCHITECTURE FACT: no server-side business logic.** Client computes all state (`src/context/domains/*`, rules in `src/lib/posting.ts`); `api/commit` persists page-gated changesets. QC release, stock availability, over-draw prevention are CLIENT-ONLY; over-draw shows post-hoc (OverdrawBar). The overhaul's server-enforced gates are new work, not a tweak.
- Quarantine bulk is blendable (DRAWABLE includes Quarantine) but not packable — inconsistent gate.
- Rejected stock dead-ends in Hold Area (exit = Stock Issue write-off); "Retest" has no queue/task.
- No POs; dispatch is all-or-nothing per challan (`checkOrderDispatch`); no reservations, no partial shipment.
- Control samples are captured inside the packing modal only; no post-run additions.

## 9. Friction ranking (slice 2, top 12)
1. Orders all-or-nothing: one short line refuses whole dispatch; operator edits the order instead.
2. Dispatch allocation is row-key soup (`item|lot|location|expiry` per SKU); wrong expiry pick = "only 0 left" dead end.
3. Client-only stock checks: two devices over-draw a lot; only a persistent red banner after sync, no resolution screen.
4. No global search/command palette; finding a lot = Storage page + eyeballing tables.
5. Quarantine blendable but not packable — gate inconsistency learned by refusal text.
6. "Melange" vs "Blend": same object, two names across nav/code/masters.
7. GRN form: everything typed fresh (product, vendor, farmer, area, harvest date, rate, transport, 4 grade boxes); no defaults/scan/PO.
8. Rejected stock is a dead end; Retest has no driving queue.
9. Control samples split across pages; can't add after run closes.
10. Missing-master dead ends mid-flow ("no active cold room", "set pack size first").
11. Three report-ish screens (Lab Reports / Live Reports / ReportView) with no naming signal.
12. Delivery closure = one modal per dispatch row; multi-stop days = N modals, no trip view.

## 10. Chartable data — exists vs missing (detail in slice-2 record, KPI.md will formalize)
- EXISTS: grade distribution + reject%; intake qty/spend by supplier; cost per usable unit; yield per unit per batch; spoiled qty/value; blend output by recipe; packs by SKU/size; PM below-reorder; FG by QC status; near-expiry; QC pass/fail/retest; control-sample retention; dispatch qty/value by customer/challan; on-time delivery (expected vs deliveredTime); inventory value; stock-issue value by reason.
- MISSING: yield per 100 nuts vs target; spoilage Pareto by reason; mass-balance variance; recipe-vs-actual variance; cycle time/stage aging; cold-room occupancy/time-out-of-cold; carton use & boxed-vs-loose; loose-BIB stock by size; QC control charts vs numeric spec limits; PO funnel/supplier lead time; days-of-stock; failed-delivery reasons; agent performance; shipment board.

## 11. Risks for current users (during overhaul)
- Client-only gates today → new server enforcement must ship behind feature flags + Classic view or operator muscle memory/offline flows break.
- Document-store changeset writes and new server-enforced endpoints will coexist during transition — dual-write divergence risk; needs one sync/consistency answer (ARCHITECT).
- Zoho fallback engine deletion (planned from 2026-10-19) overlaps Phase 2 — coordinate.
- 20s full-snapshot polling: heavy KPI aggregation must not ride the client snapshot path (server aggregation layer instead).
- Renames must be label-only (Melange→Blend) — code/data names stay.

## Assumptions Register verdicts
→ maintained in DECISIONS.md (12 items: 4 EXISTS-IN-APP, 5 PARTIAL, 3+ MISSING; all ASSUMED defaults to be configurable and surfaced in the Phase 1 summary).
