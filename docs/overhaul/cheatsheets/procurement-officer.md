# Cheat sheet — Procurement officer

*Applies when the new look (Pipeline) is switched on. Your pages: Procurement, Suppliers.*

## Open first
**Pipeline** (the board) → the Receipts tile shows today's loads; the Grading tile shows
staged lots still owed a grade.

## Your loop
1. **Raise the PO first** — Procurement → Purchase orders → *New*: vendor, items, qty,
   expected-on. Send it, then get it **acknowledged** (a receipt cannot link to a
   draft/sent order — the app will tell you exactly that).
2. **Receive goods** — Procurement → Receive goods: pick or scan the order, book the load
   (count, rate, transport). The GRN links itself to the PO.
3. **Coconuts arrive → grade the same day** — Procurement → Grade coconuts: the staged lot
   is in the queue; A/B/C/reject split (the gate's counts are pre-filled, you can correct).
   Grading moves the load out of quarantine and prices it.
4. Other materials (tea extract, powders, fruit) need no grading — they land in inventory
   or blending stock as received.

## Words to know
- **Staged** = received whole, waiting for its grade split.
- **READY_EXTRACT** materials skip pressing and go straight to stock; **DIRECT_USE** go to
  blending.
- A **lot** is one received load; it keeps its number for life.

## Gotchas
- A repeat GRN↔PO link is safe (the linkage is a set, never doubled).
- Costs are the server's word — your screen shows a preview, the record is stamped on save.
- Half-filled forms come back (drafts are kept on the device).
