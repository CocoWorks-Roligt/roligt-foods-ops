# Performance audit & staged optimization — 2026-09-25

Ground rules for this pass (agreed): measure first, zero behavior change, one
optimization per step, order by measured impact, tests stay green. The app is
live and correct; the work is to make it faster and cheaper to change, not
different. All eight rows of the audit were executed to completion this pass —
four as changes, four as measured dismissals.

## Audit table — final state

| # | Hotspot | Measured baseline (tool) | Outcome |
|---|---|---|---|
| 1 | Boot bundle: all 26 route pages eagerly imported | eager fetch 233.3 KB gz; main chunk 831 KB raw (`dist/` + `gzip -c`) | **changed** — eager 233.3 → **147.3 KB gz (−37 %)**, main script −67 % raw |
| 2 | Full-screen Loading gate until auth + snapshot | gate at AppContext render; reconcile = ≥1 network RTT before first paint | **changed** — mirror-first paint; first-run keeps the gate |
| 3 | One context, whole plant state, no selectors | 48 `useApp()` sites / 39 files; representative save **1.42 ms** render+commit, each mounted consumer ×1 (measured, see test) | **measured, dismissed** — 11× inside a 16 ms frame budget |
| 4 | Monolithic pages mixing derivation with UI | Procurement 1,080 / Planning 1,041 / Orders 922 / LiveReports 1,248 lines | **changed** — ~485 lines of pure derivation moved to `src/lib`, 31 new tests; LiveReports a justified null |
| 5 | Registers unvirtualized | live base: **213 rows across 31 tables** (2 GRNs, 0 batches, 0 dispatches) | **dismissed** — nothing to virtualize; trigger below |
| 6 | 3,640-line global stylesheet | 9.27 KB gz shipped; **18/303 classes statically unreferenced ≈ 0.3 KB gz** (mostly `kind-${x}` dynamic-name false positives) | **dismissed** — 16× smaller than the JS, dead share ~3 % |
| 7 | Snapshot growth vs ~5 MB mirror ceiling | 213 rows today; projection below | **design note written, not implemented** (per the rules of this pass) |
| 8 | Dependency audit | 8 runtime deps; every heavy one (jspdf, autotable, html2canvas, dompurify, d3-force) already in lazy chunks | **dismissed** — nothing to remove |

## Step 1 — route-level code splitting (2026-09-25)

`src/App.tsx`: 25 route pages become `lazy()` imports (named-export re-wrap, the
idiom Traceability already used); Dashboard and Login stay eager (landing route
and pre-auth screen). `src/components/Layout.tsx`: one `<Suspense>` around
`<Outlet>` — the nav, offline bar and header stay mounted while a route chunk
lands; the fallback is the same `Loading…` empty-state look as the boot gate.

- eager **233.3 → 147.3 KB gz** across 13 files; main script **222.9 → 85.1 KB
  gz, 831 → 273 KB raw (−67 % parse volume)**; LiveReports is its own 15.0 KB
  gz chunk, Production 7.9, Traceability 7.6.
- PWA precache: 75 entries (was ~30) — every route chunk precached at SW
  install, so offline behavior is unchanged. Stale-shell users keep the old
  bundle until they accept the UpdatePrompt, as with any deploy.
- Rollback: `git checkout src/App.tsx src/components/Layout.tsx` — two files,
  no state, API or sync change.

## Step 2 — mirror-first boot (2026-09-25)

`AppContext` read the device mirror only *inside* the reconcile effect, so even
the fast path waited one network round trip (auth-session fetch + one
`/api/revision` read against Zoho) behind a full-screen gate before painting.

Change (`src/context/AppContext.tsx`): the provider's initial state now comes
from `readLocal()` when a mirror exists — the same copy the app renders
wholesale when offline — and the gate renders only when there is no mirror at
all (first run / cleared storage), where flashing seed masters for a plant
with real ones would be a lie. The reconcile effect is untouched: it still
verifies (clean mirror + same revision = one read, no snapshot) or replaces
with the server copy; `ready` still gates the poll and the save effect, so a
save attempted during reconcile is persisted the moment it completes.

- Verified by `src/context/AppContext.render.test.tsx`: with a mirror, the
  register row is on screen **while `fetchDb` is still pending**; without one,
  the Loading gate shows until the snapshot lands.
- Observable delta, stated plainly: a mirrored device now paints immediately
  and may show data one revision stale for the duration of the reconcile —
  the same staleness the app already accepts offline and on the 20 s poll.
- On-device verification method (not run here — needs a real device):
  Chrome DevTools performance trace on mid-tier Android, cold then warm,
  comparing first-contentful-paint to the `/api/auth/session` request end.
- Rollback: revert the `boot` ref block and the `&& !boot.current.mirrored`
  gate condition in AppContext — one file.

## Step 3 — context re-render cost: measured, no rewrite (2026-09-25)

Method note: `Profiler.onRender` never fires for context-driven re-renders of
consumers below it (React 19), so the measurement is wall-clock across the
`act()` that flushes a representative save (a vendor edit on the Vendors
register) plus render-count probes in the tree — `AppContext.render.test.tsx`,
kept as a regression tripwire.

Result: **1.42 ms render+commit**, every mounted `useApp` consumer re-renders
**exactly once**, `useSaveStatus` consumers **zero** (a successful save never
flips the dirty state). One page is mounted at a time (routes), so the 48
call sites reduce to the current page plus Layout. There is no measured case
the single-context model cannot meet — a selector library or domain split
would be decoration, so none was added. The assertions pin the counts loosely
(`useApp` renders ≤ 3 per save) so a future regression to per-flip storms
fails the suite, not the operators.

## Step 4 — derivation extraction from the monolithic pages (2026-09-25)

~485 lines of pure computation moved out of three pages into testable
`src/lib` modules (logic byte-for-byte moved; every memo keeps its original
dependency array; 31 characterization tests pin current outputs):

- `src/lib/planningView.ts` (~250 lines from ProductionPlanning): `planDemand`
  — the ~160-line both-ways demand netting (released packs + packing plans
  off the top, extraction/melange supply netted against the rest, Done
  excluded both ways) — plus `horizonWindow`, `orderedPlans`, `filterPlans`,
  `productPicks`, `servesClosed`, `bulkSentence`, `shortUom`.
- `src/lib/ordersView.ts` (~170 lines from Orders): `drinkCatalog`,
  `releasedPacksBySku`, `filterOrders`, `resolveBlocks`, `linesByDrink`,
  `seedAllocations` + draft types.
- `src/lib/procurementView.ts` (~65 lines from Procurement): `filterGrnRows`,
  `drawnLots`, `pmReceiptRows`, `pmReceiptConsumed`,
  `orderSuppliersByLink`, `grnPreview` (landed-cost arithmetic).
- **LiveReports: null result, deliberate.** It already derives through
  `src/lib/reports/*`; its inline helpers are presentation formatters.
  Splitting for length alone was forbidden.

One judgment call documented in code: `productPicksFor(state, stage)` takes
whole `state` while its memo depends on the three collections it reads —
lint is suppressed with a comment there (whole-state deps would recompute on
every unrelated save).

## Step 5 — register windowing: dismissed, with a trigger

The whole live base holds 213 rows (largest table: Items, 31). No register
can render heavy today. Revisit — with measurement, not before — when any
register routinely renders **>200 rows** or a table crosses ~10k rows.

## Step 6 — CSS: dismissed with numbers

9.27 KB gz ships; static audit (class selectors vs every token in `src/`)
finds 18/303 unreferenced ≈ 0.3 KB gz, and most are `kind-${x}` dynamic-name
false positives. A coverage-tooling pass is not worth anyone's afternoon at
this size.

## Step 7 — snapshot growth: measured, design note only

Today: 213 rows ≈ well under 100 KB of snapshot JSON. Projection at a
plausible peak-season sustained rate (20 documents/day × ~300 days, each
document ≈ 1 doc row with Data JSON + ~3 ledger lines + 1 audit row ≈
5–6 KB/day): **~2–2.5 MB at 12 months**; at 40 docs/day it crosses the ~4 MB
danger line within the year, against the ~5 MB localStorage ceiling
(`roligt_foods_ops_v1`).

**Design note (not implemented, per the rules of this pass).** When the
mirror is measured above ~2 MB or the ledger passes ~20k rows:

1. Split hot/cold in the snapshot: masters + open stock + current-period docs
   stay in `/api/snapshot`; audit history and ledger lines older than N days
   move to a paged endpoint the Audit and Traceability pages call directly.
   Fewer rows per table also means fewer paginated reads per sweep — it
   *lowers* Zoho budget pressure (the 26-read/min ceiling stays untouchable).
2. The stock fold must not break: "nothing stores a balance" survives by
   having the BFF ship a synthetic opening-balance prefix per `rowKey` at the
   window start (fold of everything older), so client-side folding from line
   one of the window produces today's numbers exactly.
3. `/reports/live` needs nothing: it already computes from the snapshot via
   `src/lib/reports`, and reads stay whole-plant by policy.
4. Trigger to act: mirror size > 2 MB measured on a real operator device, or
   the first report of iOS Safari evicting the mirror.

## Step 8 — dependencies: dismissed

`@workos-inc/*` is server-side (never in the browser bundle); `d3-force`
lives inside the lazy TraceNetwork chunk; the jspdf family + dompurify load
on first Export PDF. React, react-dom and react-router are load-bearing.

## Verification for the whole pass

`npm run build` clean; `npm test` **235/235** (201 prior + 3 boot/render
characterization + 31 extraction); lint clean except pre-existing categories
(Fast-Refresh warnings, two ancient `scripts/zoho/embed-engine.mjs` regex
escapes, `domains/procurement.ts` exhaustive-deps). Dev-dependencies added:
`happy-dom`, `@testing-library/react` — test-only, no runtime impact.

Edge cases respected, named: offline startup with a stale mirror (paints the
mirror, offline toast — the pre-existing path, now without the gate wait);
dirty local state mid-sync (adopted and pushed up exactly as before; saves
gate on `ready`); iOS Safari (route chunks via dynamic import are supported
and precached; mirror eviction is the step-7 trigger); upstream 503/rate-lock
windows (unchanged — snapshot budget behavior is orthogonal to this pass);
first-run empty state (keeps the Loading gate; seed never flashes over real
masters); two operators saving the same document (unchanged last-write-wins
within the save window).
