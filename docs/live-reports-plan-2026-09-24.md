# Live Reports — Engineering Plan

**Date:** 2026-09-24
**Status:** Proposed
**Scope:** Ten live reports (procurement lots, lot yield, fruits, production, batch-wise, dispatch, RM, PM, storage, quality) for ProductionDashboard, on the existing Zoho Tables backend.

---

## 1. The core decision: reports are derived, not stored

**Zoho Tables remains the single source of truth. Nothing new is stored for reporting in v1.**

A report is a *pure function over operational records that already exist*:

```
report(state, params) → rows + summary
```

where `state` is the snapshot the app already syncs (GRNs, Batches, PackingRuns, QcRecords,
Dispatches, LedgerEntries, Orders) and `params` is the date range / compare selection.

### Why not store computed reports back into Zoho Tables

| Problem | Consequence |
|---|---|
| **Staleness on retro-edits** | Someone corrects a GRN's landed cost → a stored monthly report from yesterday now disagrees with the ledger forever. Derived reports recompute on the next revision poll; stored ones silently rot. |
| **Conflict surface** | This app is multi-operator with optimistic commits. Stored reports become another writable surface the diff/commit engine must reconcile — for data that is 100% derivable. |
| **Snapshot bloat** | Every stored month multiplies rows the client must sync and mirror to localStorage (already the tightest resource in the system). |
| **Audit integrity** | The audit trail explains who changed operational records. Stored aggregates would either be unwritable (then why store them) or writable (then they drift from their sources). |

### The line the codebase already draws (and we keep)

The model already distinguishes **facts pinned at posting time** from **aggregations**:

- Stored: `Grn.landed`, `Grn.usableCost`, `Batch.costPerL` — economics frozen when the document was posted. A later rate change must not rewrite March's landed cost.
- Derived: everything spanning records — monthly totals, yields per lot across batches, stock balances (already derived from `LedgerEntry` by the Inventory page, not stored).

Reports are pure aggregation → derived. This is also why the report can never contradict the registers: **both read the same snapshot**.

### The two legitimate exceptions (optional, later)

1. **Saved views** — a user pins "Lot report, Aug vs Sep, farmer X" with one click. That's a 200-byte *config* record, not report data. v1 covers this with URL params; add a `report_views` table only if pinning proves wanted.
2. **Published (issued) reports** — management wants an immutable month-end statement, the reporting equivalent of a closed accounting period. A `published_reports` row (report type, params, rendered JSON or PDF key, revision stamp, published-by) is a *deliberate snapshot*, like `LabReport` is today: an issued document is stored; a live report is not. Optional Phase 1.5.

---

## 2. Architecture

### Data flow (v1 — client-side derivation)

```
Zoho Tables
   │  (existing sweep, rate-limit-aware client — api/_lib/zoho.ts)
   ▼
/api/snapshot  ── per-process cache keyed by revision (api/_lib/snapshot.ts)
   │  (20s revision poll; localStorage mirror + fast-path)
   ▼
AppContext (whole-plant state)
   │
   ▼
src/lib/reports/*.ts        ← pure derivation, memoised by (revision, params)
   │
   ▼
Live Reports page (ReportShell + RangePicker + tables/KPIs)
   │
   ▼
Exports: CSV / PDF (jsPDF + autotable — already dependencies)
```

**"Live" is free**: every snapshot refresh (revision poll) recomputes the visible report. No
staleness, no refresh button, no scheduled jobs. Offline works too — reports run on the
mirrored state, flagged with the existing "last synced" indicator.

### The three layers

**Layer 1 — derivation library (`src/lib/reports/`)**

- One module per report family: `procurementLots.ts`, `lotYield.ts`, `production.ts`,
  `dispatch.ts`, `inventoryReports.ts` (RM/PM/storage share the ledger engine), `quality.ts`.
- Signature: `derive<Report>(state: AppState, params: ReportParams): <Report>Result`.
- **Isomorphic TS**, compiled by both tsconfigs exactly like `src/lib/roles.ts` — the same
  module later runs inside the BFF (Phase 2) without a rewrite.
- Pure and unit-tested: golden tests per report against fixture snapshots (empty month,
  single month, compare-gap, melange double-count case, deprecated-field records).
- Month bucketing by date-string prefix (`date.slice(0, 7)`) — records carry `yyyy-mm-dd`
  strings, so there is no timezone bug to write.

**Layer 2 — report kit (components)**

- `ReportShell` — title, one-line method note, "as of <revision time>" + existing sync
  state, export buttons.
- `RangePicker` — month | custom range | **compare A vs B** (compare is a first-class
  parameter, not a variant page).
- Reuse: `useTableSort`/`SortHeader`, `.metric`/`.kpi-row`, `EmptyState` (distinguishes
  zero-activity vs filter-matched-nothing), `ExportButtons`, `DocLink` for drill-through
  (a lot code in a report row opens the record — the strongest pattern in the app).
- Visuals: CSS bars (Dashboard precedent). No chart library in v1 — PWA bundle budget;
  reconsider only if a report genuinely needs trends-over-12-months.

**Layer 3 — report pages (thin)**

- One route `/reports/live` (existing `/reports` = issued lab documents, untouched) with an
  internal catalog grouped Procurement / Production / Quality / Stock & dispatch.
- All filter state in URL search params → every view is deep-linkable, back-button works,
  a pinned view is a bookmark.

### The ten reports — derivation map

| # | Report | Sources | Notes |
|---|---|---|---|
| 1 | Procurement lot (monthly, custom, **compare two months**) | `Grn[]` | Rows: lot, farmer, qty, a/b/c, reject, rate, landed, ₹/accepted unit. Compare = same derivation run twice + Δ%. |
| 2 | **Lot yield** | `Grn` ⟕ `Batch.sourceLines` ⟕ `Batch.outputLines` | Litres attributed per lot; spoiled = `Grn.reject` + attributed `Batch.spoiled`; ₹/L = `usableCost` ÷ net-new litres. Cross-check vs stored `costPerL`. |
| 3 | Fruits procurement | 1–2 filtered by `itemId`/`purchaseProductId` ≠ tender coconut | Pre-fruit records default to coconut (see types.ts comment) — filter by item, not by date. |
| 4 | Production (monthly/custom) | `Batch[]` + `PackingRun[]` | Extractions & melanges, bulk litres, packs, yield & cost trends. |
| 5 | Batch-wise production | `Batch[]` | Inputs, per-output yields, spoiled, costs, status, linked QC (via `qcIds`). |
| 6 | Dispatch (month-wise / batch-wise) | `Dispatch[]` (+`Order` context) | Group by month or `batchId`; SKU/customer mix, delivered vs pending, POD completeness. |
| 7 | RM report | `LedgerEntry[]` where `itemType = Raw Material` | Opening → receipts (GRN) → issues → closing for the range; lot ageing from receipt/harvest dates. |
| 8 | PM report | `LedgerEntry[]` where `itemType = Packing Material` + `Item.reorder` | Same engine as RM + below-reorder flags. |
| 9 | Storage / FG on hand | `LedgerEntry[]` balances where `itemType = Finished Goods` | By location + item, expiry-ageing buckets, value at `unitCost`. |
| 10 | Quality | `QcRecord[]` + `Batch.status` | Released/hold/reject counts & rates by month and product; partly-released handled by existing rollup semantics. |

### Edge cases each report must implement (the checklist every report is tested against)

- Zero-activity period; compare where one side is empty (show "no data", not 0 vs 0).
- Lot with no production yet → "yield pending" state, excluded from ₹/L denominator.
- In-flight batches (not yet posted outputs).
- Multi-output batches (water + malai): yield names the main output; malai is by-product (costShare already encodes this).
- **Melange double-counting**: a blend consumes bulk an extraction already produced. Method:
  *net-new litres* = extraction outputs + mélange net additions (outputs − drawn inputs).
  One decision, documented in the derivation module, covered by a golden test.
- Deprecated-field fallbacks: read `inputQty` → fall back to `coconuts`; `outputLines` →
  `waterLitres`/`malaiKg`. Old records still carry the old names by design.
- uom mixing in dispatch quantities (packs vs kg for malai) — never sum across uom; group by uom line.
- Large months → virtualised table rows past ~500 (per UI audit recommendation).

---

## 3. Growth path — the same code, moved across the network boundary

**Trigger points** (any one): snapshot payload > ~4 MB, cold load > ~4 s, localStorage mirror
quota errors, or report computation visibly stuttering on old phones.

**Phase 2 — server-side aggregation, zero rewrite:**

```
GET /api/report?type=procurement-lots&from=…&to=…&compareFrom=…&compareTo=…
```

- The endpoint calls the existing `readSnapshotCached(zoho)` — the per-process, revision-keyed
  cache means repeated report calls don't re-sweep Zoho (one revision-row read answers freshness).
- Runs the **same** isomorphic derivation modules; returns aggregated rows only, so the client
  payload collapses from "all history" to "one report".
- Response carries the revision it was computed at → the client can cache keyed by
  `{type, paramsHash, revision}` with automatic invalidation: any commit bumps `app_revision`.
- The client keeps a thin fallback: if the endpoint is cold/unavailable, derive locally from
  whatever the mirror holds (offline story preserved).

**Not chosen for v1:** server-side date-windowed reads via `fetchRecordsWithCriteria`. The
criteria transport is proven only for single-key lookups (see probe notes in `api/_lib/zoho.ts`);
range queries on date fields are unprobed and would fragment the "one snapshot, one truth" model.
If Phase 2's aggregate-on-cached-snapshot ever becomes the bottleneck, probe range criteria first
(following the `scripts/zoho/probe.mjs` precedent) — it is an optimisation of the read, not a
change to the model.

**Phase 3 (optional, separate audience):** Zoho Analytics connected to the same base for
management dashboards and scheduled email PDFs. Zero code, but a separate tool — it complements
the in-app reports; it does not replace them for the plant floor.

---

## 4. What gets added where (the storage answer, in one table)

| Data | Lives in | Why |
|---|---|---|
| All report *inputs* | **Zoho Tables — already there** (GRNs, Batches, PackingRuns, QC, Dispatches, Ledger, Orders) | Single source of truth |
| Computed report values | **Nowhere — derived on demand** | §1 |
| Range/compare selection | URL params | Deep-linkable, zero storage |
| Saved views (optional, on demand) | one small Zoho `report_views` table | User preference, not report data |
| Published month-end statements (optional) | one Zoho `published_reports` table + PDF in the private bucket | Deliberate immutability (period close), like LabReport today |
| Aggregate cache (Phase 2) | process memory keyed by revision | Auto-invalidating; never a source of truth |

---

## 5. Build plan & estimates

| Step | Deliverable | Est. |
|---|---|---|
| 0 | Kit + skeleton: `ReportShell`, `RangePicker` (month/custom/compare), route + catalog, derivation scaffolding, fixtures + test harness, export wiring | 2–3 d |
| 1 | Reports 1 + 3 (procurement lot + fruits; compare mode) | 1–2 d |
| 2 | Report 2 (lot yield — melange method decision + golden tests) | 2 d |
| 3 | Reports 4 + 5 (production, batch-wise) | 1–2 d |
| 4 | Report 10 (quality) | 1 d |
| 5 | Reports 9, 7, 8 (ledger engine once, three reports) | 1–2 d |
| 6 | Report 6 (dispatch) + polish pass (drill-through DocLinks, print sheet via `.report-sheet`, virtualisation if needed) | 1 d |

**Total ≈ 9–13 working days.** Sequencing rule: the ledger engine (step 5) is built once and
shared by RM/PM/storage; the yield method decision (step 2) is made before any UI for report 2.

### Invariants to hold throughout

1. A report and its underlying register never disagree (same snapshot in, same fields read).
2. Every report is deterministic from `(state, params)` — no hidden client state.
3. No report writes anything, ever; exports are renders, not records.
4. Deprecated fields are read with fallbacks, never migrated by the report layer.
5. Empty and error states are implemented per report, not inherited "for free" from nothing.
