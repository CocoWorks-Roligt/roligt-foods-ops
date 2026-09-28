# Zoho Apptics — dev/staging trial integration & MCP connection

**Date:** 2026-09-28
**Status:** Implemented, awaiting the Apptics console token
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

## 4. Console setup (the one remaining manual step)

1. Sign in at **apptics.zoho.com** with the Zoho account.
2. Create a **Project** (e.g. "Roligt Foods Ops") → **Add App** → platform **JavaScript/Web**, name it (e.g. "ProductionDashboard").
3. Copy the **apptics snippet** it shows. From it take the `aaID` value (and the `DC` code, if one appears) — that is the token:
   ```
   # .env.local
   VITE_APPTICS_APP_TOKEN=<aaID from the snippet>
   VITE_APPTICS_DC=<DC from the snippet, if present>
   ```
4. Add the same value to the Vercel project's **Preview** (and Development) environments.
5. Open a preview deployment (or `npm run dev`), click around, and check the Apptics console for sessions/screens/events.

To enable production later: set the same var in the Vercel **Production** environment and redeploy — that is the entire switch. Decide the production data posture first.

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

## 6. Verification checklist (re-run after the token exists)

1. `npm test` — suite green (274 as of this writing; facade + adapter cases included).
2. Tokenless build: no `aaID`/`appticssettings`/`enableGlobalErrorHandler` strings in `dist/`; `sw.js` has no `vendor/apptics.js` entry.
3. Token build (`VITE_APPTICS_APP_TOKEN=… npm run build`): `dist/vendor/apptics.js` (56 kB) exists, precache count grows by one, `db_commit` literal present.
4. Local end-to-end: token in `.env.local`, `npm run build && npx tsx scripts/dev-server.mjs` — Network tab shows Apptics traffic; navigate routes (screens); save a document (`db_commit`); DevTools offline toggle (`connectivity`); `Promise.reject(new Error('apptics-test'))` in the console (crash).
5. Vercel preview deploy: data lands in the Apptics console (expect ingestion latency); production URL issues **no** Apptics requests.
6. MCP: `claude mcp list` shows `zoho-apptics` connected with a small Apptics-only catalog; exercise one read (e.g. event counts for the preview's app version, filtered to today).

## 7. Recommended next actions

1. Create the console project + web app (§4) and paste the token into `.env.local` and Vercel Preview.
2. Run the §6 checklist end-to-end on a preview deployment.
3. After a week of staging use, decide keep/kill; if keeping, have the production data-posture conversation before ever setting the token in Production.
4. If finer per-document properties are wanted (e.g. QC decision status on the event), add them at the domain save functions — the facade needs no changes.

**References:** [Apptics glossary](https://www.zoho.com/apptics/resources/glossary.html) (event/screen/session vocabulary), `@zoho_apptics/apptics-js-sdk` v1.0.2 on npm (the vendored script's source).
