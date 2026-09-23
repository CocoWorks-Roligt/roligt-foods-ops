# Roligt Ops on Zoho Tables — fork design

**Date:** 2026-09-21
**Status:** approved (design review passed in session)
**One line:** a separate fork of the React PWA that runs on the already-built Zoho Tables base instead of Supabase, through a commit-oriented BFF, with Kinde for auth.

---

## 0. Decisions (settled in review)

| Question | Decision |
|---|---|
| How the variant lives alongside the Supabase app | **Separate forked copy** (`roligt-foods-ops-zoho/`), evolving independently |
| Which Zoho schema | **The existing built base** ("Zoho production analytics", 30 tables, seeded) |
| Auth | **Kinde** (SPA PKCE, Admin/Operator as Kinde roles; BFF validates JWTs) |
| Runtime shape | **Commit-oriented BFF** — Vercel serverless functions in the fork's repo |
| First milestone | **GRN vertical slice** (recommended, unobjected) |

## 1. Repo & runtime shape

- `roligt-foods-ops-zoho/` is a sibling copy of the app (no `node_modules`/`dist`), a separate Vercel project.
- The BFF lives in the fork's `api/` directory. Three endpoints:
  - `GET /api/snapshot` — the whole plant, in the exact shape `dbApi.fetchDb` returns today
  - `GET /api/revision` — one number, for `AppContext`'s existing poll loop
  - `POST /api/commit` — receives the `StateChanges` diff that `src/lib/sync.ts` already produces
- Client-side, only the transport changes: `dbApi.ts` swaps Supabase calls for these three `fetch` calls. `sync.ts`, `localDb.ts`, the posting rules in `src/lib/` and `src/context/domains/`, and every page stay untouched. The offline-first local copy and dirty-flag model carry over verbatim.
- Dev workflow: `vercel dev` (serves the Vite build and the functions together).
- Env: `VITE_KINDE_*` client-side; server-side Kinde domain + Zoho creds (ported from `cw-ops/.zoho.env`, including the token-refresh logic proven in `scripts/zoho/build-tables.mjs`) + `BASE_ID`.

## 2. Auth — Kinde

- Kinde React SDK, PKCE, silent refresh.
- **Admin** / **Operator** are Kinde roles.
- The BFF validates Kinde's RS256 JWTs against its JWKS endpoint on every call and enforces the rule RLS enforced: writes to `adminOnly` collections (the nine master tables — see `src/lib/tables.ts`) are rejected for operators server-side.
- `AuthContext` is rewritten to keep its current interface (`session` / `role` / `signIn` / `signOut`), so pages do not change.
- Audit **Actor** = the Kinde email claim. Password resets and user invites are Kinde-managed; we store no passwords.

## 3. Data mapping onto the built base

One-time top-up script (extends `scripts/zoho/build-tables.mjs`, ~35 REST writes, resumable like its phases):

- an **App ID** single-line field on every table the fork reads or writes (the app mints its own string ids; Zoho record ids stay internal). Reference-only tables the fork never writes — Vendor Types, Test Categories, Melange/BOM line children — need none; keyed singletons (Counters by Series, Config by Setting) use their existing keys instead
- a **Sticker Prints** table (print history — immutable, keyed by App ID)
- an `app_revision` row in the existing **Config** table

Server-side mappers, one module per collection:

- Masters → full real columns (Vendors, Customers, Items, Products, …).
- Documents → queryable real columns + the existing JSON fields for nested arrays (Batches/Packing Runs → `Data JSON`; QC → `Tests JSON`; Stock Issues → `Lines JSON`; Lab Reports → `Scores JSON`; Ledger keeps `Data JSON` for extras).
- Order lines → the child **Order Lines** table, delete+reinsert per order App ID.
- Link fields (GRN→Vendor, Batch→Location, …) resolve through an app-id→Zoho-record-id map built from masters at snapshot time and cached per commit. An unresolvable link fails the commit with a readable error.
- Rules ported verbatim: **ledger rows are never updated or deleted** (reversals are new negative lines); counters increment inside the commit that mints the number.
- Counters, Config, Sticker Templates map to their existing seeded tables.

## 4. Sync, revision & the write budget

- Concurrency semantics are unchanged from the Supabase model: row-level last-writer-wins, identity-diffs on immutable collections, and the revision number only signals "something changed → refetch" (`AppContext` polls `/api/revision`).
- Every commit ends by bumping `app_revision` (one write, counted in the budget).
- The Zoho Tables write limit (~20/min per API key; breach locks ~5 min) is **global**, and serverless instances cannot share an in-process limiter. Design stance:
  - a commit is small — doc + ledger lines + counter + audit + revision ≈ 5–8 calls;
  - the proxy throttles its own writes and, on a Zoho lock window, returns `503 + Retry-After`;
  - backpressure is absorbed by the client's existing offline machinery — a failed save leaves the local copy dirty and re-attempts, so a morning GRN rush queues on devices for a minute rather than corrupting anything;
  - plant scale (2–5 operators) fits comfortably; the spikes measure the real ceiling before we rely on it.
- Fallback if spikes kill the math: move the writer to a single always-on endpoint (e.g. a Cloudflare Durable Object) that owns the global queue. Deferred until measured need.

## 5. Day-1 spikes (go/no-go, before any mapper is written)

All against a **scratch copy** of the base (structure-only duplicate — the endpoint is already verified in `build-tables.mjs`); the seeded base is never a test fixture.

1. **Bulk writes** — can `POST /records` carry multiple records per call? Decides whether a 4-line-ledger commit costs ~5 calls or ~8.
2. **Reads** — `GET /records` pagination/criteria/sort behavior, read rate limits, and full-snapshot latency across 31 tables.
3. **Kinde in a Vercel function** — JWKS validation + role claim extraction.

## 6. Milestones

1. Fork + BFF skeleton + Kinde login working.
2. **GRN vertical slice**: snapshot (masters + GRNs + ledger) → post a GRN end-to-end (doc + ledger + counter + audit + revision) → dashboard reflects it → a second browser sees the revision bump and refetches.
3. Remaining collections in blueprint §4 order: procurement → production → QC → packing/orders/dispatch → planning/roster → stickers.
4. Verification gates on the fork mirror the main app: `tsc` clean, `oxlint` at baseline, live headless-browser check; plus unit tests for mapper round-trips (doc→row→doc) and the commit translator against a faked Zoho transport.

## 7. Out of scope for v1

- One-time migration of real Supabase data (blueprint §8 / DataPrep) — later.
- Any Creator-track work; the fork does not touch or depend on the Creator recovery.
- Realtime beyond revision polling (no websockets).

## 8. Risks & contingencies

| Risk | Mitigation |
|---|---|
| No bulk record insert → commit ceiling ~2–3/min | Client queuing absorbs bursts; if insufficient, single always-on writer (§4 fallback) |
| Zoho lock window (5 min) triggered by a burst | Proxy-side throttle + `503 + Retry-After`; local dirty queue retries |
| Snapshot latency as ledger grows | v1 ships full snapshot (same as today's app); delta reads by `Time >= last sync` are a later optimization, ledger has real Time columns for it |
| Link-field id drift between fork and base edits made directly in Zoho | Snapshot rebuilds the id-map every boot; unresolvable links fail loudly |
| Fork divergence from the Supabase app | Accepted by decision — features are re-applied by hand when wanted |
