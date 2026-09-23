# Rebuilding Roligt Foods Ops on Zoho — blueprint

**Stack decided:** Zoho Tables as the database, Zoho Creator as the app and logic layer.
**Source of truth for this blueprint:** the working app in this repo — 22 sync collections, an append-only ledger, ~40 screens' worth of forms and registers.
**Status:** planning. Nothing built. The two spikes in §5 decide go/no-go on the hard parts.

---

## 1. The integration reality (design around this first)

Creator forms bind natively to Creator's **own** datastore. Zoho Tables is reached from Creator through its REST API (Deluge `invokeurl` over an OAuth connection). "Tables as DB, Creator as app" therefore means one of two shapes:

| | A — Pure | B — Hybrid (recommended) |
|---|---|---|
| Where data lives | Everything in Tables | Transactional docs in Creator's native store; masters + reference data in Tables |
| Creator's role | Stateless UI + logic over REST | Forms, views and reports native; Deluge syncs masters on demand |
| What you keep | One DB, other tools can read it | Creator's built-in lists, pagination, validation, field history |
| What it costs | Every screen is hand-fetched via API; no native views; slower lists; most Deluge | Two stores with a rule: *Tables = what things are, Creator = what happened* |

**Recommendation: B.** The plant-floor screens (registers with search/sort, pickers fed by lot lists, the demand table) are exactly what Creator does natively — rebuilding them as API-fed shells throws away the platform's strengths. Masters change rarely and are read constantly, which suits Tables + cached lookups. If "everything in Tables" is an organizational requirement (other teams querying the DB directly), take A knowingly.

## 2. Tables schema (from the app's collections)

**Flat tables, direct port:** vendors, customers, purchase_products, storage_locations, items, products, melanges, test_parameters, staff, shifts, attendance, production_plans, stock_issues, dispatches, grns, lab_reports, sticker_prints.

**Nested documents — pick per structure:**
- `batches` (sourceLines, blendLines, outputs arrays), `packing_runs` (lines, controlSamples), `orders` (lines), `qcs` (per-test map + attachments): store the queryable columns as real fields and the nested arrays as a JSON text column — the same shape Supabase uses (`data jsonb`), for the same reason: the app's in-memory model survives untouched.
- **Exception — `order_lines` becomes a child table**, because the demand-driven planning feature sums open-order lines by SKU; that must be queryable, not JSON-spelunking.
- **`ledger` is already flat** — port as-is, real columns. It is the one table anything queries; give it indexes on lot, item, doc.

**Singletons:** `counters`, `config`, `sticker_templates` — small tables, one row per series/stage.

**Field types worth using:** link-to-record for FKs (staff→shifts, product→order lines), attachment fields for QC/lab files, formula fields for derived labels. Do **not** use Tables automation for posting logic — that lives in Creator Deluge, one place.

## 3. The posting engine (the part that must not be wrong)

Every write in this app is a *posting*: one event atomically writes the document, appends 1–6 ledger lines, advances a numbering counter, and logs an audit line. Neither Tables nor Creator gives you a multi-row transaction, so the Deluge pattern is:

1. **Idempotency key** — the document id (minted first). Every ledger row and the doc row carry it; a retry after partial failure re-writes by key, never duplicates.
2. **One Deluge function per event** (`postGrn`, `postBatch`, `postPacking`, `postDispatch`, `postIssue`, `releaseQc`…), no logic in form handlers — forms collect, functions decide. This mirrors the domain split in `src/context/domains/` and keeps the port reviewable.
3. **Numbering** — counter row read → increment → write, inside a retry-on-conflict loop; or per-day prefixes so collisions are structurally impossible (the plant already runs dated series like `LOT-20260909-004`).
4. **Never update or delete ledger rows.** Reversals are new lines with negative quantities — port this rule verbatim; it is why balances, valuation and traceability agree everywhere.

## 4. Screen-by-screen port order

1. **Masters** (vendors, customers, products & materials, storage areas, test categories) — Creator forms over Tables; admin profile only.
2. **Procurement** — GRN with grading + landed-cost math, PM receipts. First full posting vertical slice.
3. **Production** — extraction (multi-lot issue, outputs with cost share to main product, spoilage), mélange (blend draws with cost carry). The hardest math in the app; port the Deluge straight from `src/lib/batches.ts` and `src/context/domains/production.ts`, which are already pure functions.
4. **Quality Control** — per-product records, configurable test categories, release/reject gates flipping stock status, lab reports (sensory scoring + COA), attachments.
5. **Packing, Orders, Dispatch** — BOM-driven draws, complete-order dispatch with stock-row-level picking (item + lot + location + expiry).
6. **Planning + Roster** — the newest features; demand table (open orders − released stock), plans, staff shifts and attendance. Straight ports.
7. **Reporting layer** — Zoho Analytics over Tables for inventory, valuation, traceability exploration. Do not hand-build graphs in Creator.
8. **Stickers** — Creator PDF/print templates per stage; thermal-print fidelity is a per-printer check.

## 5. Run these two spikes before committing (days, not weeks)

1. **Concurrent posting integrity:** two Creator clients submitting `postGrn` simultaneously against the same counter — confirm the retry/idempotency pattern mints two numbers and zero duplicate ledger rows.
2. **Connectivity on the floor:** a Creator mobile form in the cold room with a weak signal. The current app is offline-first by design; Creator is not. Decide what degradation is acceptable (queue-on-device is not available; the realistic answers are Wi-Fi coverage or a kiosk at the door).

## 6. What does not transfer, by design

- **Offline-first PWA.** The single biggest regression. Mitigate, don't pretend.
- **Row-level security** → Creator profiles (coarser: admin/operator, not per-record).
- **Bespoke plant-floor UX** (sortable registers, card layouts, in-place record dialogs) → Creator's native list/detail patterns; good, but generic.
- **Traceability graph UI** → Analytics exploration or a Deluge-assembled view.

## 7. Effort and sequencing

Near-parity in **3–6 months** of focused build, in the §4 order, with §5 spikes in week 1. Budget ~60% of the time for phases 2–5 (the posting engine and its math), ~20% for masters and reporting, ~20% for planning/roster/stickers/polish. The existing app remains the reference implementation and the source of the Deluge logic — it is already written as pure, testable functions for exactly this kind of port.

## 8. Migration

Zoho **DataPrep** for the one-time move: Supabase tables → CSV → clean → Tables. The ledger first (it reconstructs every balance), then documents, then masters. Keep the original database read-only for a reconciliation period; spot-check: ledger-derived stock vs. the old app's inventory screen for 10 random item+lot pairs.
