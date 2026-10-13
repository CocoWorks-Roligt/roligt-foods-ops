# GLOSSARY.md — canonical vocabulary (i18n-ready source for UI strings)
Rule: user-facing words use "blend(s)" everywhere (smoothies/shakes too); "melange" survives only as code/data names (MLG counters, melanges table, melangeBatch). All new UI strings come from this file's canonical column.

## Canonical terms
| canonical (UI) | code/data name(s) today | notes |
|---|---|---|
| Blend | melange, MelangeRuns, blend recipe | one name in UI from now on |
| Bulk | Semi Finished (itemType) | label "Bulk (semi-finished)" first mention |
| Intake / Receipt | GRN, RFTC series | say "Receipt (GRN)" until series renamed |
| Lot | LOT-…, stockId BAT-…/n, PKG-…/n | one word: lot |
| Blend run / Extraction run | batch kind Melange/Extraction | "run" for both |
| Ready extract | non-graded Kg/Litre produce | new procurement_form term |
| Direct-use item | Item.directUse | new procurement_form term |
| BIB pouch (1L / 2.5L / 5L) | 'BiB' SKU | casing: BIB; sizes explicit |
| Carton | cardboard PM item | new: carton config engine |
| Cold room / Ambient / Quarantine / Dispatch staging | Cold Room / Dry Store / Hold Area / — | zone names per §3.3-8 |
| Delivery challan | challan (DC series) | becomes a PDF document |
| Proof of delivery (PoD) | pod (typed name + photos) | extends to signature |
| Shipment | — (dispatch row doubles as trip) | new entity |
| Control sample | controlSamples[] in packing run | keep |
| Blend components | melange components (shares) | "components" |

## Status palette (single source; color + icon + text, never color-only)
Pending · In Progress · On Hold · Passed · Failed · Rework · Released · Dispatched · Out for Delivery · Delivered · Returned.
Mapping from stored keys (labels only, no data renames):
- Available→Pending/In Progress (context), Quarantine & Pending→"On Hold (awaiting QC)" (today one label "Awaiting QC" covers three keys — split labels by context), Rejected→Failed, Released→Released, Retest→Rework (new), In Transit→Out for Delivery, Dispatched→Dispatched, Delivered→Delivered, Returned→Returned, Open→Pending. Cancelled stays Cancelled — its own neutral status, not forced into the palette.

## Confusing labels flagged (fix in SHELL/WORKFLOW)
- Nav "Production" hosts both Extraction and Blend stages; bottom-nav says "Produce" — unify wording.
- "Reports" = Lab Reports; "Live Reports" is metrics — rename Live Reports → "Dashboards" per overhaul IA (decision for ARCHITECT).
- "Spoiled / lost" (extraction) vs "wastage" (dashboard) — one term: "Spoilage".
- "Hold Area" vs QC "Retest"/"On Hold" — zone = Quarantine; QC verdict = On Hold/Rework.
- Stock-issue reason "Lab / testing" vs Control Samples — clarify scope note.
- "GRN" unexplained on screen — subtitle "Goods receipt note".
- "BiB" casing → BIB.

## Unit vocabulary
count (coconuts, Piece), kg, litre; base-unit conversions configured per material (avg-unit-weight for count, density for litre↔kg). Never display summed mixed units; convert then sum (mass balance).
