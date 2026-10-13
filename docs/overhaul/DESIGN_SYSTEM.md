# DESIGN_SYSTEM.md — tokens, palettes, components (SHELL, Phase 2)
Source of truth: `src/index.css` (`:root` + `[data-theme='dark']`), `src/lib/statusPalette.ts`,
`src/lib/chartTheme.ts`. The /styleguide route renders this file's content live.

## 1. Themes
Two token sets, one stylesheet: `[data-theme='dark']` on `<html>` re-points every token; rules never
change. Choice is per-device (`localStorage: roligt_theme`), cycles System → Light → Dark
(`src/lib/theme.ts`, ThemeToggle in both bars). Print artefacts (report sheets) stay paper-white in
both themes by design. `color-scheme` follows the tokens so native controls match.

## 2. Core tokens (light → dark)
| role | light | dark |
|---|---|---|
| field --bg | #f2f5f4 | #0d1514 |
| panel --panel | #ffffff | #182523 |
| chrome / well | #e7f0ee / #ecf2f0 | #14201e / #172422 |
| hairlines --hair/-soft/-strong | #dee5e2/#e8eeec/#d2dcd8 | #243130/#1f2c2a/#314441 |
| ink --ink/-soft/-mute/-faint | #15181b…#8a918f | #e8eeec…#6f7c79 |
| action --leaf / wash | #0f766e / #d7f0ec | #2dd4bf / #103a36 |
| nav chrome --grove | #0c5f5a | #0b2725 |
| status (tender/amber/clay/slate) | 700-ink on 100-wash | 200-ink on 900-wash |
| zebra / neutral-wash | #f0f5f3 / #e6eae8 | #14201e / #22302e |

Filled buttons keep WHITE text in both themes; dark gradient stops stay deep enough for AA
(--leaf-fill dark: #108a7c→#0a5f57).

## 3. Status palette (GLOSSARY — colour + glyph + word, never colour-only)
Eleven states + Cancelled, tones: success/danger/warning/info/brand/neutral; glyphs in
`src/components/StatusIcons.tsx`; mapping in `src/lib/statusPalette.ts` (exact-key table first —
QC's Pending reads On Hold (awaiting QC), an order's Open reads Pending — then family fallback).
Movement family (Dispatched, Out for Delivery) rides brand teal; verdicts stay green/red.
Outside the palette by intent: Available (stock quantity, not a workflow), Active/Inactive/Retired/
Suspended (master data) — legacy plain rendering, no glyph.

## 4. Chart colours (validated 2026-10-13, dataviz six-checks, both surfaces)
`src/lib/chartTheme.ts` reads CSS vars so ECharts follows the theme automatically.
- Categorical 8-slot, FIXED order, never cycled; 9th series folds to "Other":
  light `#0d9488 #eb6834 #6250d6 #eda100 #e87ba4 #008300 #2a78d6 #e34948`
  dark  `#0d9488 #d95926 #9085e9 #c98500 #d55181 #008300 #3987e5 #e66767`
  (light: all pass; yellow/magenta <3:1 → relief rule: every chart ships a table view + labels.
  worst adjacent CVD ΔE 10.7 light / 13.0 dark; normal ΔE 19.6 / 19.3.)
- Sequential (magnitude, heatmaps/treemaps): teal ramp light `#64c3a7 #45a68b #238a71 #006f57`,
  dark `#006952 #138168 #379a7f #53b397` (ordinal-validated, ΔL ≥ 0.06, hue spread 1°).
- Diverging (variance): blue #2a78d6 ↔ red #e34948, neutral gray midpoint #8a918f (light) /
  #9daaa6 (dark). Never a hue at the midpoint.
- Status colours are RESERVED for status (never "series 4"); text wears ink tokens, never series
  colour. One axis, always; two scales → two charts.

## 5. Marks & layout (charts)
2px lines, ≥8px point markers, thin bars with 4px rounded data-ends, 2px surface gap between
stacked segments and adjacent bars, 2px surface ring on overlapping marks. Grid/axes recessive
(hair-soft). Legend for ≥2 series; single series needs none (title names it); ≤4 series also
direct-labeled. Selective direct labels only — never a number on every point. Tooltip (crosshair
on lines, per-mark on bars/cells) always; stat tiles are the one form without.

## 6. Freshness & truth
Every dashboard/report surface shows last_updated ("as of HH:MM") + a visible STALE chip past
`stale_after` (contracts Freshness — server's own verdict, so badge and data cannot disagree).
Live updates: SSE /api/events (revision token) refetch; poll fallback /api/revision.

## 7. Components (src/components/shell/)
Skeleton (shimmer rows), ConfirmDialog (Modal-based, destructive intent variant), KpiCard (value,
unit, Δ% chip w/ direction glyph — never colour-only; click-through href), FilterBar (date presets
+ field slots, one row above charts), DataTable (sticky header, sort, density cosy/compact, column
toggle, empty/loading/error states; bulk actions + server pagination arrive with their consumers in
P3/P5), ChartCard (title, Freshness chip, chart ↔ table toggle, CSV export; kinds line/bar/stacked/
treemap/heatmap/control via one lazy-loaded ECharts chunk), TransformationForm (input/output/
spoilage grid + live mass-balance bar), SectionedForm (stepper, localStorage draft autosave),
SignaturePad (pointer events + canvas, dependency-free), ScanInput (QR/barcode field: scanner-guns
type; camera scan deferred to SHIPMENT PWA). ThemeToggle, status glyphs, EmptyState/ErrorBoundary
pre-existing.

## 8. Accessibility bar
WCAG AA both themes; touch targets ≥44px; status never colour-only; charts have table fallback +
legend; keyboard reachable (focus ring --leaf-ring); i18n strings from GLOSSARY.md canonical column.
