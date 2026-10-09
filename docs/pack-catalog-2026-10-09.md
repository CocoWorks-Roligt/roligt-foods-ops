# The pack catalog — packs created once, recipes assigned inside them

**Date:** 2026-10-09
**Status:** Implemented on `d1-migration` (this commit)
**Scope:** How a pack is modelled and edited, and what a packing run asks for. No `api/` changes, no schema changes, no new synced collection.
**Audience:** Anyone changing packs, the Products & Materials page, or the packing run form.

---

## 1. The problem this replaces

Until now a pack product was created **per recipe**: "TCW 5 L pack" and "ABC 5 L pack" were two separate pack definitions, each carrying its own copy of the physical format — type, size, BOM. That is backwards. The plant buys one physical thing — a 5 L BiB, a 4 × 250 ml bottle — and fills several recipes into it. Re-entering the format per recipe meant the same pouch-and-cap BOM typed N times, a size correction made N times, and a new quantity (say a 2.5 L) created as N new products. The client's words: *"currently we are creating packs for individual recipes which is not a good coding work."*

## 2. The model: the pack is a derived view, not a record

There is no `packs` collection and no pack record anywhere in state. **A pack is the group of finished SKUs that share its `packName`, `type`, `size` and `unit** — the pack key, `packKeyOfDef` in `src/lib/packs.ts`:

```
packLabel(p) = p.packName || `${formatSize(p.size, p.unit)} ${p.type}`
packKey(p)  = `${packLabel(p)}|${p.type}|${p.size}|${p.unit}`
```

- `packDefs(products)` (lib/packs.ts) is the catalog view: one `PackDef` per key — name, type, size, unit, BOM, retired flag, and the member SKUs (sorted by name). The Products & Materials page renders one card per def.
- Each **member SKU is one recipe** of the pack: its own name (the finished SKU the plant sells), its own bulk (`bulkItem`), shelf-life clocks and MRP. Everything physical is shared and lives on the pack.
- `savePack(defKey | null, input)` (src/context/domains/catalog.ts) is the only writer. Every save writes the physicals — type, size, unit, `packVolume`, BOM, `packName` — onto **every member SKU** in one `setState`. The catalog can therefore never show a pack whose recipes disagree with it: there is nothing to fall out of step with.
- Two SKUs landing on the same key **merge** — that is the feature, not an accident. Saving a pack whose name/type/size/unit matches an existing one adds its recipes to that pack instead of creating a second; the form says so before the save (`mergesInto` note in `PackDefForm`).
- **Retired** (`Product.retired`) propagates the same way. A def is retired when every member is (`members.every(m => m.retired)`); retiring marks all members, restoring clears the key. Retired packs drop out of new packing-run and planning lists but keep their stock, stickers and dispatch history.

The run form collapsed to match: one **Pack** select per line (the pack label; the recipe's own SKU name only when two recipes would read identically), then Qty — Unit and Total show themselves. The type-then-size two-step is gone, and the "+ Create this pack" quick-create now opens the pack form seeded with the bulk being filled from.

## 3. Why a derived view and not a synced `packs` collection

A `packs` table with `product.packId` pointers is the textbook shape, and it was the first plan. Three things killed it:

1. **The Zoho engine's cold-start budget.** A cold snapshot sweep reads every wire table once — today that is exactly 26 reads (`api/_lib/snapshot.ts:323`, pinned by `snapshot.test.ts` and `zoho.test.ts`). A 27th wire table parks ~60 s on every cold start until the D1 cutover lands.
2. **Deterministic ids.** `migrate.ts` never counter-mints ids on load. Every derived row in a synced collection would need an id derivable from content alone, or the first Zoho round-trip after a client-side pack create would mint a second collection row for the same pack.
3. **Coupling to the cutover.** A pack as a view over `products` needs no engine change, no D1 table, no migration — it works identically on Zoho today and D1 tomorrow.

The accepted trade-off: **a pack with zero recipes cannot exist.** The form requires at least one recipe, and the validation says what to do instead (`"A pack exists to be filled — assign at least one recipe. To drop the pack entirely, delete it from its card."`).

## 4. The guards (`checkPack`, in validation order)

| Refusal | Why it is a refusal |
|---|---|
| Name / type / size empty; BOM line incomplete | The pack key needs all of them. |
| No recipes | §3's trade-off. |
| Recipe's bulk is not Semi-Finished, or its uom ≠ `bulkUomForUnit(unit)` | A pack sized in litres cannot be filled from something counted in kilograms — the run would draw the right number and the wrong quantity. |
| Recipe name matches another product (excluding its own SKU) | SKU names are what runs, stock and dispatch call them; twins are indistinguishable. |
| Two rows in the form share a name | Would mint twin SKUs nothing can tell apart. |
| Same bulk twice in the pack | Each recipe is its own bulk. |
| **Unassigning a member with ledger history** | Unassigning IS deleting — the pack is the group, so a member that leaves it leaves the app entirely, and the ledger is never rewritten. Message names the SKU and points at retire. |
| **Unit change while any member has history** | A new unit re-dimensions every pack line already on the ledger (40 packs at 250 ml would silently read as 40 L). Size may still move — posted runs carry their own `perPack` copy. |

A member's bulk is also structurally frozen in the form (disabled input): its stock history was costed in that bulk, and moving a recipe between bulks is unassign + assign, not an edit. Switching the pack's unit drops uom-mismatched recipe rows from the form — the history case is caught by the guard above, naming the SKU.

## 5. The 4-pack without a schema change

A 4 × 120 ml bottle is one pack: `size` is the total one pack holds (480), `packName` carries "4 × 120 ml", and the BOM's quantities are per pack (4 bottles, 4 caps…). Nothing new to migrate; the form's size hint says exactly this.

## 6. Where things live

| Piece | File |
|---|---|
| Pack key, `packDefs`, label, retired roll-up | `src/lib/packs.ts` (+ `packs.test.ts`) |
| `PackRecipeInput` / `PackDefInput` | `src/lib/posting.ts` |
| `checkPack` / `savePack` / `retirePack` / `deletePack` | `src/context/domains/catalog.ts` (+ `catalog.test.tsx`) |
| `packName?`, `retired?` on Product | `src/types.ts` |
| Pack form, recipes subform, BOM subform | `src/pages/products/PackDefForm.tsx` (hosted by `PackDefDialog.tsx`) |
| Pack card / bulk card "Filled into" chips | `src/pages/products/cards.tsx` |
| Packs section of Products & Materials | `src/pages/PurchaseProducts.tsx` |
| Run form, one-select lines | `src/pages/Packing.tsx` |
| BOM presets (suggestBom) | `src/pages/products/packTemplates.ts` |
| Row grids (`.fill-row` 5-col, `.recipe-row`) | `src/index.css` |

Deleted with the pivot: `src/pages/products/PackProductForm.tsx`, `src/pages/products/PackProductDialog.tsx`, and the `ProductInput` interface they lived on — `savePack`'s `PackDefInput` replaces them.

Downstream readers — `posting.ts` pack costing, trace, orders/planning views, ProductionPlanning, stickers, dispatch — read product fields directly and needed **zero changes**: propagation is the whole trick.
