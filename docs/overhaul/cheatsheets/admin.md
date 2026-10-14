# Cheat sheet — Admin

*Applies when the new look (Pipeline) is switched on. Your pages: Users, Roles &
Permissions, Settings, and the masters.*

## Your loop
1. **Compose roles by ticking pages** — Roles & Permissions: a tick is the permission
   **and** that page's writes. A caller holding any page is scoped to exactly their pages;
   a caller holding none is an operator (the open day's work). Roles are data — no code
   change, ever.
2. **Users** — accounts, sign-in, role assignment. A role change lands on the person's
   next refresh, no logout needed.
3. **Settings** — tolerances (yield, mass-balance, expiry alert days), numbering series
   (GRN, batches, DCs/challans), the pipeline "stuck" threshold (default 2 days), label
   lines, storage defaults.
4. **Masters** — Suppliers, Customers, Products & Materials (procurement form, storage
   condition, min/max), Test Parameters (QC), Compliance (licences/expiry reminders).

## Onboarding a new person (the 3-minute version)
1. Tick their pages onto their role, save.
2. They sign in → the first-run tour offers itself once; "?" replays it any time.
3. Their sidebar and cheat sheet ("?" → My cheat sheet) list exactly their screens.
4. Hand them their printed cheat sheet from `docs/overhaul/cheatsheets/`.

## Words to know
- **Scoped caller** = holds at least one page; sees exactly those. **Operator** = holds
  none; sees the whole open tier.
- Feature flags (Pipeline, nav, gates) live in the database, not in code — toggling is an
  admin action, takes effect within ~20 s, and every flag has a Classic rollback.

## Gotchas
- The delivery-agent role is **not** created yet (Phase 4) — do not pre-tick external
  accounts; an account with zero pages falls back to the operator tier today.
- Never enable a gate flag (qc_gate_v2, batch_v2) while the old Zoho engine is reachable.
