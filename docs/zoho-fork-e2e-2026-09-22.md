# GRN vertical slice — live end-to-end gate

**Date:** 2026-09-22 (evening) · **Base:** scratch `dhorj90a2ded0152a4f1d94ae8ce4ece09a5c` only — never production
**Harness:** `scripts/dev-server.mjs` (run `npm run build && npx tsx scripts/dev-server.mjs`) — `vercel dev` refuses to run unlinked, so the harness serves `dist/` with the SPA fallback and routes `/api/snapshot|revision|commit` to the exported handlers in-process (node req/res adapted to the VercelRequest/VercelResponse slice the handlers use; `.env` parsed into `process.env` before the api modules load, because the shared ZohoClient captures `ZOHO_BASE_ID` at import).

**Setup before the gate** (documented, repeatable): `npx tsx scripts/dev-server.mjs --seed-scratch` performs exactly the commit a browser's first boot performs against an empty base (the client seeds from its own masters and pushes the whole seed up — AppContext's null-snapshot path; 81 rows + 24 counters, 365 s under the 17-writes/min budget) and then resets the `app_revision` row to 0, so the plant reads "installed, no postings yet". With the base pre-seeded, a fresh browser boots read-only ("All changes saved." with zero writes) and the first commit the gate observes is the posting under test — the state the brief's revision arithmetic assumes. After the bugs below were fixed the posted documents were wiped from the base (GRNs/Ledger/Audit Log rows, `grn`/`lot` counters, period rows) and `app_revision` reset to 0 once more, so every number below is from the final fixed run.

## Bugs the gate caught (fixed, TDD, before the passing run)

Live end-to-end is the only place any of these could surface — every one of them passed the unit suite.

1. **Mapper columns were sent keyed by field NAME under `is_ids_used_in_data: true`.** Zoho reads a name as a bogus field ID and answers `500 INTERNAL SERVER ERROR` to every enriched write; the seed commit died on its first row. Fix: `columnsByFieldId()` in `api/_lib/commit.ts` translates name → field ID and drops unknown names. Pinned by a live A/B: name-keyed upsert 500s, the same row with ID keys succeeds (checkbox `'true'` and numbers as strings are both accepted).
2. **`auditColumns` read `role`/`time` from the flat row that carries `actor`/`at`** — Actor and Time were silently dropped from every audit write. Fix in `api/_lib/mappers.ts`.
3. **Ledger and audit rows were read back through the generic doc decoder**, but the commit stores their Data JSON in the FLAT `ledgerToRow`/`auditToRow` shapes (`qty_in`, `item_type`). `qtyIn`/`itemType` came back undefined, the stock fold produced NaN, and a posted receipt showed "No stock records". Fix: `assembleState` decodes those two through `ledgerFromRow`/`auditFromRow` (the mappers the Supabase client used for the same rows).
4. **`period:*` counter values are strings (`'YYYY:2026'`) and were written to the Counters table's NUMBER field `Next`, which silently drops them.** They read back empty; `nextId`'s period-change detector saw `'' !== 'YYYY:2026'` and reset the running number to 0; the second GRN minted `RFTC20260001` AGAIN and its doc-keyed upsert OVERWROTE the first receipt — silent data loss. Fix: periods are stored in the Config table (Setting/Value are text — where the snapshot reader already looked for them) and the Counters reader ignores `period:*` rows as remnant corruption. Verified live: the re-run's second GRN mints `RFTC20260002` and both receipts stand.

Harness lesson: tsx does not hot-reload — after changing api code the dev-server must be restarted, or it serves the stale module (this masked fix #1 for one confusing browser failure).

## The seven checks (all PASS)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Stack starts clean, `GET /api/revision` → `{"revision":0}` | **PASS** | curl at gate start (final run 22:00 local) |
| 2 | Admin session; Procurement → post GRN (Tender Coconut, direct farmer Ramaiah Gowda · Mandya, 500 received / 20 free, A 400 · B 60 · C 30 · 10 rejected, ₹38/piece + ₹500 transport); register lists it | **PASS** | `RFTC20260001` · `LOT-20260922-001`, "490 accepted", Posted — `grn_posted.png` |
| 3 | Inventory shows the lot with the accepted quantity; a ledger line exists | **PASS** | Raw Material Store 490 Piece · ₹18,740.00; stock row `RFTC20260001` → LOT-20260922-001, Available — `inventory_lot.png`; Traceability for the lot shows the receipt node and farmer — `trace_lot.png` |
| 4 | `GET /api/revision` after the GRN → `{"revision":1}` | **PASS** | curl ~5 s after "All changes saved." |
| 5 | Second browser context (no localStorage) sees the GRN without manual refresh | **PASS** | fresh boot (~60 s paced snapshot) lands with revision 1 and lists the GRN — `second_session_sync.png`; stricter variant also verified: with session 2 open, a second GRN posted from session 1 (revision 2, correctly numbered `RFTC20260002`) appeared in session 2's open register ~80 s later via the 20 s revision poll → snapshot, no refresh |
| 6 | Operator gate | **PASS** | sign out → role picker → Operator: Masters nav hidden; typing `/settings` and `/vendors` bounces to the dashboard (AdminOnly route guard). Deviation from the brief's letter: there is no "vendor edit on Settings" screen an operator can reach to toast at — every master screen is route-guarded and its write buttons are not rendered for operators; the enforced refusal is the BFF's. `curl -X POST /api/commit` with `x-dev-role: Operator` + a vendors upsert → **403** `{"error":"You do not have permission to change vendors.","table":"vendors"}` — `operator_forbidden.png` |
| 7 | Screenshots in `gui-test-screenshots/zoho-fork/` | **PASS** | grn_posted.png, inventory_lot.png, second_session_sync.png, operator_forbidden.png (+ trace_lot.png) |

## Timings (paced by the shared client's 26 reads / 17 writes per minute)

- App boot (snapshot fan-out, ~27 reads): **55–60 s** — every fresh browser context or full reload.
- GRN commit (link maps 4 reads + 3 doc writes + ~6 counter/config writes + revision): **4–6 s**, then the dirty flag clears ("All changes saved.").
- `--seed-scratch`: **365 s** (107 writes) — one-time setup.
- Poll pickup in an open session: poll tick (≤20 s) + paced snapshot (~60 s) ≈ **80 s** worst case.

## End state of the scratch base

Revision 2; two receipts (`RFTC20260001`, `RFTC20260002`), two ledger Receipt lines, audits, counters `grn=2`/`lot=2`, period rows in Config. Left in place as the record of the run.
