# D1 cutover runbook — Zoho Tables → Cloudflare D1

Everything before the freeze window is done. This document is the remaining
path: one rehearsal decision, then the switch itself.

## Where things stand (2026-10-08)

| Piece | State |
|---|---|
| Engines (read / write / compliance / admin audit) | committed `45aa475`, 588 tests green |
| Facade + cutover switch | `D1_DATABASE_ID` + `D1_API_TOKEN` + `D1_ACCOUNT_ID` present ⇒ D1 serves; absent ⇒ Zoho. One image, engine by env |
| Design pins | REST batches atomic, `changes()` in-batch, RETURNING — live-probed (scratch), engine built on Design A + assert form A |
| Scratch database | loaded from the scratch base, manifest-verified, live smoke 7/7 (twice) |
| Production dump | **measured tonight: 63 s wall, 334 rows, 26 tables** — `scripts/d1/dump-gerc53fe-2026-10-08.sql` + `.manifest.json` (gitignored, plant data) |
| Production D1 (`roligt-ops-prod` `de8175f2-…`) | created, **empty** — schema not yet applied |
| API token | **not minted** — cutover needs one, scoped `Account | D1 | Edit` |

Databases (both `weur`, beside Vercel fra1):

- `roligt-ops-scratch` = `28356095-f72a-41a4-9797-1414c92e0e57`
- `roligt-ops-prod`    = `de8175f2-567d-492f-b2f4-63736fb1d402`
- Cloudflare account   = `d189eb0424c72ded675161f747cf85bd`

## Two decisions before the window

### 1. The compliance register's ordering (pick one)

Tonight's dump **skipped** Compliance Documents — its Zoho production topup
never ran (the register isn't live in production yet). Two clean orders:

- **A (recommended): cutover first, register starts empty on D1.** Drop the
  Zoho production topup entirely — `d1ComplianceStore` needs no table
  provisioning, documents land straight in `documents` (collection
  `'compliance'`). The compliance feature's OTHER setup (R2 + SMTP env,
  CRON_SECRET, role tick) still stands from
  `docs/compliance-register-2026-10-08.md` §7 — only its "production topup"
  step is obsolete.
- **B: provision the register on Zoho first.** Run the topup, record its
  field ids, let production use the register on Zoho for a while — then the
  T0 dump must find the recorded App ID/Data JSON ids or the register's docs
  are silently skipped. Only worth it if the register must be live *before*
  the cutover.

### 2. Preview rehearsal (optional but recommended)

Proves the deployed BFF — not just local vitest — serves D1. Needs the API
token:

1. Mint the token (Cloudflare dashboard → My Profile → API Tokens):
   `Account | D1 | Edit`.
2. Vercel → project → Settings → Environment Variables, **Preview** scope
   only: `D1_ACCOUNT_ID`, `D1_DATABASE_ID` = **scratch** id, `D1_API_TOKEN`.
3. Deploy this branch to preview (or push); open the preview PWA, log in as a
   scoped operator, exercise: snapshot loads, a create lands, poll adopts it,
   an offline queue drains.
4. Re-run the live smoke against scratch from a terminal:
   `D1_SMOKE=1 D1_ACCOUNT_ID=… D1_DATABASE_ID=28356095-… D1_API_TOKEN=… npx vitest run api/_lib/d1Smoke.live.test.ts`
5. Remove the preview env vars afterwards (or retarget them at T0).

Skipping this is acceptable — the engine's contract is pinned by 595 tests
including a 7/7 live scratch smoke — but it is the only step that tests the
deployed image.

## T−1 (the day before)

- [ ] Announce the window to the plant (the app is offline-first: during the
      window existing clients keep working on cached data and queue their
      writes; nothing is lost, changes sync after).
- [ ] Confirm decision 1 (compliance ordering).
- [ ] Merge `d1-migration` → `dev` → `main` if not already there (the branch
      is the engine; main should carry it before the flip so rollback-by-env
      doesn't depend on branch state).
- [ ] Mint the API token if not done for the rehearsal.

## T0 — the freeze window (~10 min of work; announce 20)

Announce "the app is switching its database; expect up to 20 minutes where
new entries queue on your device".

1. **Final dump** (read-only, paced; measured 63 s):
   ```sh
   time node scripts/d1/dump-from-zoho.mjs \
     gerc53fe9f1e44e5f4a13809d9bd47367ba9d \
     --production gerc53fe9f1e44e5f4a13809d9bd47367ba9d
   ```
2. **Schema + import into prod D1** (empty DB tonight; `IF NOT EXISTS` /
   `INSERT OR REPLACE` make re-runs safe). The dumper also derives first-class
   `packs` documents and `product.packId` pointers from the Zoho product rows;
   it does not add a Zoho table or a 27th snapshot read:
   ```sh
   npx wrangler d1 execute roligt-ops-prod --remote --file scripts/d1/schema.sql --yes
   npx wrangler d1 execute roligt-ops-prod --remote --file scripts/d1/dump-gerc53fe-<date>.sql --yes
   ```
3. **Verify** (exit non-zero on any mismatch — counts then full canonical
   compare against the dump's manifest):
   ```sh
   D1_ACCOUNT_ID=d189eb0424c72ded675161f747cf85bd \
   D1_DATABASE_ID=de8175f2-567d-492f-b2f4-63736fb1d402 \
   D1_API_TOKEN=<token> \
     node scripts/d1/verify.mjs --manifest scripts/d1/dump-gerc53fe-<date>.manifest.json
   ```
   Then the **browsing views** — one read-only `v_<collection>` view per
   collection (`v_items`, `v_batches`, `v_ledger`…), a column per field, so
   the Cloudflare dashboard shows tables instead of a JSON column. The engine
   never reads them; `--drop` removes them; re-run after a new field appears:
   ```sh
   D1_ACCOUNT_ID=d189eb0424c72ded675161f747cf85bd \
   D1_DATABASE_ID=de8175f2-567d-492f-b2f4-63736fb1d402 \
   D1_API_TOKEN=<token> \
     node scripts/d1/views.mjs
   ```
   Then the **vanilla correction** — the production base carries an extraction
   (BAT-2026-0009) of vanilla that arrives already extracted; the script restates
   it as the blend run MEL-2026-0007 drawing RM-PP-0008 directly and removes the
   bulk SF-0008. Dry-run first, then apply (a re-run says "nothing to do"):
   ```sh
   D1_ACCOUNT_ID=d189eb0424c72ded675161f747cf85bd \
   D1_DATABASE_ID=de8175f2-567d-492f-b2f4-63736fb1d402 \
   D1_API_TOKEN=<token> \
     node scripts/d1/fix-vanilla-direct-use.mjs [--apply]
   ```
4. **Flip the env in Vercel** — Production scope this time:
   `D1_ACCOUNT_ID`, `D1_DATABASE_ID` (prod id), `D1_API_TOKEN`.
   **Do not remove `ZOHO_*`** — it stays for the week as the rollback path.
5. **Deploy**: `vercel deploy --prod` (or merge to main and let CI deploy).
6. **Smoke as a scoped operator** in the production PWA:
   - snapshot loads, revision token looks like `<n>:<nonce>`;
   - create something small (a QC note) → it appears; poll keeps serving it;
   - edit it on two devices / re-send offline-queued writes → no duplicates;
   - Audit page shows the write within one poll;
   - compliance page (if the role is ticked) lists/saves/removes;
   - terminal: re-run `d1Smoke.live.test.ts` with `D1_DATABASE_ID` = **prod**
     and the token.
7. **Watch the first minutes**: Vercel logs for `/api/snapshot`,
   `/api/revision`, `/api/commit` — expect 200s; `Retry-After` responses
   should be rare-to-none (D1 has no Zoho budget).

## Rollback

- **During the window or day 1 only**: remove the three `D1_*` env vars from
  Vercel Production, redeploy. Zoho serves the frozen base. Valid only while
  minutes of D1-only writes are acceptable to re-enter manually.
- **After day 1**: never back onto a stale Zoho base. Fix forward, or
  `npx wrangler d1 time_travel info roligt-ops-prod --remote` then
  `… time_travel restore roligt-ops-prod --remote <bookmark>`. Time Travel
  holds 7 days on the free tier; the dump files are the long-term PITR.

## T+1 through T+7 — monitoring

- Watch a.m. and p.m. peak: snapshot latencies (D1 read is one ~0.4 s batch),
  commit 409 rates (should match pre-cutover conflict rates, not spike),
  `d1Engine`-shaped 500s (should be zero).
- The Zoho base goes read-only-archive: nobody writes it; staleness is
  expected and was communicated.

## Phase 7 — deletion (after 7 stable days)

- [ ] Delete `zoho.ts`, `mappers.ts`, `baseSchema.ts`, the Zoho arms of
      `snapshot.ts` / `commit.ts` / `adminAudit.ts` / `complianceStore.ts`,
      and their tests (`zoho.test.ts`, `mappers.test.ts`, `baseSchema.test.ts`,
      the Zoho-coupled suites).
- [ ] Remove `ZOHO_*` env from Vercel (keep `.zoho.env` locally if the
      archive ever needs re-reading).
- [ ] Final archive export from D1 (`dump`-equivalent SELECT export) stored
      beside tonight's Zoho dump.
- [ ] Update `docs/` and the memory files.

## Provenance of the numbers

- 63 s dump: measured 2026-10-08 ~20:15 IST against the production base,
  paced 2.5 s/read, 26 tables / 334 rows (Compliance Documents skipped —
  decision 1).
- 26-SELECT batch ≈ 420 ms: the Phase-0 probe against scratch, `weur`.
- 7/7 live smoke ×2: `d1Smoke.live.test.ts` against scratch after the
  constraint rename, including the rival-write rollback case in-suite.
