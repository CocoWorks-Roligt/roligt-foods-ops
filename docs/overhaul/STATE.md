# STATE — Beverage Ops Platform Overhaul
Updated: 2026-10-13 | Phase: 2 (BACKEND B3 done; next B4 kpis/SSE) | Branch: dev | Base: de4c13b

## Contracts
- v1.1 (2026-10-13, LEAD): src/lib/contracts.ts — frozen v1 plus additive deltas (challan, recipeId,
  avgUnitWeight naming); changelog in the file header + ARCHITECTURE.md §8. SHELL builds against v1.1.

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
- api-imported src/lib files need .ts import extensions (the numbering/grn/stockIds closure now has them — keep it that way).
- User-facing word is "blend(s)", never "melange" (code/data names may keep it).
- Flags are a D1-engine concern only: gated endpoints 503 when D1 env is unset (postRoutes), and the
  Zoho commit arm never reads the flags collection. Never enable qc_gate_v2/batch_v2 on any deployment
  that can still reach Zoho (engine deletion planned 2026-10-19); flag toggles are LEAD-only until then.
- batch_v2 stays OFF everywhere until the mass-balance decision lands (DECISIONS #2: 3/14 historical
  batches pass at 2% — extraction cannot close under enforcement today).
- If the split (multi-file) prompt version is adopted: do NOT copy its STATE/PROGRESS/DECISIONS
  templates over the live files, and rename its DOMAIN.md (business rules) before adding — the live
  DOMAIN.md is the current-state map and they collide.
