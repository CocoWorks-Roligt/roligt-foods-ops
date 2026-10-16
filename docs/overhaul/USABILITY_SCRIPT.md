# Usability test script — 5 tasks, 3–5 real users, before and after the overhaul

Run BEFORE rollout (on staging, flags all ON) and repeat AFTER two weeks of live use;
score each task Pass / Pass-with-help / Fail, and note every hesitation verbatim.
One facilitator, one user, one device at a time — phone for tasks 1–3 (operator/agent),
desktop for 4–5 (office/QC). Say only what is printed in quotes; answer questions with
"do what you would normally do."

**Setup per user:** fresh browser profile, app logged in as the role the task names.
Do not reset data between users — the messiness is realistic.

## Task 1 — Receive a coconut load (phone, Operator role)

Say: "A truck of tender coconuts has arrived. Show me what you do."
Success criteria:
- [ ] finds Procurement → Receive without prompting
- [ ] links the load to the right PO (or raises one if they say none exists — both valid)
- [ ] stages the receipt for grading rather than guessing grades at the gate
- [ ] the lot shows held for grading afterwards, and they can say where it is

## Task 2 — Pack from a batch (phone, Operator role)

Say: "The cold brew batch is released. Pack twelve 1-litre bottles."
Success criteria:
- [ ] finds the pack stage from Home without back-tracking more than once
- [ ] picks the right lot (reads 'on hand', not just the first row)
- [ ] enters 12 packs — NOT 12 litres — and the preview matches
- [ ] after posting, can answer: "where did the bottles go?" (storage area shown)

## Task 3 — Deliver a round (phone, delivery agent, offline test)

Say: "Do your round. I'll cut the internet halfway — don't stop."
Cut network (or airplane-mode the phone) after Start delivery.
Success criteria:
- [ ] the app does not block or show a raw error when the network drops
- [ ] the banner/wording tells them their work is saved on the device
- [ ] records delivered/rejected counts + signature + printed name offline
- [ ] with network restored (say: "internet's back"), the trip syncs to Delivered
    (verify on the office board yourself)

## Task 4 — Chase a short order (desktop, office/desk role)

Say: "Fernandez is asking where their order is. Find out."
Success criteria:
- [ ] finds the order and reads its status without opening a print/export
- [ ] if stock is short, the app TELLS them why dispatch isn't possible
      ('has to be filled before it can be dispatched') — they don't guess
- [ ] can answer: "what's on the truck and when does it ship?" from one screen

## Task 5 — Release a held lot (desktop, QC role)

Say: "The lab results are in — the morning water lot is clean. Free it up."
Success criteria:
- [ ] finds the lot on the QC page (not by URL/memory)
- [ ] records Pass verdicts and releases in one flow
- [ ] afterwards can answer: "can packing take from it now?" correctly (yes — released)
- [ ] bonus watch: do they look for the verdict to appear anywhere (audit/drawer)?
      — a look that finds nothing is a finding, note it

## Scoring

A task is PASS only if every checkbox under it lands unaided. After all 5 tasks, ask:
"What did you expect to happen that didn't? What did you do to work around the app?"
Record before/after deltas per task; any task scoring below 3/5 Pass after go-live
goes back to the owning handoff note.
