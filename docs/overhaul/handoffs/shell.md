# SHELL handoff — design system + live shell (Phase 2, complete)

Commits: 5a73273 (tokens/palette/primitives/charts), 7b4e3bb (flags→client, badges, process
nav, command palette), a331a32 (workflow forms), + styleguide/QA slice. Gates at each: tsc -b,
981 tests (baseline 955 +26), lint 10 (baseline), build pass.

## Module map
- `src/index.css` — light tokens + FULL `[data-theme='dark']` block (value-only overrides,
  color-scheme, print/report sheets stay paper-white by design); `.status` glyph layout; shell
  component styles (skeleton, kpi-card, freshness, filter-bar, dt*, chart-card, palette*,
  nav-badge, sectioned-form/stepper, transform-*, mass-balance, signature-pad, scan-input,
  styleguide swatches).
- `src/lib/theme.ts` + `components/ThemeToggle.tsx` — light/dark/system, storage-refusal safe,
  applied pre-render in main.tsx (no FOUC).
- `src/lib/statusPalette.ts` + `components/StatusIcons.tsx` + rewritten `StatusBadge.tsx` —
  exact-key table over substring families; colour+glyph+word; unknown keys keep the legacy
  reading. Available/Active/Inactive/Retired/Suspended deliberately un-toned.
- `src/lib/chartTheme.ts` — dataviz-validated categorical (brand teal #0d9488 slot 1) /
  sequential one-hue teal ramps / diverging pair per mode; reads live CSS tokens.
- `src/components/shell/` — Skeleton(+KpiSkeleton), ConfirmDialog (Modal adapter, verb label,
  danger/busy), FreshnessChip (as-of + Stale), KpiCard (delta glyph+sign, invertDelta, href),
  FilterBar (+`src/lib/dateRanges.ts` presets), DataTable (sticky header, sort, density, column
  chooser, per-device prefs `roligt_table_<id>`), ChartCard (six kinds incl. control/heatmap/
  treemap; chart↔table relief; CSV via exportCsv; freshness; onRefresh) + `echartsChunk.ts`
  (tree-shaken echarts 6, lazy), CommandPalette (Ctrl/Cmd+K, debounced /api/search, grouped,
  keyboard-driven), SectionedForm/Stepper, TransformationForm+MassBalanceBar (folds the SAME
  isomorphic computeMassBalance the close gate enforces from; zero-qty rows not judged; unknown
  units answered neutrally), SignaturePad (pointer+canvas, DPR-crisp, PNG or null), ScanInput
  (select-on-focus, Enter submits — the keyboard-wedge half; camera is P4 PWA).
- `src/lib/useDraft.ts` — localStorage draft autosave (debounced write + unmount flush,
  restored flag, clear on submit/discard, storage-refusal safe).
- `src/lib/navBadges.ts` — AppState → Partial<Record<ViewId, number>> on EXISTING page
  vocabularies only: QC Pending; orders Open; batch roll-ups (extraction non-Released/Rejected,
  blends 'Awaiting QC'); PM reorder (lowStockItems) on procurement AND packing-materials;
  control samples kept with expiry ≤ +7d (past expiry included, destroyed never). Packing /
  Dispatch / Inventory / Home badges deferred to their phases (no honest vocabulary yet).
- `src/lib/useRevisionFeed.ts` — ONE EventSource per tab: module singleton + subscriber set,
  hello seeds / revision fires / bye ignored; onerror arms the 20 s /api/revision poll fallback,
  onopen disarms. Subscribe via the hook only.
- `src/lib/useKpis.ts` — fetch /api/kpis/:module?from&to, seq-guarded, Freshness rides the
  payload, revision feed refetches, refresh() exposed.
- Flags end-to-end: `api/_lib/rulesGate.ts readFlagRecords` → `api/snapshot.ts` (D1 engine
  only; Zoho answers none = all-OFF = Classic) → `DbSnapshot.flags` → AppContext folds through
  isomorphic `readFlags` → `flags: FlagMap` on the context value.
- `src/components/Layout.tsx` — when `flags.shell_nav`: process-order sidebar (PROCESS_SECTIONS,
  ARCHITECTURE §1 order; Stock/Planning/Records headings; "Dashboards" label for Live Reports
  per GLOSSARY; Grading/Shipment Tracking absent until their phases), live badges, Ctrl/Cmd+K +
  search icon-buttons in both bars, CommandPalette mounted. Flag off = Classic markup untouched.
- `src/pages/Styleguide.tsx` + `/styleguide` route — tokens/statuses/chart colours/components
  live; NOT a PAGE_CATALOG entry (no slug/nav; scoped callers bounce via Layout redirect).

## Gaps / next (Phase 3 WORKFLOW)
1. Forms are primitives — no page uses them yet. WORKFLOW adopts SectionedForm/useDraft for the
   new close-run and GRN flows; TransformationForm + MassBalanceBar is the close-run core
   (feed it the items master; tolerance from config massBalanceConfigOf).
2. Stepper awaits the run state machine's stages (extraction/blend/fill stageTimes).
3. navBadges: add packing/dispatch/inventory/home counts when those vocabularies exist
   (batch_v2 run statuses; dispatch staging; FG reorder; holds+aging).
4. CommandPalette is desktop+mobile-topbar only on shell_nav; SHIPMENT P4 adds scan-to-search.
5. DataTable/ChartCard are ready but unused by pages — WORKFLOW/P5 adopt per page (one table
   id per page, stable).
6. Stage shell_nav on D1 flags collection to see the new nav (LEAD-only, hand-staged; note:
   does NOT bump app_revision — lands on the next ≤20 s poll).

## Conventions set (keep)
- Status reading goes through readStatus/StatusBadge — never hand-roll a status chip.
- Charts go through ChartCard/chartColors — categorical slots in fixed order, never cycled.
- Anything freshness-stamped uses FreshnessChip with the payload's own verdict.
- One EventSource per tab via useRevisionFeed; KPI data via useKpis only (the one data door).
