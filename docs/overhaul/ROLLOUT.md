# ROLLOUT — flag-by-flag checklist and rollback

Delivered at the Phase-6 close-out (QA_HEAVY). Every phase rides its own flag(s)
(FLAG_KEYS in src/lib/contracts.ts + `dashboards_<module>`), so rollout is flag order,
and rollback is a flag flip — EXCEPT where a gate below says otherwise.

**Standing constraint (STATE.md):** no flag in this document may be enabled on any
deployment that can reach Zoho while the legacy engine is alive. Zoho engine deletion is
scheduled 2026-10-19; flag flips happen after that, on the user's explicit go, and only
against `roligt-ops-prod` by the user (QA/scripts never touch prod).

## Roll order (each step: checklist → enable → verify → soak)

| # | flag | what ships | checklist before enable | verify after | rollback |
| --- | --- | --- | --- | --- | --- |
| 1 | `shell_nav` | process-order sidebar, RBAC-gated nav | seed-rbac run against target env (`npx tsx --env-file=.env scripts/workos/seed-rbac.mjs`; `*_PROD` vars for prod); roles see only their pages | every role logs in and sees its own nav | flip off — SPA falls back to flat nav |
| 2 | `pipeline` | Pipeline Home + Batch Detail | batch detail loads for one old + one new batch (version ride-along present) | operators walk a batch end-to-end | flip off |
| 3 | `batch_v2` | v2 stage forms (run/blend/pack) | forms render on phone width; QR lot scan works; zero-recipe guard green | one real batch pressed + closed in v2 | flip off (v1 forms return; batches carry their own state) |
| 4 | **`qc_gate_v2`** | server-enforced QC release gate | **GATE 1 below must be closed first** | Journey-D replay against the target env: refused draw → discard path works → release → pack → dispatch | flip off (gate stops refusing; released/quarantine states already written stay) |
| 5 | `dispatch_v2` + `shipments` | packaging decision + partials, board, delivery PWA | PWA installed on one agent phone; challan presigns resolve; delivery agents scoped (agent 404-never-403) | one real round trip: dispatch → board → PWA confirm/sign → challan PDF → Delivered | flip off (board + PWA hide; dispatches/challans already written stay) |
| 6 | `dashboards_<module>` ×10 | live dashboards (one flag each) | KPI module answers for every role that holds its page; stale/refresh visible | one module at a time, a day apart, procurement first (already read-only folds) | flip the one module's flag off — report catalog falls through |

## GATE 1 — blocks `qc_gate_v2` (the stuck-dirty refusal)

The sync engine cannot tell a rules refusal (422) from an outage: the refused write is
held on the device and retried until a CAS loss 409s it (reproduced in journey-d run 2 —
`rules.rejected`/`released_only`, then `Another device saved BAT-2026-0011 first`).
Before enabling `qc_gate_v2` in production:

- [ ] the commit-refusal (422 `rules.*`) response is surfaced as a DISCARDABLE state in
      the UI (the toast names what was refused and offers discard), and
- [ ] discarding writes an audit row (who discarded what, on which device), and
- [ ] the offline retry loop stops retrying writes the server has refused with a
      deterministic guard (422 + rules code, not 5xx/429).

Until then the flag stays off in any env with real operators.

## GATE 2 — before the PWA fleet grows (5+ delivery phones)

The delivery PWA boots the full 215 KB snapshot; 59% of it is audits (37.5%) + ledger
(21.9%), which the delivery app never renders. Split before fleet growth:

- [ ] snapshot projection per page-role already withholds collections — verify agents'
      payloads omit audits/ledger; if they do not, add the withholding for
      delivery-agent callers (ROLLOUT blocking, small change), and
- [ ] desktop/admin boot: move audits behind a paged route (`/api/audits?before=`)
      instead of the boot payload; snapshot then ≈ 130 KB.

## GATE 3 — data safety at each step

- [ ] nightly `wrangler d1 export roligt-ops-prod` (or equivalent) is confirmed running
      BEFORE flag 5 (dispatch/challan data starts mattering in court/finance terms).
- [ ] the D1 migration state doc stays current (cutover done 2026-10-12; Zoho engine
      deletion 2026-10-19 — flag flips wait for it).

## Rollback drill (run once on staging BEFORE step 1)

Flip each flag off, one at a time, on the staging copy; after each flip:

- [ ] the app boots, the old surface renders, and previously-written v2 documents
      (batches, dispatches, challans, QC verdicts) still read correctly under v1 surfaces;
- [ ] no document written under a flag corrupts a v1 form (known-good: version
      ride-alongs are additive; ledger lines are flag-agnostic).
