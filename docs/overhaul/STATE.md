# STATE — Beverage Ops Platform Overhaul
Updated: 2026-10-13 | Phase: 2 (BACKEND B1 backfills) | Branch: dev | Base: de4c13b

## Contracts
- FROZEN 2026-10-13: src/lib/contracts.ts (post-Phase-1). Changes require LEAD approval + version bump.

## DB target — CONFIRMED 2026-10-13 (audit slice 3)
- Unit/integration: local better-sqlite3 in-memory against real `scripts/d1/schema.sql` (what `npm test` does).
- Remote integration/smoke: `roligt-ops-scratch` (D1 id 28356095-…, staging, verified copy of prod @ 2026-10-12 cutover). `.env` pins scratch.
- PROHIBITED: `roligt-ops-prod` (id de8175f2-…) — never execute, never point scripts at it. Prod schema applies only at deploy time by the user.
- Schema changes = additive edits to `scripts/d1/schema.sql` (no migrations dir); re-apply to scratch via
  `npx wrangler d1 execute roligt-ops-scratch --remote --file scripts/d1/schema.sql --yes`; refresh views `node scripts/d1/views.mjs`.
- Live smoke (opt-in, writes+cleans on scratch): `D1_SMOKE=1 npm test`.
- Prod-like local copy: `npx wrangler d1 export roligt-ops-scratch --remote --output scripts/d1/dump-<date>.sql`, load `--local` only.
- Never print secret values; mask tokens in command output.

## Locks
- none

## Rollback markers
- Phase 0 touches docs/overhaul/* only. Rollback = remove those files.

## Invariants watch
- tsc gate is `tsc -b` (root tsconfig is solution-style; `tsc --noEmit` checks nothing).
- api-imported src/lib files need .ts import extensions.
- User-facing word is "blend(s)", never "melange" (code/data names may keep it).
