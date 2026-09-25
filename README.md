# Roligt Foods — Operations Control (Zoho Tables fork)

Plant operations for a tender-coconut processor, from the load arriving at the gate to
the challan leaving with the vehicle: procurement, extraction and melange production,
QC release, packing, orders, dispatch, stock and traceability.

Everything the plant does is recorded as a document, and every document writes lines
into one append-only stock ledger. Nothing stores a balance — every quantity, cost and
valuation on every screen is folded out of that ledger. That is the single idea the
rest of the codebase follows from.

This fork replaces the old Supabase backend with **Zoho Tables behind a BFF**: a Vite
SPA in `src/`, and serverless handlers under `api/` (`/api/snapshot`, `/api/revision`,
`/api/commit`) that hold the Zoho credentials and enforce roles. The design and the
migration plan live in `docs/zoho-tables-fork-design-2026-09-21.md` and
`docs/zoho-tables-fork-plan-2026-09-21.md`.

## Running it

```bash
npm install
cp .env.example .env          # fill in the Zoho keys (see below)
npm run build                 # typecheck + build the SPA into dist/
npx tsx scripts/dev-server.mjs  # serves dist/ + the api/ handlers on :3000
```

`npm run dev` runs the Vite dev server for UI work only — it does not serve the BFF;
use `scripts/dev-server.mjs` for the full app locally (`vercel dev` works too, in a
linked checkout). On Vercel, `vercel.json`'s SPA rewrite plus the `api/` handlers are
the whole deployment; the same env keys go in the project settings.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server (UI only, no BFF) |
| `npm run build` | Typecheck and production build |
| `npm test` | Vitest suite (unit + BFF logic against fakes) |
| `npm run lint` | oxlint |

### Environment

Server-side (BFF only — never give these a `VITE_` prefix):

- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` — the self-client the
  BFF refreshes its access token with
- `ZOHO_BASE_ID` — the base the app reads and writes
- `ZOHO_DC` — data centre, defaults to `tables.zoho.in`
- `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD` — WorkOS AuthKit.
  All three present means auth is live: sign-in happens on WorkOS's hosted page and
  the BFF authenticates every request from the sealed `wos-session` cookie. The API
  key is the M2M `sk_` secret; the cookie password is 32+ random characters.
- `WORKOS_ORG_ID` — the one "Roligt Foods" organization, printed by
  `scripts/workos/seed-rbac.mjs`
- `WORKOS_REDIRECT_URI` — optional pin, e.g. `https://<production-domain>/api/auth/callback`,
  so production cookies carry `Secure` (unset defaults to localhost http)
- `ALLOW_DEV_SESSION=1` — dev only: with WorkOS not configured and
  `NODE_ENV !== 'production'`, anonymous callers get a dev session (every
  permission, or none via the `x-dev-role` header). Once WorkOS is configured, or
  in production, the flag is ignored and anonymous callers get 401. Never set it
  in Vercel.

Browser-side (a flag only — the SPA never talks to WorkOS):

- `VITE_WORKOS_CLIENT_ID` — present means the SPA expects real auth (boot does one
  `GET /api/auth/session`; the login button redirects to `/api/auth/start`). Absent
  means the dev session with the Admin/Operator picker and zero `/api/auth/*`
  traffic — that absence is what the no-credential local UI harness relies on.

### Authentication (WorkOS AuthKit)

Sign-in is a **BFF-owned session**, not browser tokens: the login button redirects
to WorkOS's hosted (Roligt-branded) page, `/api/auth/callback` exchanges the code
server-side and seals the `wos-session` httpOnly cookie, and every data request
authenticates from that cookie — the BFF refreshes it server-side when the access
token ages out, and forwards the re-sealed cookie on the response. The SPA holds
no tokens at all; its entire auth surface is four same-origin URLs (`start`,
`callback`, `signout`, `session`).

Authorization is **permissions, not roles**, and **every permission is a page**:
the catalog in `src/lib/permissions.ts` is one `page.*` slug per screen
(`src/lib/pages.ts`) — Settings and the two Administration screens included;
there is no separate "manage" vocabulary. The set rides inside the session, the
BFF's commit gate enforces it server-side, and the UI's routes, nav and actions
derive from the same list. Roles are how WorkOS groups permissions for
assignment — admins compose them at runtime on the **Users** and **Roles &
Permissions** screens (under Administration), ticking pages per role; no new
role is ever a code change. The Roles screen also creates any catalog slugs
missing from WorkOS as it loads, so a new page permission is tickable the
moment an admin first looks. Every action
there files one audit row and bumps the revision like any other write, and a
permission change reaches a signed-in user on their next poll, no reload. The
Users screen can also remove someone's access (the org membership goes, the
WorkOS account survives) or delete them permanently — every access-revoking
action (deactivate included) resolves the target from the live member list,
never the request body, so your own row is always refused no matter what the
body claims, and none of them can leave the app without a single active admin.
WorkOS's sealed session cookie outlives the membership it came from, so
`authenticate()` also checks a minute-cached mirror of active members — a
removed or deactivated user's live session is refused on their next request
(the check needs `WORKOS_API_KEY` + `WORKOS_ORG_ID`; without them the cookie
alone decides, as before). Roles cannot be deleted through the API (WorkOS
exposes no environment-role deletion); a role nobody holds and nothing ticked
is inert — clear its permissions, or delete it in the WorkOS dashboard.

Provisioning. The workspace is "Roligt Foods" (team IT), with a **Staging**
sandbox and a **Production** environment. The Staging environment is fully
provisioned (2026-09-25, via the WorkOS MCP) and is what localhost runs
against; Production is provisioned at switch-over:

1. **Staging (done):** the "Roligt Foods" organization, the page-permission
   catalog, the seeded `app-admin` role (the whole catalog), "Multiple roles per
   user" enabled, redirect URI
   `http://localhost:3000/api/auth/callback` + post-logout `/`, magic-auth
   (email code) sign-in with public signup off, branding (display name
   "Roligt Foods Ops", buttons `#253d2b`, links `#3e5b45`, background
   `#f5f0e6`, Source Sans 3, heading "Sign in to Roligt Foods Ops"), and the
   first admin invited (`it.infra@roligtfoods.com`, App Admin).
2. **Staging (done):** the M2M API key is pasted (`WORKOS_API_KEY`) and
   `VITE_WORKOS_CLIENT_ID` is on, so localhost runs real auth against Staging.
   Still to do in the dashboard: upload the logo + favicon (the PWA mark,
   `public/favicon.svg`) in the branding editor and set logo style to Logo —
   file uploads can't go through the MCP.
3. **Region: US** (resolved 2026-09-25 by probing both hostnames with the M2M
   key: `api.workos.com` answers, `api.eu.workos.com` does not). `.env` pins
   `WORKOS_API_HOSTNAME=api.workos.com`; the code's default is
   `api.eu.workos.com`, so the Vercel project must carry the same override.
4. **The seeded role is `app-admin`, never `admin`** — slug `admin` is WorkOS's
   own system role (slugs are unique, and the seed script reconciles by slug, so
   it must never target the system role). The system `member`/`admin` roles
   carry none of the app's permissions and are hidden from the app's screens; a
   user holding no roles at all is an operator (the day's work only).
   `npx tsx scripts/workos/seed-rbac.mjs` is idempotent and safe to re-run
   after a catalog change.
5. **Production environment (at switch-over):** repeat the provisioning — the
   MCP refuses production mutations until the dashboard account has MFA
   configured, so either enable MFA and re-run the same calls, or follow the
   dashboard checklist. Register `https://roligt-foods-ops.vercel.app/api/auth/callback`
   + post-logout `/` there, not on Staging.
6. Vercel project envs (when the fork goes live): the two Zoho sets above plus
   `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`,
   `WORKOS_ORG_ID`, `VITE_WORKOS_CLIENT_ID` — the Production environment's
   values, its own org and API key. Functions run in `fra1` (`vercel.json`),
   between the US WorkOS and India Zoho endpoints. Do not set
   `ALLOW_DEV_SESSION` in production, and remove any retired provider keys from
   the project when the swap is verified.

Preview deployments are not registered redirect URIs — test auth on localhost
(against Staging) and the production domain (against Production) only.

### Scratch vs production base

`api/_lib/baseSchema.ts` is **generated** (`scripts/zoho/gen-base-schema.mjs`) and
pinned to one base — its `BASE_ID` is the base every table id in it belongs to.
Switching bases means switching `ZOHO_BASE_ID` in `.env` *and* regenerating the
schema; doing only one half is caught at boot: the shared client refuses to start
(`assertBaseMatch` in `api/_lib/shared.ts`) when `ZOHO_BASE_ID` and the generated
`BASE_ID` disagree. `scripts/zoho/make-scratch.mjs` builds a disposable scratch base
for e2e; the dev server's `--seed-scratch` seeds it and refuses any other base.

The day's work (receive, produce, pack, dispatch) is open to every signed-in
caller; masters, the staff register, settings, audit removals and user
administration each need their page's tick from `src/lib/permissions.ts` —
enforced in the BFF's commit path, not just the UI.

A `page.*` tick both opens and **narrows**: a caller holding any of them (from
any of their roles — the sets union) is scoped to exactly the pages ticked,
and a caller holding none keeps the whole day's work — that is the operator.
That is how the admin composes a lab tester (Quality Control, Control Samples,
Lab Reports, Test Parameters) or a procurement clerk at runtime, with no code
change; a full administrator is just a role with every page ticked, not a
special case. A ticked page carries that page's writes: the BFF refuses a
scoped caller's commits to any other page's tables (`grns` belongs to
Procurement, `qcs` to Quality, `packing_runs` to Packing and Control Samples
together, the staff register to the Roster page…), and the config keys a page
owns outright — the report types for Test Parameters, the default areas for
Storage — pass on the page slug while every other key needs Settings; a
partial config payload that would drop another key is refused outright. Page
ticks shape the nav, the routes and the writes — reads stay open: the snapshot
is the whole plant for every signed-in caller, so a scoped user is a trusted
member of staff with a focused app, not a row-level read boundary.

This app first shipped (2026-09-25) with five `*.manage` permissions beside
the page slugs; they became the page ticks their screens carry (Settings,
Users, Roles & Permissions, the Roster's staff register, the Audit page's
removals) later the same day, before any production environment existed — the
seed script migrated every holder with their reach preserved exactly, and the
old slugs were deleted from WorkOS.

## How the code is laid out

```
src/lib/        the rules — pure, no React, no network
src/context/    state, persistence and every write the app can make
src/pages/      one screen per route
src/components/ shared UI
api/            the BFF: handlers + _lib (auth, Zoho client, commit, snapshot)
scripts/zoho/   base tooling: build tables, generate schema, probe, seed scratch
```

`src/lib` is deliberately free of React and of any network client, so the arithmetic
that matters — landed cost, usable yield, by-product cost allocation, stock folding,
document numbering — can be read on its own. If you are adding a rule, it goes there.

Worth reading first, in this order: `src/types.ts` (the domain, heavily commented),
`src/lib/stock.ts` (how a balance is derived), `src/lib/posting.ts` (what each document
is allowed to do and the ledger lines it writes).

## Things to know before changing anything

**A stock row is item · lot · location · status · expiry.** All five. Two runs off one
batch, packed on different days into the same freezer, are two different rows and are
not interchangeable stock. Use `rowKey` / `isRow` from `src/lib/stock.ts` whenever you
name a row — dropdowns, React keys, allocation maps. Getting this wrong has caused the
same bug more than once.

**Check totals, not rows.** Two lines of one form can name the same lot. Compared one
by one each clears; added up they take more than there is. Aggregate first.

**Documents are edited by reversing and re-posting.** Every `update*` deletes its own
ledger lines and writes them again, and validates against stock with its own lines
excluded (`withoutDoc`). Quantities freeze once something downstream draws on them.

**Never sum across units of measure.** Coconuts are pieces, beetroot is kilograms. Use
`sumByUom` / `fmtByUom`.

**Dates come from the local clock.** Use `toDateKey`, never `toISOString().slice(0,10)`
— in IST that is yesterday until half past five in the morning.

## Persistence

Each document is a row in its own table (plus a `Data JSON` payload column). A save
works out what changed against the last state the server is known to hold
(`src/lib/sync.ts`) and posts only that diff to `/api/commit`, so two operators posting
two different receipts are two independent writes rather than a race to overwrite the
plant. Changes are written to the device first (`localStorage`), so work done without
signal survives a refresh and uploads on reconnect. Clients poll `/api/revision` to
notice each other's postings.

Because the browser holds nothing but the sealed session cookie, **permission
separation is enforced by the BFF**, not just by the UI: masters, staff and config
each need their permission, the day's work is open to every signed-in caller, and the
audit trail is insert-only — a commit naming an audit App ID that already exists is
skipped, never rewritten.

Every write is a keyed upsert (by App ID, Series or Setting), which is what makes a
commit safe to retry after a partial failure: the second attempt re-writes the same
rows instead of duplicating ledger lines. Zoho's per-key rate limit is budgeted in the
client (`api/_lib/zoho.ts`); a lock surfaces to the UI as 503 + Retry-After.

Two people editing the *same* document within a save window still resolve
last-write-wins on that row; the poll then shows the other's version. That is a far
narrower window than the whole plant, but it is not zero.
