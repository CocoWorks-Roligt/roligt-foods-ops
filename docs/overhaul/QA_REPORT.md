# QA_REPORT — Phase 4 close-out (HEAVY: Journey A extended through delivery)

Run 15 Oct 2026 (IST), this session, against `dev` at the Phase-4 tip (6ec38f4 + docs +
this run's harness slices). Harness: `npm run build:e2e` + `scripts/e2e/up.mjs` — now
THREE local servers: SPA+BFF (`E2E_PORT`, 3100 this run), d1-shim (:8111), and the NEW
r2-shim (:8112, in-memory S3-compatible stand-in; `R2_ENDPOINT` in api/_lib/r2.ts points
every presign at it). prepare-db flips shell_nav + pipeline + shipments; delivery legs
ran as the dev session (Admin) — the harness has no agent login, and the agent-scope
404-never-403 contract is already pinned by B5 service tests. `roligt-ops-prod` untouched.

## Verdict

**PASS.** Journey A 14/14 (boot smoke + 13 legs): PO → staged receipt → grading →
extraction close → blend close → QC → BIB pack → order → dispatch → board trip →
PWA start/confirm/sign/submit → challan DC0017/2026 minted → board Delivered → lazy PDF
fetched (`%PDF` through the 302 presigned GET). All LIGHT gates at baseline. Lighthouse
a11y 98 on both new screens. No horizontal scroll on any screen at any width.

## §4 E2E — what the delivery extension pinned

- Board create-trip: matched against leg 9's OWN order id — the dump carries old
  undelivered Fernandez orders with empty vehicles, and name-matching boards the wrong
  one. All dispatch rows boarded (FEFO may split 8 units across lots — count not pinned),
  vehicle seeded from the order row, agent = dev session.
- PWA: Start delivery walks Created→Dispatched→Out for Delivery; per-line confirms speak
  the dispatch row's own vocabulary (lot + qty out — the pack's item id, not its name);
  the signature is real ink (mouse-dragged strokes, accessible name flips to "signed");
  printed name + phone required; submit → "Delivery recorded. The challan is with the
  office." Photo + signature upload = presigned PUTs into the r2-shim (200s).
- Challan: minted by submit; its id IS the DC number (`DC0017/2026`, arrives `%2F`-encoded
  and must reach the handler DECODED). The PDF is lazy — the first GET probed R2, missed,
  rendered, PUT, and 302'd to a presigned GET; `page.request` followed it to a body
  starting `%PDF`.

## Harness changes this run (test-infra only; no app behavior change)

1. **r2-shim + R2_ENDPOINT** — presign honors `R2_ENDPOINT` (any S3-compatible endpoint;
   unset = R2's cloudflarestorage.com URL byte for byte — pinned by a new r2.test.ts
   case). up.mjs boots the shim and points the BFF at it; the shim is a bucket, not a
   verifier (SigV4 stays unit-pinned).
2. **dev-server route table caught up to Phase 4** — /api/shipments, /api/challans,
   /api/returns + 7 param routes registered; param segments now arrive DECODED
   (Vercel's file-router parity). Surfaced by the narrowed console-error filter, which
   no longer swallows 404s whose URL rides `msg.location()` instead of the text.
3. **E2E_PORT** — playwright.config and the screenshot walk honor it; :3000 is often the
   user's own unrelated server (see Defects #1).
4. **boot census unpin** — navBadges' samples count is horizon-based and grows as the
   dump ages (7→8 within a day); the smoke pins "a live digit", never a census.

## §5 Accessibility + Lighthouse (the two new screens)

| screen | a11y (mobile) | perf (mobile sim) | perf (desktop preset) |
|---|---|---|---|
| Shipments board | 98 | 65 (FCP 4.7s, LCP 6.5s, TBT 0, CLS 0) | **95 (FCP 0.9s, LCP 1.3s)** |
| My Deliveries (PWA) | 98 | 65 | **95 (FCP 0.9s, LCP 1.3s)** |

Same profile as the W17 screens — the throttled-mobile gap stays the Phase-6
snapshot-size item (TBT 0 / CLS 0 say the JS is not the story). Only failing a11y audit
on both: `heading-order` (an h3 in the shared section-head card under the h1) — the
same standing flag Pipeline Home carries; Phase-6 candidate, not a P4 regression.

## §6 Visual verification

45 screenshots (15 screens × desktop 1280 / tablet 768 / phone 390) — shipments-board
and my-deliveries join the walk, shot against the post-journey DB (`up.mjs
--skip-prepare`) so the board carries the Delivered trip and its challan. The two new
screens additionally ran a programmatic checklist (`.artifacts/qa-p4-visual-checks.mjs`,
PASS 11/11): no horizontal scroll at any width; status text never color-only ("Delivered"
badge + card); challan link (DC0017/2026) visible in the Delivered row; row drawer opens
with "Delivered at"; New trip ≥44px on tablet/phone (45px; 41px on desktop — a mouse
context where WCAG AA's 24px applies, and the CSS grants 44 under its ≤900px touch rule);
PWA trip card carries status text, and its action buttons are `.btn` (same 44px rule).

## Defects found & fixed this run (all harness/tests — zero app-source changes beyond
the additive R2_ENDPOINT branch + its test)

1. **The screenshot walk photographed the wrong site** — qa-screens.mjs BASE was
   hardwired to :3000, the user's own unrelated server; all 45 PNGs were of a consumer
   drink page, complete with a plausible "no horizontal scroll". Caught because the CDN
   image viewer showed a drink-activation page. BASE now derives from E2E_PORT.
2. **/api/shipments 404 in the harness** — dev-server's explicit route table predates
   Phase 4; the tightened console filter (Defect-class change in helpers.ts: exclusions
   match by `msg.location().url` too, so a URL-less "Failed to load resource" no longer
   hides a REAL 404 elsewhere) exposed it. All 10 Phase-4 routes registered.
3. **Challan file 404** — param segments arrived percent-encoded; Vercel decodes.
   matchParamRoute decodes now.
4. **boot.spec pinned a growing census** — unpinned (see Harness #4).

## QA observations (no action this phase)

- `heading-order` (above, both new screens and Pipeline Home).
- The PWA's delivered card is terminal — no actions render; both the actionable and
  terminal card states carry designed content.

---

### Phase 3 close-out (LIGHT re-run + HEAVY once)

Run 14–15 Oct 2026 (IST), this session, against `dev` at the W16 Phase-3 tip.
Harness: `npm run build:e2e` + `scripts/e2e/up.mjs` (prod-like D1 dump + backfill +
pipeline/shell_nav flags ON; d1-shim for Cloudflare; dev sessions for WorkOS).
The production DB (`roligt-ops-prod`) was never touched.

### Verdict

**PASS.** Journey A 10/10 through dispatch; all LIGHT gates at baseline; Lighthouse
a11y ≥ 98 on all three key screens; no horizontal scroll at any width.

### HEAVY — Journey A (once, per the roadmap)

`npx playwright test journey-a` — **10 passed (53.9s)**, plus `boot` 1/1:

  coconut PO (raised → sent → acknowledged) → staged receipt (linked to the PO,
  lot held for grading) → grades account for the whole load → pressing with spoilage
  & close → coconut-milk blend closed (variance 0) → QC release → 5 L BiB pack with
  control samples → Fernandez order for 8 BiBs → dispatch complete → the milk's
  genealogy names the extraction batch, the receipt and both draws.

Journey deviations (both data-forced, documented in the spec header): the milk recipe
is E2E-seeded; the BiB packs the coconut-water bulk (the plant's FG-0001 packs SF-0002).

### LIGHT gates (full uncommitted diff)

| gate | result |
|---|---|
| `tsc -b` | clean |
| `vitest run` | 1080 passed \| 7 skipped (baseline +3 from the sync regression test) |
| lint | 10 warnings, 0 errors (baseline) |
| `build` / `build:e2e` | pass; assert-no-apptics clean (103 files) |
| e2e `boot` | 1/1 |

### §5 Accessibility + Lighthouse (key screens)

| screen | a11y (mobile) | perf (mobile sim) | perf (desktop preset) |
|---|---|---|---|
| Pipeline Home | 98 | 65 (FCP 4.8s, LCP 6.5s, TBT 0, CLS 0) | **96 (FCP 0.9s, LCP 1.2s)** |
| Production run | 100 | 64 (FCP 5.0s, LCP 7.1s, TBT 0, CLS 0) | — |
| Order desk | 100 (after fixes; was 83) | 64 | — |

Mobile numbers are simulated slow-4G throttling of a ~218 KB snapshot boot; TBT 0 /
CLS 0 say the JS is not the story. The duty's own bar — first meaningful paint < 2 s
on LAN — is met (desktop FCP 0.9 s). The throttled-mobile gap is a Phase-6
investigation item (snapshot size/split), not a Phase-3 defect.

### §6 Visual verification

39 screenshots at `.artifacts/screenshots/` (13 existing key screens × desktop
1280 / tablet 768 / phone 390). Checklist outcome:

- **No horizontal scroll** on any screen at any width (measured, not eyeballed).
- **Status not color-only**: every badge/chip on pipeline/orders/quality carries text
  (0 of 16 color-only).
- **Tap targets**: all primary controls standard height; one observation — data-table
  sort-header buttons measure ~13 px on phone (desktop affordance on a
  horizontally-scrolled table; acceptable, noted for Phase 6).
- Shipment board / delivery PWA / challan PDF do not exist yet (Phase 4+) — not shot.

### Defects found & fixed this run (all verified by re-run)

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

### QA observations (no action this phase)

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

### Not covered / deferred by design

Journeys B–E and negative/offline-replay suites (Phase 6), signature/challan legs
(Phase 4 SHIPMENT), API p95 profiling at prod scale (Phase 6), delivery PWA on 4G
(Phase 4+), RBAC matrix by test (LIGHT tier ran the unit RBAC suite; full matrix E2E
is Phase 6 with the delivery roles that exist then).
