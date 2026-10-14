# Cheat sheet — Store / Dispatch

*Applies when the new look (Pipeline) is switched on. Your pages: Inventory, Packing
Materials, Stock Issues, Storage, Orders, Dispatch.*

## Open first
**Pipeline** → the Stock tile (holds, near-expiry, materials below reorder), the Orders
tile (open orders, overdue first), the Dispatch tile (left, not yet closed with a POD).

## Your loop
1. **Put away what the app itself flags** — Inventory → *Put away*: the queue is only stock
   standing somewhere wrong (a hold area it should leave, a deactivated room, an unusual
   home). A move changes **where** stock sits, never its QC status.
2. **Watch materials** — Packing Materials: min/max with reorder alerts; the Stock tile
   carries low-material notes too.
3. **Fill orders** — Orders → *Order desk*: raise/edit (the desk asks customer, ship-by,
   ≥1 line); each line is shown against released stock as a **guide, not a reservation**.
4. **Dispatch** — Orders → *Dispatch*: picks seed themselves oldest-released-first; the
   button stays off until every line can be filled (all-or-nothing). Vehicle is remembered.
5. **Dispatches in flight** — Dispatch register: each row owes its **proof of delivery**
   (arrives with Shipment Tracking, Phase 4). Rejected goods at delivery become a Return
   QC decides about.

## Words to know
- **Released** stock only is dispatchable — hold-area stock is refused with the reason.
- **FEFO** — picks are seeded first-expiry-first-out; you may override, the save re-checks.
- Cartons for BIB dispatch are decided at dispatch time (a carton master arrives with the
  shipment work).

## Gotchas
- Write-offs (damaged/lost) are **Stock Issues**, never a move.
- Over-drawn lots show a banner — two devices drew the same lot; reconcile, don't re-post.
