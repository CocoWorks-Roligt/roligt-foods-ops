# The pack catalog — packs created once, recipes assigned inside them

**Date:** 2026-10-09
**Status:** D1-first model implemented on `d1-migration`
**Scope:** How a pack is modelled and edited, and what a packing run asks for. D1 stores packs as first-class documents; Zoho retains a compatibility projection until cutover.
**Audience:** Anyone changing packs, the Products & Materials page, or the packing run form.

---

## 1. The problem this replaces

Until now a pack product was created **per recipe**: "TCW 5 L pack" and "ABC 5 L pack" were two separate pack definitions, each carrying its own copy of the physical format — type, size, BOM. That is backwards. The plant buys one physical thing — a 5 L BiB, a 4 × 250 ml bottle — and fills several recipes into it. Re-entering the format per recipe meant the same pouch-and-cap BOM typed N times, a size correction made N times, and a new quantity (say a 2.5 L) created as N new products. The client's words: *"currently we are creating packs for individual recipes which is not a good coding work."*

## 2. The model: a pack is a first-class D1 record

On D1, `packs` is a normal documents collection. A finished SKU points to its physical format with `product.packId`; the pack owns its name, type, size, unit, volume, BOM and retirement state. SKU rows own only their recipe/commercial facts: name, bulk, shelf-life clocks and MRP.

The old physical fields remain projected on products while Zoho is the fallback engine, so downstream stock/trace/dispatch readers remain compatible. `savePack` updates the D1 master and that projection together; D1's pack document is the source of truth.

- `packDefs(products, packs)` is the catalog view: one `PackDef` per stored pack, with its member SKUs sorted by name.
- Existing Zoho/import rows are backfilled deterministically: `PACK:<name>|<type>|<size>|<unit>`. The D1 dump generates the masters and writes those pointers into products in the same import.
- `savePack(defKey | null, input)` is the only writer. A new pack's id is `PACK:<name>|<type>|<size>|<unit>`, so two offline creates of the same format converge on one document. Renames keep the id, so if a renamed pack already holds that id, the new pack takes the next free `~2`, `~3` suffix and never overwrites it.
- **Creating** a pack whose name/type/size/unit matches an existing one **merges**: its recipes join that pack and the pack keeps its own packing materials. The form says so before the save (the `mergesInto` note in `PackDefForm`). **Editing** a pack onto another pack's name/type/size is refused, because it would leave two identical cards; the form warns about this first.
- **Retired** lives on the master (`Pack.retired`) and is also written onto every member (`Product.retired`) for the projection's readers. Retired packs drop out of new packing-run and planning lists but keep their stock, stickers and dispatch history.

The run form collapsed to match: one **Pack** select per line (the pack label; the recipe's own SKU name only when two recipes would read identically), then Qty — Unit and Total show themselves. The type-then-size two-step is gone, and the "+ Create this pack" quick-create now opens the pack form seeded with the bulk being filled from.

## 3. Why this is D1-only until cutover

Zoho keeps its exact 26-read sweep. It has no `packs` table and ignores D1-only pack-document diffs; its client view deterministically derives masters from product projections. D1 reads/writes `packs` beside the other document collections in its single batch, so the proper normalized model adds no request or latency penalty there.

The accepted invariant remains: **a pack with zero recipes cannot exist.** On Zoho, the live engine until cutover and the rollback engine after it, an empty pack has no product row to derive its master from, so it would disappear on the next reload. The form requires at least one recipe, and deletion remains the way to drop an unused format. Once Zoho is retired this guard can be lifted: D1 already stores the master on its own.

## 4. The guards (`checkPack`, in validation order)

| Refusal | Why it is a refusal |
|---|---|
| Name / type / size empty; BOM line incomplete | The pack key needs all of them. |
| No recipes | §3's trade-off. |
| Editing onto another pack's name / type / size / unit | It would leave two identical cards with different ids; a create merges instead. |
| Recipe's bulk is not Semi-Finished, or its uom ≠ `bulkUomForUnit(unit)` | A pack sized in litres cannot be filled from something counted in kilograms — the run would draw the right number and the wrong quantity. |
| Recipe name matches another product (excluding its own SKU) | SKU names are what runs, stock and dispatch call them; twins are indistinguishable. |
| Two rows in the form share a name | Would mint twin SKUs nothing can tell apart. |
| Same bulk twice in the pack (including a create that merges into a pack already filling it) | Each recipe is its own bulk. |
| **Unassigning a member with ledger history** | Unassigning IS deleting — the pack is the group, so a member that leaves it leaves the app entirely, and the ledger is never rewritten. Message names the SKU and points at retire. |
| **Unit change while any member has history** | A new unit re-dimensions every pack line already on the ledger (40 packs at 250 ml would silently read as 40 L). Size may still move — posted runs carry their own `perPack` copy. |

A member's bulk is also structurally frozen in the form (disabled input): its stock history was costed in that bulk, and moving a recipe between bulks is unassign + assign, not an edit. Switching the pack's unit drops uom-mismatched recipe rows from the form — the history case is caught by the guard above, naming the SKU.

## 5. The 4-pack

A 4 × 120 ml bottle is one pack: `size` is the total one pack holds (480), `name` carries "4 × 120 ml", and the BOM's quantities are per pack (4 bottles, 4 caps…).

## 6. Where things live

| Piece | File |
|---|---|
| D1 master, legacy backfill, `packDefs` | `src/lib/packs.ts` (+ `packs.test.ts`) |
| `PackRecipeInput` / `PackDefInput` | `src/lib/posting.ts` |
| `checkPack` / `savePack` / `retirePack` / `deletePack` | `src/context/domains/catalog.ts` (+ `catalog.test.tsx`) |
| `Pack`, `Product.packId?`, compatibility projection | `src/types.ts` |
| Pack form, recipes subform, BOM subform | `src/pages/products/PackDefForm.tsx` (hosted by `PackDefDialog.tsx`) |
| Pack card / bulk card "Filled into" chips | `src/pages/products/cards.tsx` |
| Packs section of Products & Materials | `src/pages/PurchaseProducts.tsx` |
| Run form, one-select lines | `src/pages/Packing.tsx` |
| BOM presets (suggestBom) | `src/pages/products/packTemplates.ts` |
| Row grids (`.fill-row` 5-col, `.recipe-row`) | `src/index.css` |

Deleted with the pivot: `src/pages/products/PackProductForm.tsx`, `src/pages/products/PackProductDialog.tsx`, and the `ProductInput` interface they lived on — `savePack`'s `PackDefInput` replaces them.

Downstream readers still receive compatible product projections during the transition. After cutover, physical changes are persisted as pack-master documents instead of being represented only by duplicated product fields.
