# Roligt Foods Ops — review & UX overhaul, session notes

**Dates:** 17–19 September 2026
**Scope:** full code review of `roligt-foods-ops`, then a live UI/UX and functionality pass, then a series of usability fixes verified in the browser as they landed.
**State of the tree:** all changes below are uncommitted on top of `dccb79d` — 21 files changed (+767 / −175) and 5 new components (~500 lines). `npx tsc -b` exits 0; `npx oxlint src` reports 10 warnings / 0 errors (all `react(only-export-components)` fast-refresh advisories, the same class the contexts already carried; 8 existed before this work).

---

## 1. What the app is (orientation for future readers)

React 19 + Vite + TypeScript SPA, Supabase backend (tables + RLS), offline-first: the full app state is mirrored to `localStorage` under `roligt_foods_ops_v1` and synced by diff against a `synced.current` baseline. Stock movement is an append-only ledger; every document (GRN, batch, QC record, lab report, packing run, order, dispatch, stock issue) is numbered from local counters. Extraction presses raw produce into bulk, mélange blends bulk to a recipe, packing fills packs, QC releases stock, dispatch ships it.

## 2. Analysis — what the review found

### Architecture review
- **P0 — offline sync can lose writes.** The pull-then-push diff sync treats the remote baseline as static; if a second device (or the same device after a long offline stretch) has moved the baseline, a naive push can discard or overwrite concurrent records. This is the one finding that should be settled before more than one person uses the app in anger.
- **Doc numbering from local counters** (`GRN-…`, `BAT-…`, `TR-…`) will collide across devices once two clients mint numbers offline. Needs a device suffix, server-side allocation, or a re-sequence on sync.
- **No automated tests.** The posting/costing math (by-product cost shares, yield, wastage, usable cost per GRN) is intricate and entirely hand-verified. A small unit suite over the posting functions would pay for itself quickly.
- **Source hygiene:** a literal NUL byte had crept into `src/pages/Quality.tsx` (made the file unreadable to some tools) — fixed during this session.

### UX / usability pass (live, in the browser)
- Detail views were reachable only through a **View** button; the row itself was dead.
- **No sorting or filtering on any grid** — every list was fixed newest-first with only some pages having a search box; Dispatch history had neither search nor status filter.
- **Quality Control** opened on a card view that did not scale; operators scan, they don't swipe.
- **Record-number links navigated to whole pages**, throwing away the user's place (search, filters, scroll) to answer "what is this batch?".
- **Lab reports were not linked to batches**: the report form stored free text (`batchLotDetails`), so reports never appeared on batch detail, traceability, or QC surfaces.
- The Quality table had **no Reports column** — a released product showed nothing about its lab evidence.
- **Escape closed a whole half-filled form** while the batch-autocomplete dropdown was open.
- A **38-string copy audit** (AI-sounding text) produced the 6-sprint copy/a11y/polish plan kept at `../roligt-copy-ux-deai-plan.md` (outside the repo, in the review workspace).

## 3. Changes made (all verified live in the browser)

### 3.1 Row-click opens details everywhere
`src/components/detailRow.ts` — `detailRowProps(open)` spreads onto a `<tr>`: click anywhere (except buttons/links) or Enter/Space opens the detail view; rows are focusable, with hover/focus styles (`.row-open` in `index.css`). Rolled out to 10 tables: Extraction batches, Mélange runs, Procurement (GRNs + PM receipts), Packing, Orders, Dispatch history, Stock Issues, Control Samples, Quality. View buttons removed where the row now does the job.

### 3.2 Quality Control: table-first
Table view is the default (Product / Batch / QC Record / Tests "x/y Pass" + waiting list / Reports / Status / Action), with a Table–Cards segmented toggle for the old card view.

### 3.3 Lab report ↔ batch linkage
- `LabReport.batchId?: string` (`src/types.ts`), populated by `linkedBatchId()` in `src/context/domains/quality.ts` — an exact trim match of the free-text lot field against real batch ids, applied on generate, on edit, and backfilled by `src/lib/migrate.ts` for existing reports.
- `src/lib/links.ts` knows the `report` DocKind: came-from/went-into edges, the header diagram, and `DocLink` support.
- `src/components/labReportSection.tsx` renders a "Lab reports" section on batch and mélange detail (and in the in-place viewer), and the Reports list, report sheet, and Traceability (timeline "Tested" row + lab-reports card) all linkify the batch.

### 3.4 In-place record dialogs instead of page navigation
`src/components/DocViewer.tsx` + `docViewerContext.ts`: every `DocLink` now opens a dialog **over the page you were on** — search, filters and scroll survive. Dialogs stack with a history (Escape walks back one record at a time; the Modal component only lets the top dialog take the key). Record types supported: grn, batch, melange, qc, packing, dispatch, order, issue, material, report. The old routing behaviour remains only for the traceability graph, which genuinely is a page.

### 3.5 Quality "Reports" column + reports dialog
The Tests column is followed by a Reports column: "N reports" (or —) launches a dialog listing **everything that speaks for that batch** — lab reports raised against it and files attached to its QC record, deduplicated. The dialog renders one card per document: doc number (a `DocLink`), test category, score/customer meta on the left; decision badge and date on the right; attachments show upload date. Sorted newest-first; a human empty state explains where reports come from.

### 3.6 Sorting and filtering for the grids
`src/components/tableSort.tsx`:
- **`SortHeader`** — the column head is the control. Tri-state: first click sorts the way the column is asked about (dates newest, values largest, names A–Z), second click flips, third hands the order back to the page. Active head takes the app's link-green + solid arrow; `aria-sort` tracked; numeric-aware string compare (`RF-9` < `RF-10`); blanks last; stable ties.
- **`useTableSort` / `sortRows`** — per-column accessor map; ties keep page order.
- **`SortSelect`** — under 760px the tables become cards and their heads disappear, so each grid carries a select above the list with both directions in plain words ("Date · newest first", "Value · high → low").

Rolled out to 12 tables: Extraction, Mélange, GRNs, PM receipts, Packing, Orders, Stock Issues, Control Samples, Quality (incl. tests-passed), and both lab-report tables on Reports. **Dispatch history** additionally got a search box (dispatch / customer / challan / batch / vehicle / notes) and a delivery-status filter with a clearable empty state.

### 3.7 Escape vs. the autocomplete (form-loss fix)
`BatchLotField` now owns its Escape key: it closes its own suggestion list and stops propagation, so the dialog behind it stays open for a second Escape. The Modal guard also recognises `.autocomplete-list` as an open dropdown (backstop). A blur-based approach was tried first and discarded — blur events are unreliable when the window lacks OS focus.

### 3.8 Housekeeping
- NUL byte removed from `Quality.tsx`.
- Test harness for offline GUI review: `.env.local` with a dummy Supabase project id + JWT-shaped anon key, and a faked session in `localStorage` (`sb-demo-ref-auth-token`, far-future expiry) — the app then runs fully offline on seed data (`npm run dev -- --port 5199`; first boot takes ~8–12 s while the Supabase client times out).
- Evidence screenshots for every change: `../gui-test-screenshots/` (in the review workspace, outside the repo).

### 3.9 How the changes were verified
Type-check (`tsc -b` = 0) and lint after every step; a full chain was built through the UI in the test data — GRN `RFTC20260001` (₹33,750 landed, math checked) → `BAT-2026-0001` (₹111.32/L, by-product at ₹0) → QC release → lab report `TR-2026-0001` (batch-linked, GUI-generated) — and then sighted on every surface it should appear: Reports list, report sheet, batch detail, traceability (card + timeline), Quality table + reports dialog. Sorting verified by tri-state cycle on Production and visible row swaps on Quality; Escape-vs-autocomplete verified on the report form.

## 4. Recommended next (not yet built)

**Before multi-device use — the data-integrity items:**
1. Fix the P0 sync write-loss path: per-record versioning/`updated_at` with a server-side merge, or at minimum detect baseline drift and refuse-and-rebase instead of pushing over it.
2. Make doc numbering collision-safe (device suffix or server allocation).
3. Add a unit suite over the posting/costing functions and the sync diff — the math is the product.

**Smaller, well-scoped UX items:**
4. Sorting for the remaining registers (Vendors, Customers, Products & Materials, Packing Materials, Inventory, Storage) — the `tableSort.tsx` machinery drops in.
5. Reports page: row-click detail + export buttons on records; a divergence warning when a sensory decision and the QC status disagree; per-category search.
6. Execute the copy/a11y/polish plan (see `../roligt-copy-ux-deai-plan.md`, 6 sprints / 38 strings) — the "sounds AI-built" pass.
7. Attachment experience: the QC upload flow still uses the legacy public-URL path for old files; keep nudging everything through signed URLs.

**Parked, design agreed in principle:**
8. D3 analytics: a new Analytics page, split by audience (plant operations vs. management), stock-value-over-time renamed to "Stock value over time" and demoted; deprioritised in favour of the usability fixes above.

---

*Everything in §3 is in the working tree, uncommitted. Suggested cut: one commit per numbered subsection (3.1–3.7) — they were each verified independently and would review cleanly in isolation.*
