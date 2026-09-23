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
- `ALLOW_DEV_SESSION=1` — dev only: with no token, no `KINDE_DOMAIN` and
  `NODE_ENV !== 'production'`, anonymous callers get a dev session (Admin, or
  Operator via the `x-dev-role` header). Under production or a configured Kinde
  tenant this flag is ignored and anonymous callers get 401.
- `KINDE_DOMAIN` / `KINDE_AUDIENCE` — optional; once set, the BFF verifies bearer
  JWTs against the tenant and refuses the dev session

Browser-side (optional Kinde SPA credentials; absent means the dev session):
`VITE_KINDE_DOMAIN`, `VITE_KINDE_CLIENT_ID`, `VITE_KINDE_REDIRECT_URI`,
`VITE_KINDE_LOGOUT_URI`.

### Scratch vs production base

`api/_lib/baseSchema.ts` is **generated** (`scripts/zoho/gen-base-schema.mjs`) and
pinned to one base — its `BASE_ID` is the base every table id in it belongs to.
Switching bases means switching `ZOHO_BASE_ID` in `.env` *and* regenerating the
schema; doing only one half is caught at boot: the shared client refuses to start
(`assertBaseMatch` in `api/_lib/shared.ts`) when `ZOHO_BASE_ID` and the generated
`BASE_ID` disagree. `scripts/zoho/make-scratch.mjs` builds a disposable scratch base
for e2e; the dev server's `--seed-scratch` seeds it and refuses any other base.

Roles are `Operator` (receive, produce, pack, dispatch) and `Admin` (that, plus
masters, settings, numbering and clearing records) — enforced in the BFF's commit
path, not just the UI.

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

Because the browser only ever holds the caller's own session token, **role separation
is enforced by the BFF**, not just by the UI: masters and config are admin-write, the
day's work is operator-write, and the audit trail is insert-only — a commit naming an
audit App ID that already exists is skipped, never rewritten.

Every write is a keyed upsert (by App ID, Series or Setting), which is what makes a
commit safe to retry after a partial failure: the second attempt re-writes the same
rows instead of duplicating ledger lines. Zoho's per-key rate limit is budgeted in the
client (`api/_lib/zoho.ts`); a lock surfaces to the UI as 503 + Retry-After.

Two people editing the *same* document within a save window still resolve
last-write-wins on that row; the poll then shows the other's version. That is a far
narrower window than the whole plant, but it is not zero.
