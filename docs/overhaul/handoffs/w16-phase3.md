# Handoff — W16 + Phase 3 WORKFLOW close (2026-10-14)

W16 (Onboarding) done @ 7cadffb; Phase 3 WORKFLOW complete. Gates: tsc -b clean,
1077 tests (+5), lint 10 (baseline), build pass. Contracts stay v1.7.

**What shipped (W16):** `src/lib/onboarding.ts` — PAGE_HELP (one line per catalog page;
sidebar `title` tooltips + cheat sheet, coverage-tested) and STAGE_HELP (pipeline tiles,
pinned to stage ids). `shell/Tour.tsx` — first-run spotlight tour, once per device
(`roligt_tour_done_v1`), anchors via `data-tour` (pipeline row, process nav, search, theme,
help); missing/hidden anchor → centered card, never skipped. `shell/HelpMenu.tsx` — "?"
popover: replay tour / My cheat sheet (the caller's own pages — roles are data) / feedback
(clipboard + device outbox `roligt_feedback_outbox`, NO endpoint — DECISIONS W16).
Printable role pages: `docs/overhaul/cheatsheets/` (8; delivery-agent marked Phase-4).

**Next session (Phase 3 close-out, per STATE "After W16"):**
1. QA LIGHT re-run (gates already green at slice end; re-run if any diff lands).
2. HEAVY once: Journey A as far as it exists — coconut PO → receipt → grading →
   extraction (spoilage) → blend → BIB pack → dispatch; signature/challan legs wait for
   Phase 4. Negative paths: double-submit, short-line refusal, hold-area refusal.
3. No browser-E2E tooling exists. Decide Playwright (or equivalent) + one-line DECISIONS
   justification (dev-only dep) before writing journeys. Multi-viewport screenshots +
   Lighthouse ≥ 90 per QA §6; defects → owning-agent handoff notes.

**Watch:** flags stay OFF everywhere (Zoho engine deletion 2026-10-19); scratch DB only;
`roligt_tour_done_v1` on shared tablets means the tour greets once per device, not per
operator — acceptable (Help replays), noted in DECISIONS.
