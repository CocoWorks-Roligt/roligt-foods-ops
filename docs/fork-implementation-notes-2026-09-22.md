# Roligt Ops on Zoho Tables — Implementation Notes

**Date:** 2026-09-22 · **State:** Plan 1 complete, e2e-proven on the scratch base · **Repo:** `roligt-foods-ops-zoho` (standalone git repo, branched from the `roligt-foods-ops` working tree as of 21 Sept 2026) · **Tag:** `plan1-complete`

Companion documents: [Roadmap & pending work](fork-roadmap-2026-09-22.md) · [Developer handoff](fork-developer-handoff-2026-09-22.md) · [Design spec](zoho-tables-fork-design-2026-09-21.md) · [Implementation plan](zoho-tables-fork-plan-2026-09-21.md) · [Live probe results](zoho-fork-probe-results.md) · [E2E evidence](zoho-fork-e2e-2026-09-22.md)

---

## 1. What this app is

The Roligt Foods plant-operations PWA (React 19 + Vite, ~30 screens) running on **Zoho Tables** as its database instead of Supabase, through a small serverless BFF, with **Kinde** as the identity provider. The client's sync engine, offline-first queue, posting rules, and every page are byte-for-byte the original — only the transport (`src/lib/dbApi.ts`) was replaced, plus auth (`AuthContext`, `Login`).

**Proven in a live browser (22 Sept, scratch base):** login → post GRN → ledger line + counter + audit + revision written → inventory shows the lot → a second browser session sees the receipt without manual refresh → an operator gets 403 on admin actions. Screenshots: `gui-test-screenshots/zoho-fork/`.

## 2. Architecture

```
Browser (React PWA, unchanged pages + domains)
  │  GET /api/snapshot · GET /api/revision (20s poll) · POST /api/commit {changes: StateChanges}
  ▼
BFF (Vercel Node functions in api/, dev-runnable via scripts/dev-server.mjs)
  │  authenticate() — Kinde JWT via JWKS (or guarded dev session)
  │  commitChanges() — role gate → doc→columns mappers → keyed upserts → revision bump
  ▼
Zoho Tables v1 REST (IN DC) — one shared ZohoClient (26 reads/17 writes per min, serialized)
  │
  ▼
Base "Zoho production analytics" (30 tables + Sticker Prints), App ID + Data JSON on every row
```

Key decisions and why:

| Decision | Why |
|---|---|
| Reads use only **App ID + Data JSON** columns | Byte-identical to the old Supabase `(id, data)` contract — round-trips are lossless by construction |
| Real columns are **write-side enrichment** | Analytics and link fields get queryable data; a wrong/missing column can never corrupt the app, only a report |
| Every write is an **upsert keyed by a business key** (App ID / Series / Setting) | A retried commit re-writes the same rows — retries can never duplicate a ledger line |
| **One shared ZohoClient** per server instance | Zoho's rate limits are global per API key; budgets only mean anything if all calls share them |
| Revision row in **Config**, bumped last | Clients poll one cheap read to know "something changed → refetch" |
| Period counters stored in **Config**, not Counters | Counters.Next is a NUMBER field and silently drops strings — storing period keys there reset a counter and caused duplicate doc numbers (found live, fixed structurally) |
| The BFF is the **RLS of this fork** | No Zoho-side row security exists; the commit endpoint enforces admin-only tables, config writes, and audit deletions (audits are insert-only — settled history cannot be rewritten) |

## 3. What was done, task by task

| # | Task | Outcome | Key commits |
|---|---|---|---|
| 1 | Fork the repo | Standalone repo, deps swapped (added kinde/jose/vitest/@vercel/node), dummy envs, gates at parity | `91c5f90` |
| 2 | Zoho client library | Token refresh, serialized rate budgets, cursor paging, keyed upserts; 8 unit tests | `6059f9c`, `56c336c` |
| 3 | Scratch base | API base-creation is broken server-side (500) — user UI-duplicated production → scratch `dhorj90a…`; 30/30 tables verified | `3343afb`, `bd5d2f0` |
| 4 | Live contract probe | **GO**; pinned: string criteria, form-body transport >2KB, array-criteria failure, phone-field string drop | `14bd311`, `193dfdf` |
| 5 | Base top-up | App ID + Data JSON on all 31 tables, Sticker Prints table, revision/config rows; resumable script | `7f65853` |
| 6 | Generated schema bindings | `api/_lib/baseSchema.ts` from topup state; coverage test | `4ff55b9` |
| 7 | Kinde client + dev fallback | SDK 5.13.1 is hooks-only → KindeBridge pattern; no-env fallback session with role picker | `00f7d9c`, `3d800d4` |
| 8 | BFF auth guard | jose JWKS verify, fail-closed ordering, dev session | `e897634`, `025ab91` |
| 9 | Snapshot/revision + dbApi swap | Read path over the base; Supabase fully removed from the fork | `338c5e8`, `b4fead5`, `88d6918` |
| 10 | Commit endpoint | Idempotent writes, role gate (hardened across 2 review rounds: config + audit-deletes + duplicate-entry bypass) | `61479a8`, `0ad1264`, `664e118`, `bdaf006` |
| 11 | **Live e2e gate** | All 7 checks PASSED on scratch; 4 live-only bugs found and fixed root-cause (incl. one silent-data-loss) | `d837861`, `5fa783f` |
| 12 | Production top-up | **DEFERRED — awaiting explicit go** (see Roadmap §2) | — |
| — | Final whole-branch review | Passed; must-land fixes applied (dev-session prod guard, audits insert-only, base-id invariant, README) | `d03e025` |

Suite: **50 tests / 8 files**, `tsc -b` clean, oxlint 13w/0e baseline, production build clean.

## 4. Pinned Zoho Tables API contracts (live-verified, IN DC)

These were verified against the real API on 21–22 Sept 2026; the client code depends on every one of them.

1. **Upsert:** `PUT /records` with `data` (JSON, field IDs as keys), `criteria` as a **string** `"<fieldID>" = "<value>"`, `is_upsert_needed=true`, `is_ids_used_in_params=true`, `is_ids_used_in_data=true`. Array-shaped criteria fails (error envelope at HTTP 200).
2. **Fetch:** `POST /fetchRecordsWithCriteria`, `count` ≤1000, cursor via `reference_record_id` (last recordID of the previous page). **Do not pass `field_ids`** — the live base answers 400.
3. **Payload size:** query params >~2KB risk HTTP 414 (8KB always fails). The client moves large params into an `x-www-form-urlencoded` body automatically (>2000 chars, non-GET only).
4. **Error envelopes at HTTP 200:** Zoho returns application errors inside 200 responses (`{"error":{...}}`). The client throws on any error-shaped body.
5. **Rate limits (per API name, per minute, per key):** Create/Delete/Update 20 each, Fetch 30; breach locks that API for 5 minutes. Scripts and the BFF share one key's budget.
6. **Field quirks:** phone-type fields silently DROP strings containing spaces (send digits-only); Counters.Next is a number field (period strings belong in Config.Value); link fields need Zoho record IDs, not app IDs.
7. **Base creation (`POST /bases`) is broken server-side** (500 even with correct portal_id/workspace_id); no duplicate-base endpoint exists. Bases must be created in the UI.
8. **Tokens:** access token 1h; refresh via `refresh_token` grant at `accounts.zoho.in`; max 10 grants per 10 min.
9. **Criteria operators:** only single-equality is verified. `OR` in a string criteria returned 0 rows at HTTP 200 — do not use until re-probed.

## 5. Configuration steps

### 5.1 Environment

Copy `.env.example` → `.env` (server side) and fill:

```
ZOHO_CLIENT_ID=…        # from the Zoho Self-Client (cw-ops/.zoho.env has the working set)
ZOHO_CLIENT_SECRET=…
ZOHO_REFRESH_TOKEN=…
ZOHO_BASE_ID=…          # scratch: dhorj90a2ded0152a4f1d94ae8ce4ece09a5c · production: gerc53fe9f1e44e5f4a13809d9bd47367ba9d
ZOHO_DC=tables.zoho.in
ALLOW_DEV_SESSION=1     # DEV ONLY — auto-refused once KINDE_DOMAIN is set or NODE_ENV=production
# KINDE_DOMAIN=…       # when the tenant exists (see Roadmap §4.3)
# KINDE_AUDIENCE=…     # optional
```

Browser side (`.env.local`, all optional — absent ⇒ dev session with role picker): `VITE_KINDE_DOMAIN`, `VITE_KINDE_CLIENT_ID`, `VITE_KINDE_REDIRECT_URI`, `VITE_KINDE_LOGOUT_URI`.

Secrets never carry a `VITE_` prefix; `.env*` are gitignored. The generated `api/_lib/baseSchema.ts` bakes the base id at generation time and `assertBaseMatch` aborts boot if it disagrees with `ZOHO_BASE_ID` — regenerate the schema whenever you switch bases (§5.4).

### 5.2 Run locally

```bash
npm install
npm run build                      # once; the dev server serves dist/
npx tsx scripts/dev-server.mjs     # http://localhost:3000 — serves the app + /api/* from .env
```

First boot against an empty base takes ~60s: the snapshot is ~26 reads, paced against the 26-reads/min budget. That is the rate limiter working, not a hang. `npm run dev` (Vite alone) serves the UI without `/api` — useful only for CSS work.

To reset the scratch base with seed data: `npx tsx scripts/dev-server.mjs --seed-scratch` (scratch-guarded; refuses production).

### 5.3 Gates

```bash
npm test        # 50 tests
npx tsc -b      # must exit 0
npx oxlint      # baseline 13 warnings / 0 errors
npm run build
```

### 5.4 Base maintenance scripts (scripts/zoho/, run with `node`)

| Script | What it does |
|---|---|
| `make-scratch.mjs <base-id>` | Duplicates the 30 tables from production into a scratch base (structure-only). Refuses the production id. |
| `probe.mjs` | Live contract probe (upsert/fetch/cursor/large payloads) — scratch only, hard-guarded. Run it whenever an API behavior seems to have changed. |
| `topup.mjs <base-id>` | Adds App ID + Data JSON fields everywhere, Sticker Prints, revision/config rows. Idempotent/resumable. **Refuses the production id — needs a `--production` escape hatch before Task 12 (Roadmap §2).** |
| `gen-base-schema.mjs` | Regenerates `api/_lib/baseSchema.ts` from `topup-state.json`. Run with `ZOHO_BASE_ID` matching the base you topped up, then commit the regenerated file. |

### 5.5 Kinde (not yet configured — everything works without it via the dev session)

1. Create a Kinde business → SPA application; redirect/logout URIs `http://localhost:3000` (add the deployed origin later).
2. Create roles **Admin** and **Operator**; invite users and assign roles.
3. Put `VITE_KINDE_DOMAIN` + `VITE_KINDE_CLIENT_ID` (+ redirect/logout URIs) in `.env.local`; `KINDE_DOMAIN` in server `.env`. ALLOW_DEV_SESSION stops working automatically.
4. Verify the JWKS path live (unit tests use a local key set — the `<domain>/openid/jwks` URL has never been exercised against a real tenant).

## 6. Known limitations (honest list)

- **Attachments are session-local** (QC/lab report files don't persist) — Supabase Storage was removed with the backend; a BFF upload endpoint is pending (Roadmap §4.4).
- **Boot latency ~60s** per cold snapshot; second-device sync stretches to ~80s+. Delta reads are the fix (Roadmap §4.2).
- **Budgets are per-server-instance**; concurrent serverless isolates each hold their own 26/17 against Zoho's global caps. Fine at current scale; measure before real multi-operator deploy.
- Only the GRN vertical has enriched real columns; other collections ride the Data JSON path (fully functional for the app; Analytics sees fewer columns until Plan 2 mapping).
- The scratch base currently contains two e2e test GRNs (`RFTC20260001/0002`) — harmless; wipe via the UI or `--seed-scratch` if you want a clean slate.
- Supabase itself is untouched — the original app (`../roligt-foods-ops`) still works exactly as before. The two apps share nothing at runtime.
