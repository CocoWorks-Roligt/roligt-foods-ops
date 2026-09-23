# Roligt Ops on Zoho Tables — Roadmap & Pending Work

**Date:** 2026-09-22 · **Baseline:** tag `plan1-complete` (GRN vertical e2e-proven on scratch)

Ordering rationale: §2 unblocks real use of the production base; §3 makes the fork feature-complete vs the Supabase app; §4 makes it safe and fast under real plant load; §5 is polish. Effort estimates assume one developer who has read the [developer handoff](fork-developer-handoff-2026-09-22.md).

---

## 1. Where things stand

Done: fork + BFF + auth + full read/write path + GRN vertical proven live (post GRN → ledger → dashboard → cross-device sync → role enforcement). All 22 collections already **read and write correctly** through the Data JSON path — the app is functionally at parity for day-to-day screens the moment it points at a base with data. What remains is: production cutover, Analytics column enrichment, performance, and hardening.

## 2. Phase 0 — Production cutover (Task 12, user-gated) · ~half a day incl. decisions

Four decisions/changes must land before flipping to base `gerc53fe9f1e44e5f4a13809d9bd47367ba9d`:

1. **`--production` escape hatch in `scripts/zoho/topup.mjs`** (~15 min). The script hard-refuses the production id by design; add an explicit flag + typed confirmation (`--production gerc53fe…`), keep the guard for bare invocations.
2. **Seed-row decision.** Production carries 81 Creator-era seed master rows with no App IDs. The fork's keyed upserts will NOT adopt them — first boot would create parallel rows and double every master in Analytics. Choose:
   - **Adopt:** stamp App IDs (+ Data JSON) onto seed rows by business key (one script, ~1h, matches on Name/label columns), or
   - **Purge:** delete the seed rows (they exist in the Creator app's own data anyway).
   Adoption is recommended — Analytics and any Creator fallback keep their history.
3. **Quiet window.** Scripts + BFF share one API key's global budget. Run the top-up (~62 writes ≈ 4 min at the write throttle) while no device is polling — ideally with the scratch-based dev server stopped.
4. **Smoke scope.** Read-only (revision + snapshot + app boot) recommended; the write path is already proven. If a test GRN is wanted, mark it clearly and delete after.

Then: `node scripts/zoho/topup.mjs --production gerc53fe…` → `ZOHO_BASE_ID=gerc53fe… node scripts/zoho/gen-base-schema.mjs` → commit regenerated schema → switch `.env` (`assertBaseMatch` will catch a half-done flip at boot) → smoke. The fork's first boot on production will seed-push its masters (~107 writes ≈ 6 min at the write budget) — expected, one time.

**Re-measure before multi-operator rollout:** concurrent serverless isolates each hold their own 26/17 budget against Zoho's global caps; and N operators polling every 20s means N snapshots per change. The e2e measured 2 sessions serially; a morning-rush simulation (3–5 concurrent) should precede trusting it.

## 3. Phase 1 — Feature parity · ~1–2 weeks

Everything here is Analytics enrichment — the app works without it; Analytics reports want it.

1. **Column mappers for the remaining collections** (extend `columnsFor` in `api/_lib/mappers.ts`, one switch case each, ~½ day per group):
   - batches (Batch No/Date/Kind/Spoiled/Cost per Unit/Status + Location link), packing runs (Run No/Date/Drawn/Status + Batch/Bulk Item/Location links)
   - orders + **Order Lines child table** (the one structural piece: split order.lines into the child table on write, reassemble on read — `order_lines` is currently mapped but unused)
   - QC records (Doc No/Disposition + Batch/Item links), lab reports (Report No/Decision + links)
   - dispatches (Challan No/Qty/Expiry/Vehicle/Status + Customer/SKU/Batch/Location links)
   - stock issues, production plans, shifts, attendance, staff, sticker templates/prints
   - customers, melanges, test parameters, vendor types (masters with real columns already exist)
2. **Attachments BFF endpoint** — see §4.4; part of parity because QC/lab reports are attachment-heavy.
3. **Sticker printing check** — client-side jsPDF pipeline should work as-is; verify per-printer fidelity once running against real data.

## 4. Phase 2 — Performance & scale · ~1 week

1. **Delta reads.** Snapshot currently reads all mapped tables (~26 budgeted reads, ~60s). Add `criteria`-filtered fetches on the big tables (Ledger, Audit Log, sticker prints) by `Time >= last sync` — note criteria supports only **single-equality** today (OR returned 0 rows live), so this needs either per-day queries or a re-probe of range operators before designing. Alternative: cursor from last `recordID`.
2. **Snapshot caching per instance.** Cache the assembled snapshot keyed by revision in the BFF; `/api/revision` (1 read) invalidates. Cuts snapshot cost to ~1 read when nothing changed — this alone fixes multi-operator polling pressure.
3. **Audit-fetch cost in commit.** `commitChanges` fetches ALL existing audit App IDs on every commit (insert-only enforcement) — grows unbounded past the 1000-row page. Fix: criteria-filter the existence check or track known-written audit ids per instance.
4. **Error-code mapping polish.** Non-JSON commit body → 400 (not 500); unknown table → 400; distinguish `ZohoApiError` → 500 from `ZohoLockedError` → 503 in the read handlers (a permanent misconfig currently reads as "retry later").

## 5. Phase 3 — Production hardening & launch · ~2–4 days + external steps

1. **Kinde tenant** (config steps in the implementation notes §5.5): create app + Admin/Operator roles, invite users, set envs, verify the JWKS URL live (never exercised against a real tenant).
2. **Server-side audit Actor stamping.** `caller.email` is available in the BFF; stamp it instead of trusting the client-supplied role string (closes actor spoofing; the spec's "Actor = Kinde email" is currently only client-side).
3. **Uploads.** Replace the session-local shim (`src/lib/uploads.ts`) with a BFF upload endpoint — Zoho Tables attachment fields (type 2) exist on QC Records/Lab Reports/Dispatches; verify their write/read contract with a probe first. Until this lands, **attachments are the one functional regression vs Supabase** — tell users.
4. **Deploy.** Vercel project (framework preset Vite, functions from `api/`), envs from §5.1 with `ALLOW_DEV_SESSION` absent, custom domain, then a full e2e pass against the deployed URL. Consider the always-on single-writer option (Cloudflare DO) only if the §2 re-measurement says isolates are breaching caps.
5. **Data migration** (if the Supabase app has real data by then): blueprint §8 — export Supabase → CSV → DataPrep/Zoho import into the production base, ledger first, then reconciliation spot-checks. Not needed while the Supabase app remains seed-only.

## 6. Deferred minors (safe to postpone; triaged by the final review)

Fix-in-Plan-2: README/env-example wording drift (done in cleanup); error-text-contains-"limit" can over-map to a lock; no 401 retry in ZohoClient (1h token bounds it); token non-JSON body → raw SyntaxError; login `state.path` decorative (no post-redirect restore); static Kinde SDK import in dev builds (prod tree-shakes); `getClaims` failure logs out instead of degrading to Operator; case-sensitive `Bearer` prefix; audit double-fetch when one block has upserts+removes; TOCTOU on brand-new audit ids (settled history still safe); `s`/`n` duplicate helpers in mappers; spliced docblock in `roles.ts`.

Drop-or-decide: `order_lines` in TABLE_FOR is write-reachable but read-unused until Phase 1 wires it — gate or leave (noise only).

## 7. Supabase track (the original app)

Unchanged and independent. Its own backlog lives in the main repo's session state (P0 sync write-loss fix, doc-number collisions, test suite, register sorting, copy scope). If the fork becomes the go-forward app (per the platform decision docs in this repo's `docs/`), the Supabase app becomes the reference implementation — keep it runnable for logic comparison, freeze feature work.
