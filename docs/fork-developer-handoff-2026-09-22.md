# Roligt Ops on Zoho Tables — Developer Handoff

**Date:** 2026-09-22 · **Read order:** this file → [implementation notes](fork-implementation-notes-2026-09-22.md) (esp. §4 API contracts) → [roadmap](fork-roadmap-2026-09-22.md). Repo: `roligt-foods-ops-zoho`, branch `zoho-tables-backend` (== `main`), tag `plan1-complete` (`d03e025` + cleanup). 50 tests, tsc clean, oxlint 13w/0e, build clean.

---

## 1. Repo map — what lives where, what never to touch

```
src/                       THE APP — unchanged from the Supabase original except:
  lib/dbApi.ts               REWRITTEN: three fetch calls to the BFF (only transport file)
  lib/authToken.ts           NEW: token hand-off AuthContext → dbApi
  lib/roles.ts               NEW: the one Admin/Operator rule (dual-compiled client+server)
  lib/kindeSession.ts        NEW: the only file touching the Kinde SDK (KindeBridge binds hooks)
  lib/uploads.ts             REWRITTEN as session-local shim (regression; see roadmap §5.3)
  context/AuthContext.tsx    REWRITTEN: Kinde + dev fallback, same public interface
  pages/Login.tsx            REWRITTEN: Kinde button / dev role picker
  context/AppContext.tsx     UNTOUCHED logic (comment + .ts-import tweaks only)
  context/domains/, lib/sync.ts, lib/localDb.ts, data/seed.ts, all other pages:
                            DO NOT TOUCH — this is the point of the fork
api/
  _lib/zoho.ts             ZohoClient: token, serialized budgets (26r/17w per min),
                           cursor paging, keyed upserts, error/lock classification
  _lib/baseSchema.ts       GENERATED (scripts/zoho/gen-base-schema.mjs) — never hand-edit
  _lib/shared.ts           the ONE ZohoClient instance + assertBaseMatch boot guard
  _lib/auth.ts             JWKS verify, AuthError, guarded dev session
  _lib/mappers.ts          doc ⇄ base columns (read generic; write enrichment)
  _lib/snapshot.ts         base → Partial<AppState> (keyed by COLLECTION KEY, not table name)
  _lib/commit.ts           StateChanges → idempotent writes + role gate + revision bump
  snapshot.ts/revision.ts/commit.ts   handlers: authenticate → lib → status map
scripts/zoho/              base maintenance (topup, probe, make-scratch, gen-schema)
scripts/dev-server.mjs     local server: dist/ + /api/* + .env + --seed-scratch
docs/                      spec, plan, probe results, e2e evidence, this handoff set
```

## 2. Invariants — break these and the app silently corrupts

1. **Every write is an upsert keyed by a business key.** No blind creates, ever. Retried commits must re-write the same rows. If you add a write path, key it (App ID / Series / Setting) and add a retry-idempotence test (`commit.test.ts` has the pattern — fake persists upserts, second run must be a no-op or byte-identical).
2. **Reads use App ID + Data JSON only.** Real columns are for Analytics/links. Never make the app depend on an enriched column — enrichment is best-effort by design (unknown field names are silently dropped at the `columnsByFieldId` translation).
3. **The ledger is append-only; audits are insert-only.** Reversals are new negative lines (client rule, unchanged). The BFF skips audit upserts whose App ID already exists — keep that when touching commit.ts.
4. **Role gate before any budget spend.** adminOnly tables, `changes.config`, and audit deletions refuse non-Admin before the first Zoho call. New admin-only surfaces go in the same loop in `commitChanges`.
5. **One ZohoClient.** All handlers use `shared.ts`'s instance; budgets only protect the key if every call shares them. Scripts are exempt (own throttle) but share the key's global caps — don't run scripts while the BFF is busy.
6. **Period counters live in Config rows** (`period:<key>`), never in Counters.Next — it's a number field that silently drops strings (this exact bug minted duplicate GRN numbers; there is a read-side guard for remnant rows, don't remove it).
7. **The snapshot state is keyed by COLLECTION KEY** (`vendorTypes`), not table name (`vendor_types`) — `stateKeyFor()` does the mapping; ledger/audits are special-cased. Zero-row tables emit `[]` (deliberately wiped); rows-without-Data-JSON are omitted (staged) — both semantics are test-pinned.
8. **Values to Zoho are strings**; undefined/null skipped; phone columns digits-only; keys containing `"` or `\` are refused loudly.

## 3. Daily workflow

```bash
npx tsx scripts/dev-server.mjs        # app + API on :3000 (npm run build first if dist/ is stale)
npm test                              # 50 tests, ~300ms — run constantly
npx tsc -b && npx oxlint              # before every commit; oxlint must stay 13w/0e
npm run build
```

- **tsx does not hot-reload** api/ changes — restart the dev server after touching `api/`.
- **Expect ~60s cold boots** (paced snapshot) and 4–6s commits. Never restart or reload to "fix" a slow boot — every reload spends another snapshot's reads.
- After changing the base structure: `topup.mjs` → `gen-base-schema.mjs` (with matching `ZOHO_BASE_ID`) → commit the regenerated `baseSchema.ts`.
- Scratch base for anything live: `dhorj90a2ded0152a4f1d94ae8ce4ece09a5c`. All scripts hard-refuse production except `topup.mjs` post-Phase-0.
- Scratch getting weird? `--seed-scratch` reseeds it (a few minutes of paced writes).

## 4. Zoho gotchas (each one bit us — all pinned in code or tests)

- Errors arrive as `{"error":…}` **inside HTTP 200**. The client throws on error-shaped bodies — never "check res.ok and move on".
- Query params >2KB → 414. The client auto-moves big params into a form body; don't bypass `ZohoClient.call()`.
- Criteria: string form, single-equality only (OR silently returns nothing). Array form 500s (in a 200 envelope, naturally).
- `fetchRecordsWithCriteria` rejects `field_ids` — read whole rows, take what you need.
- Phone fields drop spaced strings silently. Date-ish quirks: Data JSON is the source of truth; treat every enriched column as cosmetic.
- Rate breach locks an API family for 5 minutes and looks like a hang. If everything stalls: stop, wait 5 full minutes, don't hammer.
- The shared token cache `cw-ops/.zoho-token.json` is for scripts; the BFF keeps tokens in memory only.

## 5. How to add a collection mapper (the Phase-1 recipe)

1. `columnsFor()` in `api/_lib/mappers.ts`: add a case keyed by the COLLECTION key (`'batches'`) returning `{ 'Base Field Name': value | link(map, id) }`. Link fields resolve through `LinkMaps` (built per commit from masters; add a map there if a new master is needed).
2. Names→field-IDs translation happens automatically at the write chokepoint; unknown names are dropped (check the base has the field — `topup-state.json` is the field inventory).
3. Test: extend the commit fake-zoho test to assert the new columns arrive as field-ID keys; snapshot side needs nothing (reads are generic).
4. Child tables (Order Lines) are the exception — they need real write-split/read-join logic in commit/snapshot; do them last.

## 6. Debugging map

| Symptom | Look at |
|---|---|
| Boot hangs ~60s then works | Normal pacing. >2 min: another process eating the read budget (a script? a second dev server?) |
| Commit 503 + Retry-After | Rate lock — client dirty-queues and retries; find what burned the writes budget |
| Commit 403 | Role gate — check caller role vs the table in the 403 body |
| `assertBaseMatch` boot error | `.env` base vs regenerated schema mismatch — regenerate (§3) |
| Data looks stale on device | Revision poll (20s) or its own dirty queue holding; check `/api/revision` |
| Writes "succeed" but nothing changes | Check for an error envelope (200) — `ZohoApiError` messages carry the body |
| App falls back to seed masters | Base rows exist but lack Data JSON (staged, not adopted) — see roadmap Phase 0 §2 |

## 7. Evidence trail

- Per-task reports + execution ledger: `../roligt-foods-ops/.superpowers/sdd/` (task-N-report.md, progress.md — the full audit trail of every decision and fix round)
- Probe evidence: `docs/zoho-fork-probe-results.md` · E2E: `docs/zoho-fork-e2e-2026-09-22.md` + `gui-test-screenshots/zoho-fork/`
- Design rationale: `docs/zoho-tables-fork-design-2026-09-21.md`; task-level plan with all original code: `docs/zoho-tables-fork-plan-2026-09-21.md`
- Platform context (why this fork is the go-forward app): `docs/platform-decision-report-2026-09-22.md` + `docs/platform-proposal-2026-09-22.md`

## 8. Pointers out of the repo

- Zoho creds (Self-Client): `../.zoho.env` — server env copies values from here; never commit them.
- Original Supabase app (reference implementation): `../roligt-foods-ops` — shares nothing at runtime; its working tree still holds its own uncommitted features.
- Sibling workspace: `../cw-ops` scratch (probe notes at `../zoho-build-probe/help.html` — the unofficial API doc source).
