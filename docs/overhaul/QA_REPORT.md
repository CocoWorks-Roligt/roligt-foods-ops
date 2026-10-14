# QA_REPORT — Phase 3 close-out (LIGHT re-run + HEAVY once)

Run 14–15 Oct 2026 (IST), this session, against `dev` at the W16 Phase-3 tip.
Harness: `npm run build:e2e` + `scripts/e2e/up.mjs` (prod-like D1 dump + backfill +
pipeline/shell_nav flags ON; d1-shim for Cloudflare; dev sessions for WorkOS).
The production DB (`roligt-ops-prod`) was never touched.

## Verdict

**PASS.** Journey A 10/10 through dispatch; all LIGHT gates at baseline; Lighthouse
a11y ≥ 98 on all three key screens; no horizontal scroll at any width.

## HEAVY — Journey A (once, per the roadmap)

`npx playwright test journey-a` — **10 passed (53.9s)**, plus `boot` 1/1:

  coconut PO (raised → sent → acknowledged) → staged receipt (linked to the PO,
  lot held for grading) → grades account for the whole load → pressing with spoilage
  & close → coconut-milk blend closed (variance 0) → QC release → 5 L BiB pack with
  control samples → Fernandez order for 8 BiBs → dispatch complete → the milk's
  genealogy names the extraction batch, the receipt and both draws.

Journey deviations (both data-forced, documented in the spec header): the milk recipe
is E2E-seeded; the BiB packs the coconut-water bulk (the plant's FG-0001 packs SF-0002).

## LIGHT gates (full uncommitted diff)

| gate | result |
|---|---|
| `tsc -b` | clean |
| `vitest run` | 1080 passed \| 7 skipped (baseline +3 from the sync regression test) |
| lint | 10 warnings, 0 errors (baseline) |
| `build` / `build:e2e` | pass; assert-no-apptics clean (103 files) |
| e2e `boot` | 1/1 |

## §5 Accessibility + Lighthouse (key screens)

| screen | a11y (mobile) | perf (mobile sim) | perf (desktop preset) |
|---|---|---|---|
| Pipeline Home | 98 | 65 (FCP 4.8s, LCP 6.5s, TBT 0, CLS 0) | **96 (FCP 0.9s, LCP 1.2s)** |
| Production run | 100 | 64 (FCP 5.0s, LCP 7.1s, TBT 0, CLS 0) | — |
| Order desk | 100 (after fixes; was 83) | 64 | — |

Mobile numbers are simulated slow-4G throttling of a ~218 KB snapshot boot; TBT 0 /
CLS 0 say the JS is not the story. The duty's own bar — first meaningful paint < 2 s
on LAN — is met (desktop FCP 0.9 s). The throttled-mobile gap is a Phase-6
investigation item (snapshot size/split), not a Phase-3 defect.

## §6 Visual verification

39 screenshots at `.artifacts/screenshots/` (13 existing key screens × desktop
1280 / tablet 768 / phone 390). Checklist outcome:

- **No horizontal scroll** on any screen at any width (measured, not eyeballed).
- **Status not color-only**: every badge/chip on pipeline/orders/quality carries text
  (0 of 16 color-only).
- **Tap targets**: all primary controls standard height; one observation — data-table
  sort-header buttons measure ~13 px on phone (desktop affordance on a
  horizontally-scrolled table; acceptable, noted for Phase 6).
- Shipment board / delivery PWA / challan PDF do not exist yet (Phase 4+) — not shot.

## Defects found & fixed this run (all verified by re-run)

1. **Select never forwarded `aria-label`/`aria-labelledby`** — every combobox using
   them was nameless to screen readers *and* role queries (8 call sites affected;
   journey leg 8 found it). Fixed in `components/Select.tsx`; call sites pass labels.
2. **Desk quick-order form: Customer picker + Order date + Ship by unnamed** — the
   sibling `<label>`s are not associated. aria-labels added (Lighthouse `button-name`,
   `label`). Orders' raise-order modal got the same three.
3. **Bottom-nav "More" button's accessible name didn't contain its visible text**
   (`label-content-name-mismatch`) → "More — open navigation menu".
4. **13 `type-tabs` strips declared `role="tablist"` with plain-button children**
   (`aria-required-children`) — the role was never honoured (no `role="tab"`, no
   arrow-key contract), so it was removed; a styled button strip is honest as buttons.
5. **Harness false-positive**: `failOnPageErrors` latched the browser's console line
   for commit 409s. 409 is the commit endpoint's designed CAS refusal — refused whole,
   winners adopted, re-saved (every leg's settle guard passed). Now exempted like 429.

## QA observations (no action this phase)

- **"Posted" precedes durability.** Under a realistic operator pace the plant's commit
  throttle (8/min sustained) queues late-journey commits for tens of seconds while the
  UI toasts success immediately. Data was never lost (spill keys + settle guard prove
  the drain), but the plant sees success before the server accepts it. Phase-6 UX item:
  a "saved on this device / queued" state distinct from "posted".
- **Sync/boot fixes from the prior session rode this run** (commit-CAS version
  ride-along stripped; ThrottledError boot-retry; flags in the mirror envelope for
  fast-path reloads) — each has a regression test; all exercised by the journey.
- Spec pitfall documented in-file: batch ids are `BAT-YYYY-NNNN` — `\d+` cannot span
  the inner hyphen (cost an hour; the failing regex failed in plain Node too).

## Not covered / deferred by design

Journeys B–E and negative/offline-replay suites (Phase 6), signature/challan legs
(Phase 4 SHIPMENT), API p95 profiling at prod scale (Phase 6), delivery PWA on 4G
(Phase 4+), RBAC matrix by test (LIGHT tier ran the unit RBAC suite; full matrix E2E
is Phase 6 with the delivery roles that exist then).
