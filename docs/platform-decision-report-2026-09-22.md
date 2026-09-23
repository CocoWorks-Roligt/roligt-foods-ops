# Platform Decision Report — Roligt Plant Ops

**Date:** 2026-09-22
**Question:** Build the plant operations app on **Zoho Creator (+ Zoho Tables)**, or on a **React web app with Zoho Tables as the database and Kinde for authentication**?
**Basis:** not vendor marketing — every claim below is grounded in what was actually built, broken, fixed, and verified with both stacks in this workspace during September 2026. Evidence paths are cited throughout.
**Audience:** the go/no-go decision on which track gets the next block of engineering time.

---

## 1. Executive summary

**Recommendation: the React + Zoho Tables + Kinde fork (`roligt-foods-ops-zoho`) is the go-forward application. Park the Zoho Creator track as a working backup, not a parallel build.**

The reasoning, in one paragraph each way:

The app's differentiators — offline-first plant-floor operation, a bespoke operations UX we already overhauled once, a pure-function posting engine with an append-only ledger, the d3 traceability graph, client-side PDF/sticker generation — are all things **Creator structurally cannot host** (its own rebuild blueprint lists them under "what does not transfer, by design": `docs/zoho-rebuild-blueprint.md` §6). Meanwhile the fork reuses 100% of the client: the fork design swaps exactly one file's transport (`dbApi.ts`) and keeps sync, offline, domain logic, and every page untouched (`docs/zoho-tables-fork-design-2026-09-21.md` §1). Creator forces a 3–6 month re-implementation of already-working software (blueprint §7); the fork needs ~9 remaining tasks to prove its first end-to-end posting. Crucially, **both stacks share the same database** — the already-built 30-table Zoho Tables base — so choosing the fork does not walk away from the Zoho investment; Analytics over Tables works either way, and the Creator app remains importable as a back-office console if wanted.

The honest counterweights: the fork carries the **Zoho Tables API write budget (20 writes/min per key, global, 5-minute lock on breach)** as a permanent architectural constraint, and it makes us the permanent owner of a BFF (auth, throttling, id-maps, idempotency). Creator gives you forms, lists, validation, pagination, mobile app, schedules and notifications as configuration, with zero infrastructure to run. If the plant needed only standard CRUD registers and had reliable Wi-Fi everywhere, Creator would win. It doesn't — the offline requirement and the custom UX are the product.

**Recommended next actions** are in §10.

---

## 2. The three stacks in play

| | **A — Zoho Creator** (as built) | **B — React fork + Tables + Kinde** (as designed, Tasks 1–3 done) | **S — Status quo** (reference baseline) |
|---|---|---|---|
| App layer | Creator app "Roligt Plant Ops", 30 forms imported via `.ds`, Deluge engine v4 | The existing React 19 + Vite PWA (~30.7k LOC), unchanged client | Same PWA |
| Logic | Deluge functions (`mintDocNo`, `postGrn`, `postBatch`, …) in Creator | TypeScript, as-is (`src/lib/`, `src/context/domains/`) | Same |
| Data | Creator native store (hybrid plan: masters mirrored to Tables) | Zoho Tables base "Zoho production analytics" (30 tables, 81 seeds) via REST | Supabase Postgres (`supabase/schema.sql`, 18 RLS policies) |
| Auth | Zoho user accounts + Creator profiles (admin/operator) | Kinde (PKCE SPA) → BFF validates RS256 JWTs against JWKS; Admin/Operator as Kinde roles | Supabase Auth |
| Transport | Creator's own runtime | Commit-oriented BFF: `GET /api/snapshot`, `GET /api/revision`, `POST /api/commit` (Vercel functions) | Supabase JS client |
| Hosting | Zoho (nothing to run) | Vercel (app + functions) + Kinde + Zoho Tables | Vercel + Supabase |

Stack S matters to the comparison because it is the reference implementation everything is ported from, and it remains deployable today. The fork's whole design principle is "S with a different database and auth"; the Creator track's reality is "re-implement S inside Zoho."

---

## 3. What was actually built with each stack (the evidence base)

### 3.1 Shared foundation — the Zoho Tables base (both A and B stand on this)

- **Built live by REST script** (`scripts/zoho/build-tables.mjs`): 30 tables + 81 seed records into base `gerc53fe9f…` ("Zoho production analytics"), IN datacenter, using a Self-Client OAuth token (bypassing the broken Zoho MCP gate — see `docs/zoho-mcp-support-ticket.md`). Resumable phases: tables | fields-m | fields-t | dedup | options | links | seed | cleanup | verify.
- **Hard API contracts were discovered and documented by probing, not by docs**: field create has no name parameter (auto-names "Field N", rename via second PUT; unknown query params hard-reject 400); components must be re-passed on every PUT or they reset; `DELETE /records` is single-record; `POST /bases` 500s server-side (bases must be created in the UI). All pinned in the `build-tables.mjs` header.
- **Rate limits verified from the vendor help bundle** (`../zoho-build-probe/help.html`): Create/Update/Delete **20/min each**, Fetch **30/min**; breach locks the API for **5 minutes**; access tokens 1 h; max 10 grant tokens per 10 min.

### 3.2 Stack A — Zoho Creator, as it stands

- **Live app**: "Roligt Plant Ops", 30 forms imported from a generated `.ds` (`scripts/zoho/roligt-plant-ops.ds`, 53 KB) — the `.ds` route delivers *structure* cleanly (and proved itself as disaster recovery when the app was accidentally deleted from its environment stack: re-import took minutes). 79 master records seeded, all 21 numbering Counters backfilled from `numbering.ts`. Live as a plain app, deliberately plain (environment attach deferred to go-live).
- **Posting engine v4** (`docs/zoho-posting-engine.deluge`): 11 functions — `mintDocNo`, `itemRef`, `locRef`, `ledgerBalance`, `drawStock` (FIFO), `appendLedger`, `audit`, `postGrnCheck`/`postGrn`, `postBatchCheck`/`postBatch`. **Delivery route is paste into the function editor**: the `.ds` importer compiles functions and fails silently on Deluge content it doesn't accept, so structure ships by import and logic ships by paste (git stays the source of truth; deployment is manual and the live app can drift until re-exported — a documented next step is the re-export diff that restores one-command recovery). `mintDocNo("grn")` is verified live: minted `RFTC20260001`, counter incremented **and persisted**. Two-stage form wiring (validate = checks + `cancel submit`; success = posting) is in place on GRNs and Batches.
- **The engine needed a custom lint wall to be writable at all** (`scripts/zoho/embed-engine.mjs`): a generator that splices engine functions into the `.ds` in Creator's exact serialization shape, plus a hand-grown list of **banned constructs**, each discovered by an import or editor failure — no ternary, no map literals, no classic `update Form[…]` syntax, no bare `.replace()`, `replaceAll` must carry the literal-mode third argument (`replaceAll("{P}", prefix, true)` — default `false` is regex mode and rejects brace tokens), no compound assignment, no C-style `for`, ASCII-only, etc. The full dialect table and pitfall ledger live in the Creator implementation report.
- **Not yet done on this track**: the remaining engine ports (`releaseQc`, `postPacking`, `postDispatch`, `postIssue`) and workflow wiring, the concurrency spike — `mintDocNo` v4 is a single optimistic fetch-then-assign because the platform has **no compare-and-swap**, so two simultaneous mints could duplicate a number until quantified — the phone-no-signal test, permission profiles, Tables sync, UI phase (parked by decision). Full record: `../roligt-foods-ops/docs/creator-implementation-report-2026-09-22.md`.

### 3.3 Stack B — the fork, as it stands

- **Repo forked and green**: `roligt-foods-ops-zoho/` is its own git repo, 5 commits — fork, the Zoho Tables client library (+ an error-classification fix), and the scratch-base bootstrap. `package.json` already carries Kinde, `jose`, `vitest`, `@vercel/node`.
- **`ZohoClient` (`api/_lib/zoho.ts`) is written and unit-tested**: cursor pagination, keyed upserts (`is_upsert_needed` — the idempotency primitive), serialized read/write budgets (26 reads / 17 writes per minute, under the caps), lock detection → `ZohoLockedError` → `503 + Retry-After`. Tests run against a scripted fake transport — no live Zoho needed in CI.
- **Scratch base exists**: 30 tables duplicated structure-only for safe probing (production base is fenced off by plan rule).
- **Remaining**: Tasks 4–12 of Plan 1 (`docs/zoho-tables-fork-plan-2026-09-21.md`): live probe, base top-up (App ID + Data JSON columns), generated schema bindings, Kinde client + BFF auth guard, snapshot/revision/commit endpoints, the GRN vertical slice, and the production-base switch (gated on explicit go).
- **Design keeps the client untouched**: only `dbApi.ts` is rewritten; `sync.ts`, `localDb.ts`, `src/context/domains/`, and all pages carry over verbatim. Offline-first behavior — local copy, dirty-flag queue, retry — is the designed backpressure absorber for Zoho's rate limits.

### 3.4 Stack S — the reference app (what "done" looks like)

- React 19 + Vite + PWA plugin, Supabase, ~30.7k LOC of TypeScript across ~25 page files (~40 screens), 22 sync collections, 18 RLS policies (admin-only master writes enforced at the database), append-only ledger, d3 traceability graph, jsPDF reports and stickers, Roster and demand-driven Production Planning built and live-verified via headless browser (uncommitted in the source repo; UX overhaul committed as `e8ab1bd`).
- Its verification culture is the reason this codebase is trustworthy: `tsc` 0 errors, `oxlint` held at a 10-warning/0-error baseline, live headless-browser checks with screenshots (`../gui-test-screenshots/`, 23 sessions) — every feature lands browser-verified.

---

## 4. Architecture comparison

```
Stack A (Creator)                      Stack B (fork)
┌─────────────────────┐                ┌──────────────────┐   ┌─────────────┐
│ Creator "Plant Ops" │                │  React PWA       │──▶│  Kinde      │
│ 30 forms + Deluge   │                │ (offline-first,  │   │ (PKCE JWT)  │
│ engine, Zoho-hosted │                │  unchanged UI)   │   └─────────────┘
└────────┬────────────┘                └────────┬─────────┘
         │ native binding                       │ 3 REST calls: snapshot / revision / commit
         ▼                                      ▼ (Bearer JWT, JWKS-verified)
┌─────────────────────┐                ┌────────────────────┐
│ Creator datastore   │                │ BFF (Vercel fns)   │── maps docs ⇄ rows, enforces roles,
│ (masters mirrored   │                │ budgets + upserts  │   throttles writes, bumps revision
│  to Tables by sync) │                └─────────┬──────────┘
└─────────────────────┘                          │ REST, Self-Client OAuth
                                                 ▼
                                       ┌────────────────────┐
                                       │ Zoho Tables base   │──▶ Zoho Analytics reads it
                                       │ (App ID + Data JSON│   (same reporting as Stack A)
                                       │  + real columns)   │
                                       └────────────────────┘
```

The structural difference that drives everything else:

- **Stack A** puts the logic where the data is (Deluge runs inside Zoho), at the cost of putting the *UI* there too — forms and list views are Creator's, not ours.
- **Stack B** keeps the logic where the UX is (TypeScript in the browser + a thin BFF), at the cost of owning the pipe between them (the BFF, its budgets, its idempotency rules) and living inside Zoho's API rate limits.
- **Both** face the same absence — no multi-row transactions in Tables or Creator — and use the same answer: idempotency keys (doc id / App ID), keyed upserts, append-only ledger with negative reversals. This rule is already proven in the Supabase engine and ported into both designs (`zoho.ts` docblock; engine `appendLedger`).

---

## 5. Dimension-by-dimension comparison

Legend: ✅ strong · 🟡 workable with real cost · ❌ weak/structural.

| Dimension | A — Creator | B — React + Tables + Kinde | Notes |
|---|---|---|---|
| Time to first working posting | 🟡 GRN ~proven after multiple sessions of dialect archaeology | 🟡 9 plan tasks away, but each task is ordinary TypeScript | Both are close; B's remaining work is lower-risk per hour |
| Reaching full feature parity | ❌ 3–6 months (blueprint §7); every screen rebuilt | ✅ client already at parity by construction | B's parity is the *default state*, not the goal |
| Language & tooling | ❌ Deluge subset; no compiler; lint rules we had to invent (`embed-engine.mjs`) | ✅ TypeScript, `tsc`, `oxlint`, `vitest` — machine-verifiable | The single biggest daily-productivity gap |
| AI-agent buildability | ❌ import-then-fail loop; args must be registered in UI panels; imports create NEW apps (reseed each time); `getFormMetadata` truncates on imported apps; API reads return only REPORT columns | ✅ compiler gates + unit tests + headless-browser verification, all scriptable | Detail in §6.1 |
| Data layer | 🟡 native CRUD + link fields + validation; report-column read quirk; lookups need record IDs | 🟡 REST + query-param JSON; field-ID keyed; no transactions; Data-JSON pattern | Tables itself was pleasant to build against (`build-tables.mjs` — a day, start to verified) |
| Posting-engine correctness | 🟡 two-stage wiring (check on validate, post on success); no rollback — a failed posting leaves the record un-posted for the operator; numbering has no compare-and-swap (simultaneous-mint race unquantified) | ✅ engine already proven in TS for months; commit is idempotent by key; retry-safe | A's posting-failure path and numbering race need spikes before real use |
| Auth & user management | 🟡 Zoho users + profiles; coarser; admin = license admin | ✅ Kinde: hosted login, invites, password resets, roles; free tier ≥10k MAU | Plant will use ~5 users; Kinde free tier is effectively infinite |
| Authorization | 🟡 Creator profiles (per-form, not per-record) | ✅ BFF enforces the same rule RLS enforced (operator writes to the 9 admin-only masters rejected server-side) | `src/lib/tables.ts:67-82` defines the nine; `api/_lib/auth.ts` enforces |
| UI/UX | ❌ generic forms/lists; our UX overhaul does not transfer | ✅ full control; overhaul already shipped (`e8ab1bd`) | The plant's daily experience is the product |
| Offline / weak signal | ❌ none; kiosk-or-Wi-Fi is the honest answer (blueprint §5.2) | ✅ offline-first PWA with dirty-queue retry — *and* it's the rate-limit backpressure mechanism | Decisive for cold-room use |
| Traceability graph | ❌ Analytics exploration only | ✅ d3-force graph in-app | |
| Printing / stickers / PDF | 🟡 Creator print templates; per-printer fidelity unknown | ✅ jsPDF pipeline already working | |
| Integrations & ecosystem | ✅ native Zoho mesh (Analytics, Sheets, Schedules, email, approvals) | 🟡 anything-with-a-REST-API via BFF; Zoho Analytics still reads Tables directly | A's genuine structural advantage |
| Mobile | ✅ Creator mobile app for free | 🟡 PWA installable; good enough, not app-store native | |
| Testing & verification | ❌ Execute dialog = manual oracle; no automated tests possible | ✅ vitest against fake transports; tsc/oxlint gates; live browser checks with screenshots | §6.2 |
| Deployment & environments | 🟡 ADLM dev/stage/prod; every import = new app + reseed | ✅ git + Vercel; scratch base for tests; production base fenced by plan rule | |
| Observability & debugging | ❌ limited logs; failures found via dialog | ✅ BFF logs, HTTP statuses, reproducible unit tests | |
| Write throughput ceiling | ✅ Creator-native writes don't touch the REST budget | ❌ ~20 writes/min global per key ⇒ ~2–3 commits/min sustained; bursts queue on devices | §6.3 — the one constraint that could flip the decision |
| Read throughput | 🟡 Creator views paginate natively | 🟡 30 reads/min; v1 ships full snapshot (as today), delta reads are a planned optimization | |
| Cost (5 users, see §7) | ✅ $0 marginal for staff — the org already holds Zoho One; paid Creator licence only for users outside Zoho One | ✅ ~$0–20/mo (Vercel hosting; auth and database both $0 under Zoho One) | A wash for staff; Option B is cheaper only for non-Zoho-One users (Kinde invites are free) |
| User access model | 🟡 every app user must be a licensed Zoho identity — on the All Employee plan, non-employee users need paid seats or an org move to the costlier Flexible plan | ✅ app users live in Kinde (free); Zoho needs only 1–2 service identities | App-user growth is coupled to Zoho licensing only under A |
| Lock-in / exit | 🟡 logic in Deluge (portable only by rewrite); data exportable | 🟡 data in Tables (exportable); **App ID + Data JSON rows rehydrate into Postgres trivially**; client code is ours | B's data pattern is the better escape hatch |
| Maintenance burden | 🟡 zero infra to run, but logic changes deploy by manual paste into the builder — the live app can drift from the git master until re-exported | 🟡 we own the BFF (~600 lines) + dependency updates | A's drift exposure is ongoing, not one-time |
| Bus factor / team scaling | 🟡 business users can build small forms themselves | 🟡 future work needs engineers, but any React dev qualifies | |

---

## 6. What the lived experience actually taught (trade-off deep dives)

These are the sections to re-read if the recommendation is ever challenged — they are the empirical content behind the table above.

### 6.1 Stack A: low-code with an AI agent is a dialect-archaeology problem

The original assumption — "Deluge is JavaScript-ish, the agent will write it" — failed in a specific, repeatable way. The Creator editor accepts a *strict subset* of documented Deluge, and rejects it with unhelpful errors at *import or editor-save time*, not at a compile step. Concrete discoveries, each one costing a failed form or a debugging round-trip:

- The **string-replace saga**: three failed forms to settle that bare `.replace()` does not exist, regex-escaping rejects brace tokens like `{P}`, and the working form is a *third argument* — `replaceAll("{P}", prefix, false)` for literal mode, longest token first. Nobody documents this; we harvested it from editor behavior.
- **Serialization dialect**: the `.ds` import format has its own shapes (`functions { Deluge { … } }`, workflow entries with `record event = on add`); wrong shapes import as silently-dead blocks. The fix was to harvest a real export and mirror it byte-for-byte in `embed-engine.mjs`.
- **Editor facts that break automation**: function arguments must be registered in the UI's argument panel (code alone doesn't wire them); Execute dialog is the only test oracle; imports always create a NEW app (every engine iteration = re-import + reseed the 79 masters + 21 counters); `getFormMetadata` truncates on imported apps; API reads return only REPORT columns; `addRecords` lookups need internal record IDs, not names.
- The response was to **freeze the dialect in tooling**: `embed-engine.mjs` lints the engine (the ~12 banned constructs listed in §3.2) before it will emit a `.ds`. That made the engine writable — `mintDocNo` now compiles, executes, and numbers correctly — but note what this means: *we built a compiler-guard for a proprietary language as a prerequisite for productivity.* Stack B gets that guard for free from `tsc`.

**Net assessment:** Creator development converged, but each engine function costs meaningfully more than its TypeScript equivalent, and the verification loop stays manual (human-driven Execute dialog) forever. The remaining engine work (4 posting ports, workflow wiring, the concurrency and no-signal spikes) is weeks at this cadence — before any screens. The definitive pitfall ledger — platform gates (MCP FORBIDDEN, builder phantom writes on old Creator, publish caps, the accidental deletion), the full dialect divergence table, and the engine's v2→v4 revision history — is the Creator implementation report (`../roligt-foods-ops/docs/creator-implementation-report-2026-09-22.md`).

### 6.2 Stack B / S: compiler gates are why the React codebase is trustworthy

The Supabase app's development loop is the control group for §6.1: every change lands through `npx tsc -b` (0 errors), `npx oxlint` (held at 10 warnings / 0 errors), `npm test` on the fork, and a live headless-browser pass with screenshots before any "done" claim. The offline test harness (dummy Supabase env + fake session, port 5199) means the whole app runs without network. The fork inherits all of it — Plan 1 bakes the same gates into every task, and the BFF's `ZohoClient` was written test-first against a fake transport (`api/_lib/zoho.test.ts`), which is why the scratch-base phase went cleanly on first live contact.

The trade we accept here: **we own glue code forever**. The BFF's budgets, id-maps, upsert semantics, and auth guard are ours to maintain (~600 lines now, growing with mappers). Every Zoho Tables quirk (§3.1) is now encoded in our client rather than absorbed by a vendor runtime.

### 6.3 The one number that could flip the decision

**20 writes/min per API key, global, 5-minute lock on breach.** A GRN commit is ~5–8 writes (doc + ledger lines + counter + audit + revision) ⇒ ~2–3 sustained commits/min across the whole plant, and a burst past the cap stalls *everyone* for 5 minutes. The design absorbs this three ways (commits are small; the BFF throttles itself under the cap and returns `503 + Retry-After`; failed saves sit in each device's offline dirty-queue and retry), and the fallback if measured need ever exceeds it is a single always-on writer (Cloudflare Durable Object owning a global queue — deferred by design).

But it is **unproven at volume**, and Plan 1 Task 4 (the live probe) plus a realistic morning-rush simulation are exactly the go/no-go tests that must run before the remaining mappers are written. Creator's write path does not share this budget — that is Stack A's strongest structural argument.

Counterweight: the read budget (30/min) bounds the snapshot poll too. v1 ships full snapshots like today's app (fine at plant scale: 31 tables, thousands of rows); delta reads by `Time >= last sync` are a designed later optimization.

### 6.4 What went surprisingly well on both tracks

- **The Tables base build** was the smoothest operation of the whole program: one script, one day, 30 tables + 81 seeds, resumable phases, verified — and it's an asset *both* stacks keep.
- **Kinde's shape fits this app exactly**: two roles, hosted login, no passwords stored, free tier two orders of magnitude above the user count, and the BFF-is-the-RLS pattern (`api/_lib/auth.ts`) restores the exact security posture the 18 Supabase policies provided.
- **Creator's forms-over-masters** (vendors, customers, items, locations) genuinely are free CRUD — that slice of Stack A works today and could stay alive as a back-office console regardless of the main decision.

---

## 7. Cost (indicative — verify current vendor pages before budgeting)

**The org already holds Zoho One on the All Employee plan** (portal *Roligt Foods Pvt Ltd* — Creator implementation report §4), so Creator, Tables, and Analytics are included in existing staff seats — but **app access under Stack A is limited to licensed users**. Consequences:

- Regular staff: $0 marginal under both stacks — licensing is not a differentiator here.
- **Non-employee users (seasonal, contract, auditors) don't fit the All Employee model.** Under Stack A each must get a paid Creator licence (or a deliberately limited portal account), or the org moves Zoho One to the **Flexible User plan**, which licenses selectively but at a materially higher per-user rate (list ~2–3× the All Employee rate) — an org-wide cost change driven by one app's access needs.
- **Stack A couples app-user growth to Zoho licensing forever; Stack B does not.** The fork's app users live in Kinde (free tier); Zoho needs only 1–2 licensed service/admin identities for the Self-Client connection, plus Analytics consumers who are licensed anyway.

| Item | A — Creator | B — Fork | S — Supabase |
|---|---|---|---|
| Licence (staff on Zoho One) | **$0 marginal** | **$0** (Tables reached through the org's Zoho One via one service connection) | — |
| Hosting | none | Vercel ~$0–20/mo | Vercel ~$0–20/mo |
| Auth | bundled | Kinde free tier (≥10k MAU) | bundled |
| Users outside Zoho One (contractors, seasonal, auditors) | paid Creator licence each, limited portal account, or org move to Flexible plan (costlier per user) | free Kinde invite | free Supabase auth user |
| **Monthly, at the org's actual position** | **~$0** | **~$0–20** | ~$0–45 |
| Engineering cost of reaching parity | 3–6 months of porting (blueprint §7) | ~9 tasks to GRN slice; mappers after | zero (it *is* parity) |

Standalone pricing, for reference if the Zoho One position ever changes: Creator Professional ~$20/user/mo (Standard $8, Enterprise $25), Tables ~$5/user/mo (min 3 licenses) — that is the ~$125–150/mo figure for a 5-user standalone deployment. Two confirmations to raise with the Zoho account rep (per the implementation report): Creator-only licence cost for non-Zoho-One staff, and portal-user pricing if external order visibility is ever wanted.

Sources: [Kinde](https://kinde.com), [G2 — Kinde pricing](https://www.g2.com), [Zoho Creator pricing](https://www.zoho.com/creator/pricing/), [Zoho Tables pricing](https://www.zoho.com/tables/pricing/), [Zenatta — Zoho One 2026](https://zenatta.com), [Delve — Creator 2026 guide](https://delveio.com). Prices move; treat as order-of-magnitude.

---

## 8. Maintainability, deployment, security & UI/UX (deep dive)

### 8.1 Maintainability

| Aspect | A — Creator | B — Fork |
|---|---|---|
| Change cycle | Edit in the builder; logic ships by manual paste, live immediately, no review pipeline | Branch → automated gates (`tsc`, `oxlint`, `vitest`) → review → deploy; git state *is* the deployed state — no drift by construction |
| Drift exposure | Proven real: the repo engine/generator carry a superseded `replaceAll` literal flag (`, false)`) while the live app runs the verified `true` form — discovered 22 Sept, see §9 risk register | None by construction; deployments are versioned and reproducible |
| Testing | Execute dialog = a manual oracle; no automated regression possible | Unit tests against fake Zoho transports (the `ZohoClient` contract fixtures), plus the live headless-browser verification practice |
| Skills / hiring | Deluge + Zoho builder — niche; effectively one maintainer today | React/TypeScript — among the largest hiring pools in the market |
| Platform-change exposure | The old→new Creator migration changed the scripting dialect mid-build; future platform updates arrive uncontrolled | Zoho API changes caught by pinned probe fixtures in tests; npm dependencies updated on our schedule |
| Bus factor | High risk (single specialist + one person who knows the builder quirks) | Lower (any competent web developer; BFF is ~600 documented, tested lines) |

### 8.2 Deployment & environments

| Aspect | A — Creator | B — Fork |
|---|---|---|
| Mechanism | Builder edits (instant) or `.ds` import (creates a NEW app each time); the ADLM dev→stage→prod pipeline exists but hit the 11730 component cap and 11690 stale locks in practice and was bypassed by shipping a plain app | `git push` → Vercel build+deploy; preview deployment per branch; one-click rollback to any prior release |
| Test isolation | Manual copies; the seeded base must never be a fixture (plan rule) | Scratch base (structure-only duplicate) for all probing; production base fenced behind an explicit-user-go gate (Plan 1 rule) |
| Config & secrets | Connections configured in the builder; creds held by the platform | Env vars in Vercel; Zoho refresh token server-side only, never in the browser; BFF tokens in memory |
| Device updates | Creator mobile app via app store | PWA service-worker updates on next launch; no store review |
| User provisioning | Zoho admin console + the licensing steps of §7 | Kinde console — invite/revoke instantly, free |

### 8.3 Security

| Aspect | A — Creator | B — Fork |
|---|---|---|
| Identity | Zoho accounts; MFA at the Zoho account level; every app user is a licensed org identity | Kinde: hosted login (PKCE), RS256 JWTs verified by the BFF against JWKS on every call, MFA available, roles (Admin/Operator) as claims; **no passwords stored by us** |
| Authorization | Profiles + per-form/report sharing + field flags — coarse; anything per-record must be hand-written Deluge guards | BFF enforces the exact rule the 18 Supabase RLS policies enforced (operator writes to the 9 admin-only masters rejected server-side) — `api/_lib/auth.ts` is the RLS of this fork |
| Zoho credential exposure | N/A (users are Zoho identities) | **None on devices**: the Self-Client refresh token lives only in server env; browsers hold only a short-lived Kinde JWT |
| Data at rest | Zoho Tables, India DC | Identical — same base, same DC; Vercel holds only code + transient function state; Kinde holds identity metadata only |
| Data on devices | Nothing cached (cloud-only — the offline limitation inverted into a device-loss non-issue) | IndexedDB offline copy of plant data (operational data, not sensitive PII); sessions expire, sign-out clears state; device-loss runbook to confirm at go-live |
| Audit | Platform audit + the app's Audit_Log | Audit_Log with actor = Kinde email claim + BFF function logs + Kinde sign-in logs |
| Vendor footprint | Zoho only | Zoho (data) + Kinde (auth) + Vercel (hosting) — two added reputable specialists, each scoped to its role |

### 8.4 UI & UX

What exists in the React client (25 page files, ~40 screens, ~30.7k LOC) is not a template — it is two rounds of plant feedback made concrete:

- **Registers**: sortable/filterable grids on 12 tables (`tableSort`), row-click details, and `DocViewer` in-place edit dialogs — shipped as a dedicated UX overhaul (commit `e8ab1bd`, 26 files: "row-click details, in-place record dialogs, lab report batch links, grid sorting and filters").
- **Planning**: the demand table computes open orders − released finished goods per pack product; a **Plan button pre-fills the modal** (stage, net qty, tomorrow, "Open orders: N packs") with bulk math lines ("Fills 300 L of Coconut Water (bulk) · 0 L released — short by 300 L") and stage-aware quick-pick chips. This is a bespoke composition of report + form + math that has no Creator-native equivalent.
- **Traceability**: interactive d3-force lot/item graph (`traceGraph.ts`, `Traceability.tsx`) — click a node, walk its history. Under Creator this becomes an Analytics exploration (different product, different audience) or a Deluge-assembled view.
- **Output**: jsPDF report/label pipeline (`pdf.ts`, `stickers.ts`, `stickerPrint.ts`) working against plant printers; under Creator, print templates are rebuilt and re-verified per printer.
- **Platform feel**: installable PWA (`pwa.ts`, service worker) with offline indicator; role-aware navigation; login screen.
- **Iteration evidence**: the overhaul commit, a copy/accessibility review (`docs/copy-review-2026-09.md`) with a 6-sprint copy/a11y plan, and 23 headless-browser verification sessions (`gui-test-screenshots/`) — a working change-request loop measured in days.

Creator's ceiling (recorded in both the blueprint §6 and the implementation report §2.2): native list/detail/form patterns and themes — "good, but generic". Sortable registers exist natively; in-place dialogs, card layouts, the guided demand→plan flow, and the graph do not transfer, and the Creator UI phase was parked by decision during prototyping. Creator's one genuine UI advantage: minor layout, wording, and choice-list edits can be made by admin staff in the builder without a developer.

## 9. Risk register

| Risk | Stack | Severity | Mitigation / trigger |
|---|---|---|---|
| Write-rate ceiling breaks the morning GRN rush | B | **high** | Plan 1 Task 4 probe + rush simulation; if sustained need > budget even with queuing → single always-on writer (Durable Object), or reconsider A for the posting floor |
| Concurrent `mintDocNo` race — no compare-and-swap on the platform, two simultaneous mints could duplicate a number | A | high | Quantify with the concurrency spike before real use; per-day numbering prefixes are the structural workaround |
| Repo drift on the replaceAll literal flag: `docs/zoho-posting-engine.deluge` + `embed-engine.mjs` lint still carry `, false)` but runtime-verified literal mode is `, true)` (the live mintDocNo that minted `RFTC20260001` uses `true`; `false` = regex mode and throws on `{P}`) — a `.ds` regenerated from the repo today would fail token substitution at runtime | A | medium | Flip the flag in both files before any regeneration; the re-export-and-diff step (implementation report §5.2) is the systematic fix for this class of drift |
| Manual paste deployment drifts from the git master | A | medium | Re-export `.ds` and diff against the generator (already next-step #2 in the implementation report) |
| Engine port finishes but UX/offline regressions kill adoption | A | high | Known from blueprint §6 — this is why A is parked, not killed |
| Fork diverges from the Supabase app | B | medium | Accepted by design decision; features re-applied by hand when wanted |
| BFF single point of failure (bug in budgets/idempotency) | B | medium | Unit tests with fake transports; idempotent keyed upserts make retries safe; scratch base for all tests |
| Zoho API contract drift (undocumented shapes) | B | medium | Contracts pinned by probe fixtures; `zoho.ts` isolates every raw call |
| Kinde becomes paid/unfavourable | B | low | JWT/JWKS is commodity — swap to any OIDC provider behind the same `authenticate()` |
| Creator import-new-app reseeding fatigue | A | medium (already bitten) | Engine iteration is scriptable; data reseeding is the manual tail |
| Tables base edited directly, links drift | B | low | Snapshot rebuilds the id-map each boot; unresolvable links fail loudly (design §8) |

---

## 10. Recommendations

1. **Commit to the fork (Stack B) as the application track.** Finish Plan 1 Tasks 4–12: the live probe, the base top-up, Kinde wiring, the BFF endpoints, and the GRN vertical slice — in that order, because Task 4 is also the write-budget go/no-go.
2. **Run the two deciding measurements before writing more mappers** (they are cheap): (a) Task 4's contract probe on the scratch base, including whether `POST /records` can carry multiple records per call (halves the per-commit write count if yes); (b) a simulated morning rush — 5 GRNs across 2 devices in 3 minutes — watching queue behavior and the lock window. If both pass, Stack B's only serious unknown is retired.
3. **Park the Creator track deliberately, with two keepers**: (a) leave the live app as-is for reference and demos — it already proves the numbering engine; (b) optionally keep Creator forms as the *back-office master-data console* (vendors/customers/items CRUD — the slice it's genuinely good at), since masters ultimately land in Tables either way. Do not spend further engine-porting time unless Stack B fails a §9 trigger.
4. **Freeze the shared base as the contract.** The 30-table base, its App ID + Data JSON top-up, and the field-ID schema bindings become the interface both the BFF and any future Zoho-side tooling program against. Regenerate `api/_lib/baseSchema.ts` mechanically; never hand-edit.
5. **Keep the Supabase app deployable as the disaster-recovery path** until the fork has run a full production month. Its schema (`supabase/schema.sql`) and the fork's Data-JSON rows are mutually rehydratable, so DR is a data move, not a rewrite.
6. **Revisit triggers** (any one reopens the Creator option): sustained write need exceeding the budget with queuing in place; a requirement for app-store-native mobile; the org standardizing on Zoho One with a mandate to run everything in it; or headcount dropping to zero engineers available to own the BFF.

---

## 11. Appendix — evidence index

| Claim in this report | Evidence |
|---|---|
| Fork design & BFF shape | `docs/zoho-tables-fork-design-2026-09-21.md` |
| Fork plan & task state (Tasks 1–3 done) | `docs/zoho-tables-fork-plan-2026-09-21.md`; git log of this repo (5 commits) |
| Tables base build, contracts, quirks | `scripts/zoho/build-tables.mjs` (header docblock); `scripts/zoho/tables-state.json` |
| Rate limits | `../zoho-build-probe/help.html` (vendor help bundle, verified) |
| Creator app & engine | `scripts/zoho/roligt-plant-ops.ds`, `scripts/zoho/roligt-plant-ops-engine.ds`, `docs/zoho-posting-engine.deluge` |
| Creator implementation record (pitfalls, dialect table, access/licensing, next steps) | `../roligt-foods-ops/docs/creator-implementation-report-2026-09-22.md` |
| Deluge dialect bans & `.ds` splicing | `scripts/zoho/embed-engine.mjs` (lint block) |
| Creator-track plan & effort estimate | `docs/zoho-rebuild-blueprint.md` (§5 spikes, §6 non-transferables, §7 effort) |
| MCP breakage & REST bypass | `docs/zoho-mcp-support-ticket.md` |
| Client size, collections, admin-only rules | `../roligt-foods-ops/src` (~30.7k LOC), `src/lib/tables.ts:72-98` |
| RLS baseline | `../roligt-foods-ops/supabase/schema.sql` (18 policies) |
| Live-browser verification practice | `../gui-test-screenshots/` (23 sessions); commit `e8ab1bd` (UX overhaul) |
| Session history & numbering proof | memory: `roligt-zoho-creator-question.md`, `roligt-session-state.md` |

*Report written 2026-09-22. Pricing indicative as of that date; verify before budgeting.*
