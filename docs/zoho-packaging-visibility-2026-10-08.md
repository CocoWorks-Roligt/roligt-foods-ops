# Packaging procurement visibility in the Zoho base

**Date:** 2026-10-08
**Status (2026-10-12):** Superseded by the D1 cutover. Only the D1-relevant code came over to `dev` — `createGrn`/`updateGrn` stamping the vendor on produce Receipt lines, with its tests, and the `authMode` localStorage guard. The Zoho column script, the `baseSchema`/topup changes and the runbook in §4 were never run against production and are moot once D1 serves; the branch was retired. Kept for §5: Plan B — packing receipts as real GRNs, which the Zoho Books purchase bills will need — is a plan, not implemented.

---

## 1. The reported behavior, and why it is not a bug

"When packaging materials procurement happens, why aren't the GRNs in the Zoho tables updated?"

Because packaging receipts have **never been GRN documents**. They are one ledger line each, by design, stated in three places in the code:

- `src/context/domains/packing.ts` — `addPackingStock` pushes a single `type: 'PM Receipt'` ledger line (`doc` = the `PMR-…` number, `vendorId` stamped);
- `src/context/domains/procurement.ts` — only `createGrn` (produce) writes a `grns` row;
- `src/lib/numbering.ts` — the `pmReceipt` series exists precisely because these receipts are numbered documents without a document table.

So during packaging procurement the Zoho **GRNs** table correctly sees nothing: the receipt's stock and cost land in the **Ledger** table (`PM Receipt` row), the supplier sits in that row's Data JSON, and the audit trail gets its entry. This is true since the first commit, not a regression. The commit path for PM receipts is pinned by `commit.test.ts:1210` (the backdated-PM-receipt hint test).

What *was* wrong — the real gaps this ships fixes for — is that the Zoho base made this by-design shape invisible outside the Data JSON:

| Gap | Before |
|---|---|
| Ledger has no **Vendor** column | The supplier behind a PM receipt (or any ledger line) was readable only by opening the row's Data JSON. |
| Produce Receipt lines carry no `vendorId` | `createGrn` stamped vendorId on the GRN row (`farmerId`) but not on the ledger line — so even a future Vendor column would read empty for every produce receipt. |
| Purchase Products has no **Category** column | 'Farm Produce' vs 'Packing Material' vs 'Other' is a field of the master the Zoho mirror never carried — produce and packing products are indistinguishable outside the Data JSON. |

## 2. What shipped (all additive)

**Client** (`src/context/domains/procurement.ts`):
- `createGrn` stamps `vendorId: g.farmerId` on the Receipt ledger line — the same discipline PM receipts always had. A direct farmer (no vendor master) stamps `''`, which round-trips to an empty column, exactly like PM receipts.
- `updateGrn`'s keep-in-step block (the one that keeps the line's qty/cost/item/uom/location aligned with the edited GRN) now also carries `receipt.vendorId = g.farmerId`.

**Mapper** (`api/_lib/mappers.ts`):
- `ledgerColumns` emits `Vendor: link(links.vendors, l.vendorId)` — resolves by vendor id, drops silently when absent (old rows, direct farmers).
- `purchaseProducts` case emits `Category: s(p.category)`.

Zoho drops unknown column names silently in keyed upserts (`columnsByFieldId`), so the app deploys ahead of the base change with no window of breakage — the columns simply fill when they exist.

**Tests:** `mappers.test.ts` updated (Category on both purchase-product pins; Vendor present-and-resolved plus absent-→-undefined on the ledger pin); new `procurement.test.tsx` (create stamps vendorId; direct farmer stamps `''`; updateGrn re-points the line's vendor when the receipt moves to another vendor).

**Base script:** `scripts/zoho/add-ledger-vendor.mjs` — adds `Ledger.Vendor` (single link to the Vendors primary, the build-tables recipe incl. orphan-field reclaim) and `Purchase Products.Category` (type 23 text). Additive, idempotent, paced at 3600 ms per mutation, scratch-first with typed `--production`.

## 3. Lazy adoption — no backfill

Existing rows are **not** rewritten:

- existing produce Receipt ledger lines gain `vendorId` only when their GRN is next edited (and `updateGrn` writes the line only when the GRN itself is edited — a no-op edit commits nothing);
- existing Purchase Products rows fill Category on their next save.

This is deliberate: the offline/quiet-burst write-admission math depends on the write pattern staying as it is, and a one-time sweep of every row is exactly the burst the engine paces around. The columns are empty on old rows, not wrong.

## 4. Runbook

1. `node scripts/zoho/add-ledger-vendor.mjs` (scratch; creds from `.zoho.env`) — verify both columns in the scratch base UI.
2. `node scripts/zoho/topup.mjs dhorj90a2ded0152a4f1d94ae8ce4ece09a5c` — regenerates `api/_lib/baseSchema.ts` so the server knows the new field ids.
3. Post a produce GRN and a PM receipt on scratch; confirm the Ledger rows show Vendor.
4. Only then: `node scripts/zoho/add-ledger-vendor.mjs --production`, then `node scripts/zoho/topup.mjs gerc53fe9f1e44e5f4a13809d9bd47367ba9d`, then deploy.

## 5. Plan B — packing receipts as real GRNs (planned, not built)

The mirror fix makes packaging procurement *visible*; it does not make it a *document*. Plan B promotes packing receipts to real GRN documents, and is the shape the Zoho Books integration actually wants (bills are keyed off GRNs — `docs/zoho-books-integration-2026-09-28.md` §5 maps one GRN → one bill; packing purchases cannot be billed through Books until they exist as GRNs or an equivalent document shape is defined for them).

**Why not a Zoho-side projection** (a trigger/script in Tables copying PM receipts into the GRNs table): the snapshot sweep reads the GRNs table into `state.grns` on every device, so foreign rows would arrive as produce GRNs in the client. The projection would have to be filtered out in the snapshot path, which means the client changes anyway — at which point the honest change is the model, not a mirror trick.

**Scope when it happens:**
- model: packing receipts become `Grn` rows (category-driven) with their ledger line typed accordingly, or a parallel document type sharing the GRN table;
- client migration: existing `PM Receipt` ledger rows and their `PMR-…` docs migrate on `migrateState`;
- produce list filtering by purchase-product category where the page assumes Farm Produce;
- reports and stock views that special-case `type: 'PM Receipt'`;
- numbering continuity for the `pmReceipt` series;
- Books Phase 4 then bills packing GRNs the same way it bills produce ones.
