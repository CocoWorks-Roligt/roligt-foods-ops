# Zoho Apptics — dev/staging trial integration & MCP connection

**Date:** 2026-09-28
**Status:** Token wired 2026-09-28 — trial live locally and in Vercel Preview/Development
**Scope:** Client-side product analytics (crashes, screens, events) for the ProductionDashboard SPA; Apptics MCP server for Claude Code
**Audience:** CocoWorks ops/dev

---

## 1. What this is and why

The repo had zero analytics or error reporting — no Sentry, no `window.onerror`, nothing. To evaluate Zoho Apptics before committing, the SPA now carries a **staging-gated** Apptics wiring: production builds contain no SDK bytes at all (verified by build, not by promise). Apptics is a **client-side** product-analytics platform — there is no Node backend SDK, so `api/` is untouched and the Zoho Tables read budget (`Budget(26)`) is unaffected.

## 2. The gate — three layers, keyed on one env var

Everything keys on `VITE_APPTICS_APP_TOKEN` (the `aaID` printed inside the Apptics console's snippet):

| Layer | Where | What it does when the token is absent |
| --- | --- | --- |
| Build | `vite.config.ts` (`appticsVendorPlugin`) | The plugin that emits `vendor/apptics.js` from the npm package is not even installed — production `dist/` carries no SDK file, and the workbox precache (`globPatterns`) has nothing to pick up. |
| Runtime | `src/lib/apptics.ts` (`APPTICS_CONFIGURED`) | Every facade export is a no-op; the script tag is never created. Mirrors `WORKOS_CONFIGURED` in `src/lib/authMode.ts`. |
| Compiler | Rollup | With the var undefined, `Boolean(undefined)` folds to `false` and the trial's code and string literals are dead-code-eliminated out of production chunks. |

Verified 2026-09-28: a tokenless build contains **zero** occurrences of SDK-distinctive strings (`aaID`, `appticssettings`, `enableGlobalErrorHandler`) anywhere in `dist/`, and `sw.js` does not reference `vendor/apptics.js`; a token build emits the 56 kB script, precaches it (78 vs 77 entries), and keeps the event literals live.

### Why a script tag, not an npm import

The package (`@zoho_apptics/apptics-js-sdk` v1.0.2) **cannot be imported as a module**: it has no exports at all and its IIFE binds `this`, which is only `window` under a classic `<script>` tag — the exact form the console's snippet uses. So `src/lib/appticsSdk.ts` stages `window.appticssettings._defaultoptions = { aaID, DC }` and injects `/vendor/apptics.js` at runtime; the vite plugin is where that file comes from (a build asset, or node_modules straight through dev middleware). The dependency stays in `package.json` as the file's source of truth.

### Where the token is set

- **Local:** `.env.local` → `VITE_APPTICS_APP_TOKEN=…` (and optional `VITE_APPTICS_DC=IN` — use the DC the console snippet shows).
- **Vercel Preview + Development:** project env vars, Preview/Development environments only.
- **Vercel Production: never.** Absence *is* the gate. `loadEnv` reads `process.env` too, so dashboard vars reach the build without any file.

## 3. What is instrumented

Crash capture is **opt-in** in the SDK: the adapter calls `enableGlobalErrorHandler(true)` on load, which arms the `window` error and `unhandledrejection` handlers the SDK registers. Beyond that, everything hangs off existing seams — no new UI, no `api/` changes:

| Signal | Event | Seam |
| --- | --- | --- |
| Every route change | screen (the pathname) | `AppticsPageViews` in `src/App.tsx` |
| Every save, its outcome and which document kinds it carried | `db_commit` `{ ok, reason, tables, rows }` | `saveDb` in `src/lib/dbApi.ts` — the one write path every flow (GRN, QC, dispatch, packing…) funnels through, so `tables` is the honest per-flow breakdown |
| Zoho budget surfacing in the field | `db_throttled` `{ retryAfterSec }` | the 503 branch of `api()` in `src/lib/dbApi.ts` |
| Dead session | `session_expired` | the 401 branch, beside `notifyUnauthorized()` |
| Offline/online transitions | `connectivity` `{ state }` | `PwaContext.tsx` listeners |
| Operator identity | `setUser(email)` | one effect on `session` in `AuthContext.tsx` |

Events fired before the script finishes loading are buffered (capped at 200) and flushed on boot; if the script fails to load, the buffer is dropped and the facade stays silent for the session — observability must never become a dependency. Note the `db_commit` event also fires for offline retries (~1/30 s while offline): expected, and the `reason` field tells them apart.

## 4. Console setup (done 2026-09-28)

The console's platform tile for the web SDK is labelled **Browser** (not "JavaScript/Web"). What was created:

| | |
| --- | --- |
| Project | Roligt Foods Ops (projectid `984000000004006` — visible to the MCP via `getUserProjects`) |
| App | Browser, identifier tagged **Development** — trial data stays separate from any future Production identifier |
| `aaID` | `984000000004011` → `.env.local` and Vercel Preview/Development as `VITE_APPTICS_APP_TOKEN` |
| `DC` | `IN` — the snippet's domain is `apptics.zoho.in`; the SDK maps the two-letter code (`IN → quartz.zoho.in`) |

The console's own snippet loads a per-app init script from Zoho's CDN; we serve the equivalent npm file locally as `vendor/apptics.js` so the build gate and precache stay ours (§2).

**Vercel note:** `vercel env add` refuses names matching `*TOKEN` without an explicit type. This one is intentionally public — the `aaID` is a client token in the same class as `VITE_WORKOS_CLIENT_ID` — so it went in as `--type config` for **Preview and Development only** (verified: `vercel env ls production` lists no apptics vars).

To enable production later: add a **Production** identifier under the same console project (it gets its own `aaID`) and set that var in the Vercel Production environment and redeploy — that is the entire switch. Decide the production data posture first.

## 5. Connecting the Apptics MCP server to Claude Code

The server is already created and connected (2026-09-28):

```
claude mcp add --transport http zoho-apptics \
  https://zoho-apptics-60088765036.zohomcp.in/mcp/761dfd74df05370d5355860b27c09163/message
```

- Built on **mcp.zoho.com**: Create MCP Server → add **only the Apptics** integration → OAuth with the Zoho account on first use. Agents then act under that user's permissions, with an audit trail.
- **Scope discipline — the cliq lesson:** the previous zoho-cliq MCP exposed a ~150-tool catalog and was disabled 2026-09-26 for blowing up context (backup at `~/.claude.json.backup-2026-09-26-zoho-cliq`). This server must contain exactly one integration. After connecting, run `claude mcp list` and inspect the tool catalog; if it enumerates a Zoho-suite-sized list, **recreate the server scoped to Apptics** rather than filtering client-side.
- After a session restart, the tools appear; OAuth opens in the browser on first call.

### Features/tools wanted from the Apptics MCP

What would make the trial answerable from Claude Code without opening the console:

- **Crash reports** — list + detail, filtered by app / app-version / date / platform.
- **Events** — counts and details for defined and custom events (what §3 instruments).
- **Remote logs** — retrieval for a session or device.
- **In-app feedback** — thread listing and statuses.
- **Users/sessions** — lookup by the operator email `setUser` attributes.
- **Apps & versions** — enumeration, to correlate with deployments.

## 6. Verification checklist (re-run 2026-09-28 with the real token)

1. ✅ `npm test` — 274 green. One fix along the way: vitest loads `.env.local` into `import.meta.env`, so the real `VITE_APPTICS_DC` leaked into the facade test that pins boot args — the suite now stubs DC empty in `beforeEach` (the test file's docblock had promised exactly that isolation).
2. ✅ Tokenless build (`.env.local` moved aside): 77 precache entries, zero `aaID`/`appticssettings`/`enableGlobalErrorHandler`/`apptics` strings anywhere in `dist/`, no `vendor/` directory.
3. ✅ Token build: 78 precache entries, `dist/vendor/apptics.js` (56 kB / 55,668 bytes), `db_commit` literal live in the `dbApi` chunk, `sw.js` precaches the vendor entry.
4. ◐ Local end-to-end: the harness serves `vendor/apptics.js` (200) at `http://localhost:3000` — browser click-through pending (navigate routes → screens; save a document → `db_commit`; DevTools offline toggle → `connectivity`; `Promise.reject(new Error('apptics-test'))` → crash).
5. ⬜ Vercel preview deploy: data lands in the Apptics console (expect ingestion latency); production URL issues **no** Apptics requests.
6. ◐ MCP: authenticated read works (`getUserProjects` → Roligt Foods Ops, projectid `984000000004006`); data queries wait on §4's browser click-through.

## 7. Recommended next actions

1. ~~Create the console project + web app (§4) and paste the token into `.env.local` and Vercel Preview.~~ Done 2026-09-28.
2. Browser click-through on `http://localhost:3000` (or the next preview deploy), then confirm sessions/screens/`db_commit` in the console or via the MCP.
3. After a week of staging use, decide keep/kill; if keeping, have the production data-posture conversation before ever setting a Production token.
4. If finer per-document properties are wanted (e.g. QC decision status on the event), add them at the domain save functions — the facade needs no changes.

**References:** [Apptics glossary](https://www.zoho.com/apptics/resources/glossary.html) (event/screen/session vocabulary), `@zoho_apptics/apptics-js-sdk` v1.0.2 on npm (the vendored script's source).
