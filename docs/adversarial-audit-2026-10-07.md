# Adversarial audit and remediation plan — 2026-10-07

Five adversarial passes over the working tree @ `048c0cc`: auth/session/admin routes,
the commit write path, the snapshot read path, the client sync engine, and the client
application surface. Every finding below was traced end to end in code (attack path
or failure sequence verified against the source, not inferred); the headline items
were re-verified by a second reader before landing here. Severities: **S1** exploitable
security hole or data destruction, **S2** integrity/availability failure needing a
race or specific role, **S3** hardening.

The short version: the auth foundation is solid (sealed cookies, PKCE, server-side
gates everywhere, no injection sinks, no secrets in history), and the write path's
 defenses hold against the attacks they were built for — but three classes of hole
survive: **the no-page operator tier escapes gates written only for page-scoped
callers**, **client-influenced values that were trusted because an honest client
produces them honestly** (period claims, config types, timestamps, counters on
adoption), and **per-process state standing in for global state** (the commit queue,
the Zoho budget) on a platform that fans out across instances.

---

## Findings

### S1-1. Counter rewind is back: an alternative *current*-period claim unlocks the reset
- **Where:** `api/_lib/commit.ts:130-144` (`isCurrentPeriod`), `:711-719`
  (`unlocksReset`), `:720-746` (counter write loop).
- **Path:** `isCurrentPeriod` validates each `token:value` pair against the server
  clock but never compares the claim to the period the series' *pattern* produces.
  Many distinct strings are "current" at once: with stored `period:grn = "YYYY:2026"`,
  a claim of `"YYYY:2026|MM:10"` in October 2026 passes every check and differs from
  stored — `unlocksReset` fires, the `incoming < stored` rewind guard is bypassed, and
  `Next=1` is written. The commit path has no gate for a caller holding no page slugs
  (see S2-3), so any signed-in user can do this. Devices then re-mint from 1 and the
  keyed upserts overwrite the original documents while their ledger lines dangle —
  the exact kill chain `fd47de4` closed, re-opened through a side door.
- **Fix:** require the claim to equal `periodKeyFor` evaluated against the series'
  stored `Pattern` (the Counters table already carries it); at minimum require the
  claim's token set to match the stored period row's.
- **Test:** claim `"YYYY:2026|MM:10"` against stored `"YYYY:2026"` must not move
  `Next` backwards (the existing suite pins only `'x'`, stale, and far-future claims).

### S1-2. Stored XSS: sticker size config interpolated raw into a same-origin srcdoc iframe
- **Where:** `src/lib/stickerPrint.ts:66,75-78` (`@page`/`.sticker` rules interpolate
  `widthMm`/`heightMm` raw inside `<style>`; frame at `:126-130` uses `srcdoc` with
  no `sandbox`), fed by `src/context/domains/admin.ts:51-52`
  (`state.config.stickerWidthMm || DEFAULT` — any truthy string wins); the server
  validates `app_config` only as "an object" (`api/_lib/commit.ts:104-106`) with
  per-key *permission* gates but no per-key *type* validation.
- **Path:** a `page.settings` holder commits `stickerWidthMm` as
  `"50;}</style><img src=x onerror=…>"`; every client's 20s poll installs it; when
  any user prints a sticker the value closes the `<style>` element and the payload
  executes in the iframe — srcdoc without sandbox inherits the app origin, so it runs
  with the victim's session (snapshot reads, commits under the victim's permissions,
  up to and including admins).
- **Fix:** coerce both dimensions through `Number()` with fallback to the defaults at
  the print boundary (numbers cannot carry markup); add a `sandbox` attribute without
  `allow-scripts` as defense in depth; server-side, type-check known `app_config`
  keys (numbers for sticker dimensions, etc.) and reject mismatches in the shape gate.
- **Test:** a string config value renders a numeric sheet; a commit carrying a string
  `stickerWidthMm` is refused server-side.

### S1-3. Counter adoption after a 409 re-issues document numbers (duplicates, overwritten receipts, double-booked stock)
- **Where:** `src/context/AppContext.tsx:292` — `next.counters = {...local, ...server}`
  is per-key server-wins, unconditionally; interacts with the forward-only counter
  rule (`api/_lib/commit.ts:733-739`) and the no-`expect` insert conflict
  (`:508-513`).
- **Path:** phone B goes offline and mints GRN-6 and GRN-7 (local counter → 7);
  phone A online mints its own GRN-6 (server counter 6). B reconnects; its chunk is
  refused whole on the GRN-6 409 'exists'. Adoption replaces B's counter with the
  server's 6 — but B's unconflicted GRN-7 row survives locally. B's re-save pushes
  GRN-7 with no counter move (6 == 6). B's next mint is 6+1 = "GRN-7" *again*: two
  receipts share one id; the diff's second GRN-7 carries `expect` equal to B's own
  first GRN-7, which matches the stored row, so the edit is **admitted** and
  overwrites receipt #1 — no 409 ever fires, both ledger lines and audits survive,
  stock is double-counted. Any other device polling counter=6 mints 7 and collides too.
- **Fix:** in `adoptServerRows`, take the per-key max for counters (or floor at the
  highest number any surviving local row carries) and re-emit the counter diff after
  adoption so the server catches up.
- **Test:** a two-device mint race ending in 409 → adoption → re-save must leave one
  GRN-7 and a server counter of 7.

### S2-1. Boot-while-offline turns every edit of an existing row into a guaranteed loss at reconnect
- **Where:** `src/context/AppContext.tsx:540` (offline-boot catch sets
  `synced.current = null` even when the local mirror is clean and carries a recorded
  revision), `:626-631` (diff against null → every row upserted, none with `expect`);
  server answers 409 'exists' for an existing row with no `expect`
  (`api/_lib/commit.ts:504-513`).
- **Path:** phone boots in the cold room, reconcile fails, operator edits existing
  GRN-42. Network returns; the push finds GRN-42 stored and differing → 409 'exists'
  *even though nobody else touched it* → adoption overwrites the operator's edit with
  the server copy and toasts "re-enter your changes". Corrections made in any
  boot-offline session are silently surrendered. Same shape whenever the recorded
  base was lost (quota-fallback spill without `base`).
- **Fix:** when the mirror is clean (`dirty:false` + revision), use it as the diff
  base instead of null; for genuinely unknown bases, have pushes carry `expect` = the
  pre-edit mirror row so untouched-row edits land instead of conflicting.
- **Test:** boot-offline edit of an existing row, then reconnect, applies without a
  409; a genuinely concurrent server-side change still conflicts.

### S2-2. Masters-only scoped roles cannot save anything — their whole queue wedges on a 403
- **Where:** `api/_lib/commit.ts:397-417` (`ownsCollectionChange` requires a table
  with a `page` field; masters tables in `src/lib/tables.ts:92-100` carry only
  `writePermission`), `:468` (audits ride-along refusal), `:425`
  (`counterWrites && !ownsCollectionChange` → `Forbidden('ledger')`).
- **Path:** the documented "suppliers clerk" (page.vendors only) adds a vendor; the
  client's commit is vendors row + audit insert + `counters{vendor}` — no table in it
  has `spec.page`, so neither ride-along is owned and the commit is 403'd blaming
  "ledger", a table nobody edited. Every subsequent save re-includes the stuck rows,
  so every later edit in that session also 403s.
- **Fix:** count a masters-table change whose `writePermission` the caller holds as
  owning its ride-along counters/audits.
- **Test:** a page.vendors-only role's add-vendor commit is admitted.

### S2-3. The no-page operator tier escapes the ride-along gates: forged audits, ungated ledger tampering
- **Where:** `api/_lib/commit.ts:385-425` (the scoped block runs only when
  `pageScope()` returns non-null — the default operator holds no page slugs and skips
  it entirely), `:624-642` (ungated removes), `:593` (audit `at`/`action`/`details`
  are caller-written; only `actor` is session-stamped).
- **Path:** any signed-in caller with zero page slugs POSTs bare `audits` upserts
  (fabricated trail entries with arbitrary timestamps, attributed truthfully to
  themselves), bare `ledger` upserts that rewrite any existing line (echo the current
  row as `expect`, readable from the open snapshot — see S2-6), and up to 16 ledger
  removes by id with no document change and no audit row. Amounts are wholly
  caller-written. The insert-only property holds (existing ids are skipped, removes
  need `page.audit`), so this is forgery/tampering, not deletion.
- **Fix:** run the ride-along rules for unscoped callers too (only full admins
  exempt); refuse ledger removals and non-insert upserts unless paired with the
  posting's document change; server-stamp audit `at` (allow a small skew for
  offline-minted entries, or flag them).
- **Tests:** operator-tier bare-audit, bare-ledger-rewrite and ledger-remove POSTs
  are refused; document-paired rides still land.

### S2-4. One future-dated `at` blinds the delta watermark for the whole plant
- **Where:** `api/_lib/commit.ts:775-784` (backdate guard tests only
  `at < watermark` — a far-future `at` rides freely), `api/_lib/snapshot.ts:141-162`
  (`maxAt` = lexicographic max of client-controlled strings, kept through full
  re-reads), `api/_lib/zoho.ts:386-398` (bucket math: a watermark in year 9999 makes
  `count` hugely *negative*, which fails the `count > maxBuckets` guard, and the
  `startHour <= endHour` loop never runs → zero buckets → empty deltas forever).
- **Path:** one crafted ledger row with `at: '9999-12-31T00:00:00.000Z'` (rides
  freely for the operator tier per S2-3) sets the ledger watermark to 9999
  permanently; other devices' ledger lines are served stale under moved revision
  tokens until each `FULL_REREAD_MS` full read, then the cycle repeats — plus the
  full read itself every 5 minutes is permanent budget pressure.
- **Fix:** reject or floor far-future `at` values at commit (the same stance
  `isCurrentPeriod` takes on periods); clamp in `fetchSince`
  (`startHour = min(startHour, endHour)`, and treat a future watermark as
  full-read-now).
- **Tests:** a future-dated ledger row is refused (or floored); a poisoned watermark
  triggers a full read instead of an empty delta.

### S2-5. Per-process state standing in for global state: TOCTOU on `expect`, and the Zoho budget
- **Where:** `api/_lib/commit.ts:336-356` (`commitQueue` is module-level — commits
  serialize only within one warm instance), `:476-516`/`:588-609` (check-then-write
  with no Zoho-side condition; `zoho.ts:476-507` upserts are unconditional);
  `api/_lib/zoho.ts:72-132` (Budget is in-memory, per instance) — while the file's
  own header documents the real limit as *global per API key* with a 5-minute lock
  on breach.
- **Path:** two instances (or an instance and a direct Zoho edit) interleave
  pre-flight reads and upserts — both pass, last writer wins, no 409; the duplicate-
  mint guarantee ("a refused insert instead of one receipt quietly replacing the
  other") holds only when both commits land on the same instance. Likewise N warm
  instances each spend 26 reads + 17 writes per minute against the one key; under
  normal concurrency the plant can lock itself out of Zoho for five minutes at a
  time. A single caller can also pin the read window deliberately: a maximal crafted
  commit demands ~26 pre-flight reads by itself (the per-email throttle allows
  8/min), and 11+ ids in one ledger change fall back to an unbounded `fetchAll`
  paging of the whole Ledger table.
- **Fix:** optimistic concurrency that survives instances — a version/`updatedAt`
  column written conditionally, or a re-read-and-compare immediately before each
  write; move the budget window to shared state (a tiny Redis/Upstash counter, or
  Vercel Global Config) or at minimum run with jittered headroom well under the
  published cap and cap the `fetchAll` fallback for commit pre-flights; give
  `/api/snapshot` a per-session rate limit (1–2/min) and route its warm gate through
  the revision memo.
- **Tests:** a two-"instance" interleaving (two queues) produces a conflict, not a
  silent overwrite; pre-flight read spend is capped per commit.

### S2-6. `/api/snapshot` has zero read-side authorization
- **Where:** `api/snapshot.ts:12-15` (the caller is used only to attach
  permissions), `api/_lib/snapshot.ts:28-96` (`assembleState` packs every mapped
  table — masters with contacts/GSTIN, staff roster, full ledger, full audit trail
  with actor emails, config, counters — to any signed-in caller); the client then
  persists it all to localStorage (`AppContext.tsx:492-527`, `localDb.ts:213-233`).
- **Path:** the most scoped role GETs `/api/snapshot` and receives the entire plant;
  writes are page-gated, reads are gated only in the UI. Compounded by S3-2 (the
  mirror is never wiped), a scoped or later-revoked user's device keeps an offline
  copy of everything indefinitely.
- **Fix (needs a design decision):** filter `assembleState` output by the caller's
  permissions — the `COLLECTIONS` `page`/`writePermission` metadata already exists.
  Two traps to design around: (a) the wiped-vs-absent distinction — a table dropped
  from the payload must not read as "deliberately emptied" (`[]`) or as "never
  written" (seeding); send an explicit withheld-tables list so the client keeps its
  mirror untouched rather than diffing against a partial state; (b) shared devices
  and role changes mean the mirror may hold more than the new role may see — pair
  with the S3-2 wipe.

### S2-7. Delete vs edit has no tombstone: an offline edit resurrects a deleted row
- **Where:** `api/_lib/commit.ts:496-499` — `if (!stored) continue` skips the
  `expect` check entirely, so the upsert lands unconditionally.
- **Path:** admin deletes GRN-42 on phone A; phone B had edited GRN-42 offline and
  pushes later — pre-flight finds no stored row, the conflict check is skipped, the
  row is re-inserted, and B never learns the document was deleted.
- **Fix:** when `expect` is present but the stored row is missing, answer a 'changed'
  conflict (or a tombstone) instead of re-inserting.
- **Test:** delete-then-offline-edit push yields a conflict, not a resurrection.

### S2-8. Offline stock over-draw is undetected end to end
- **Where:** availability checks are client-only (`src/lib/posting.ts:397-414,
  640-678`); the server applies ledger upserts with no `expect` and no stock
  validation (`api/_lib/commit.ts:597-609`).
- **Path:** two phones dispatch/consume the same released lot offline; both pass
  locally; both ledger sets land (fresh uid ids never conflict) → negative on-hand,
  no error anywhere.
- **Fix:** architectural to offline-first without reservations — at minimum a
  post-sync reconciliation that surfaces lots whose balance went negative as a
  conflict/toast rather than silent acceptance.

### S3. Hardening tier
1. **Shared-device residual data** — `clearLocal` (`src/lib/localDb.ts:243-254`) has
   zero callers; signout and the 401 path clear React state only. The full plant
   mirror survives signout indefinitely on shared floor hardware, outliving access
   revocation. Weigh against the "work survives signout and pushes after re-sign-in"
   design; at minimum offer a wipe on explicit signout.
2. **CSV formula injection** — `src/lib/export.ts:15-16` quotes cells but `=`,`+`,
   `-`,`@` prefixes still evaluate in spreadsheets. Prefix those cells with an
   apostrophe/space.
3. **Logout CSRF via GET** — `api/auth/signout.ts:11-16`; SameSite=Lax cookies ride
   top-level GET navigations, so a cross-site link can force logout. Make signout
   POST-only.
4. **Swallowed delete errors report success** — `api/_lib/commit.ts:628-641`: *any*
   ZohoApiError during deleteRecord is treated as "vanished", the commit completes
   and bumps the revision while the row still exists; the deleting client adopts its
   own state, then the next poll re-installs the row. Swallow only when a confirming
   read says the row is gone.
5. **Counter forward-jump is unbounded** — `:733-744` refuses only backwards moves;
   `{grn: 999999999}` sticks until the next genuine rollover. Clamp forward movement
   to a small delta absent an admin-scoped claim.
6. **Error-message leaks** — `api/commit.ts:88`, `api/snapshot.ts:26`,
   `api/revision.ts:29`, `api/auth/start.ts:30`, `api/admin/users.ts:279`,
   `api/admin/roles.ts:158` return `e.message` verbatim; `ZohoApiError` embeds up to
   300 chars of raw Zoho response (base/table ids, internals). Log server-side,
   answer generic text.
7. **`page.admin-users` alone is full-admin equivalence** — `api/admin/users.ts:127-204`:
   set-roles accepts any existing role (including full-catalog) and reset-link mints
   a one-time password for *any* member. Restrict role assignment to roles no
   stronger than the caller's own, or require `page.admin-roles` for
   admin-carrying roles.
8. **Admin mutations can land un-audited** — WorkOS mutation first, audit write
   after; a `ZohoLockedError` in `writeAdminAudit` leaves the action unrecorded
   (`api/admin/users.ts:268-271`). Write the audit row first, or queue a retry.
9. **Session retirement gap when env is incomplete** — `api/_lib/auth.ts:107-121`:
   with `WORKOS_ORG_ID` unset, the wrong-org refusal *and* the active-member mirror
   check are both skipped; a removed member's sealed session lives until its refresh
   token dies. Fail closed when the vars are missing.
10. **No rate limit on `/api/auth/*`** — every request runs the slow seal/unseal KDF
    on attacker-chosen cookie values. Mirror `admitCommit`'s per-key bucket per-IP.
11. **429 `Retry-After` ignored** — `src/lib/dbApi.ts:277-308` uses a fixed 30s;
    honor the server's hint. (Paced, not a storm — efficiency only.)
12. **Shared-device attribution** — queued work from user A drains under user B's
    sign-in with audit actors re-stamped to B. Not loss; document or stamp the
    original actor at queue time.
13. **Apptics staging trust** — the SDK injects a Zoho CDN script and ships operator
    emails when `VITE_APPTICS_*` build ids are present; keep it out of production
    builds (currently documented as absent — keep it that way, and consider a CI
    assertion on the built bundle).

---

## Remediation plan

Ordered so each phase is independently shippable and test-gated. Every fix lands
with the pinning test named above; run `tsc -b`, the full vitest suite, and oxlint
at the 10-warning baseline per repo convention.

### Phase 0 — stop the bleeding (ship first, ~half a day) — DONE
1. **S1-1 counter rewind:** bind the period claim to the series' stored `Pattern`
   via `periodKeyFor`; refuse alternative-token-set claims. One file
   (`api/_lib/commit.ts`) + tests.
2. **S1-2 XSS:** `Number()` coercion at the print boundary + `sandbox` on the print
   iframe + per-key `app_config` type checks in the shape gate. Three small files.
3. **S3-4 delete-error swallow + S3-6 error leaks:** confirm-gone before swallowing;
   generic 5xx bodies. Small, contained, same PR-able.

### Phase 1 — integrity of numbers and edits (~a day) — DONE
4. **S1-3 counter adoption:** per-key max in `adoptServerRows` + re-emit the counter
   diff. The duplicate-number chain is the most expensive failure on the floor.
5. **S2-1 offline-boot base:** clean mirror as diff base; `expect` from the pre-edit
   row for unknown bases.
6. **S2-2 masters wedge:** `ownsCollectionChange` honors `writePermission`-held
   masters tables. Un-wedges the suppliers-clerk class of roles.
7. **S2-7 tombstones:** `expect`-present + row-missing → 'changed' conflict.

### Phase 2 — close the operator tier and the sync blind spots (~a day) — DONE
8. **S2-3 ride-alongs for everyone:** unscoped callers face the same gates (admins
   exempt); ledger removes/non-insert upserts need the document change; server-stamp
   audit `at`.
9. **S2-4 watermark:** reject/floor future `at`; clamp `fetchSince` and treat a
   future watermark as full-read.
10. **S3-5 forward-jump clamp** rides along with the counter work.

Phase 2 as built, 2026-10-07: the ride-along block in `commitLocked` now runs for
every caller but full admins — the page-narrowing loop stays scoped, and
`ownsCollectionChange`'s day's-work arm admits the open tier (`!pages`) so an
operator's real postings still own their rides. The no-document stock move is
gated on its SHAPE — ledger upserts, no removals, and the audit row a real move
always files (`moveTrail`) — which is what keeps a bare-ledger crafted POST on
the refusal side. Ledger rewrites are closed at the shape gate
(`validateChanges`): insert-only tables carry no `expect`, ever. **Audit `at` is
NOT server-stamped** — a deliberate trade: offline queueing needs past-dated
rows to stay legal, so instead the shape gate refuses an `at` that is
unparseable or future beyond `FUTURE_AT_GRACE_MS` (5 min, the one constant
`zoho.ts` exports and all three `at` gates share), `maxAt` skips such rows when
one is already stored (a hand edit in the Zoho UI can still write one), and
`fetchSince` refuses a future watermark outright so the sweep falls to its full
read — the poison chain dies at write time and at read time both. The
forward-jump clamp (`COUNTER_JUMP_MAX` = stored + 100,000, admins exempt) is
judged with the other permission gates, BEFORE any write lands; the Counters
read it needs moved up beside them and step 5 reuses it.

### Phase 3 — the design decisions (bring to the team, then build) — DONE
11. **S2-6 read-side authorization** on `/api/snapshot`, with the withheld-tables
    protocol so partial snapshots don't read as wipes/never-written, paired with…
12. **S3-1 mirror wipe on signout** for shared devices.
13. **S2-5 cross-instance concurrency + shared budget:** version-column optimistic
    concurrency in Zoho, shared-state budget window (or documented headroom +
    per-session snapshot rate limit + pre-flight read caps as the interim).
14. **S2-8 over-draw reconciliation** report.

Phase 3 as built, 2026-10-07: all four items shipped, with the judgment calls
recorded below. **S2-6** is a per-caller projection (`projectSnapshot` in
`api/_lib/snapshot.ts`) over the shared substrate — the one-`Assembled`-per-revision
cache every caller shares is never narrowed; the route drops the tables a scoped
caller may not read (the 13 page-gated collections plus `audits` on the audit page)
and names them in an explicit `withheld` list, computed from the permission set
alone so it cannot leak which tables hold rows. The client bridges those keys from
its previous view (`restoreWithheld` in `sync.ts`) into the RAW remote state BEFORE
`migrateState`/`installOver` run — an absent key would read as never-written to
seeding and as a wipe to the merge. Masters, ledger, counters and config stay
readable by every signed-in caller (a vendor page's postings need them);
field-level masking of GSTIN/contacts inside masters is deferred to Phase 4. The
warm-gate read was NOT memo-routed through the projection — that would break the
pinned "an older own token still reads as own" contract. **S3-1** is the plain
"Sign out" plus a confirm-guarded "Sign out & wipe" (`signOut({ wipeDevice })` in
`AuthContext`) that calls `clearLocal()` BEFORE the WorkOS signout navigation; the
401/expiry path deliberately never wipes — an expired session on a personal device
must not destroy unsynced work. **S2-5** landed as the documented interim only:
`fetchByKeyIn`'s >10-key `fetchAll` fallback (a criteria-shaped read silently
spending sweep-budget reads) is removed, and `/api/snapshot` carries a per-email
token bucket (6/min sustained, burst 12; `api/_lib/snapshotThrottle.ts`, 429 +
Retry-After). The honest client never meets it (boot ≤2 calls, the poll ~3/min).
The multi-instance exposure — the bucket is per warm instance, and N instances
still share Zoho's global 26/min read window — is the accepted interim Phase 4's
version-column work closes. **S2-8** is client-side detection, not a report:
`overdrawnLots` (in `src/lib/stock.ts`, the same fold the stock view uses, keyed
on the full row identity so a lot split by expiry is two lots) feeds a persistent
amber banner (Layout) and a per-area flag on Storage cards — detect, never block,
since the over-draw already happened by the time any device sees it. NO audit row
is filed for an over-draw: Phase 2's ride-along gates refuse bare audits inserts
by design, and un-refusing them would reopen the forged-trail hole. Gates: 466
tests green (+12), `tsc -b` clean, oxlint at the 10-warning baseline, build whole.
Production runs previous code — a redeploy is needed for any of this to reach
users.

### Phase 4 — the long tail
The remaining S3 items (CSV escaping, POST signout, auth rate limits, admin role
ceilings, audit-before-mutate, env fail-closed, Retry-After, attribution, CI
assertion on Apptics bytes) — plus the masters GSTIN/contacts masking Phase 3's
note deferred here.

**Phase 4 as built, 2026-10-07.** All ten S3 items plus the deferred masking are
in, each pinned by tests (470 green, +4 over Phase 3; `tsc -b` clean, oxlint at
the 10-warning baseline, `npm run build` whole — now ending in the new Apptics
assertion). Judgment calls the build made:

- **S3-2 CSV escaping** (`src/lib/export.ts`): formula prefixes (`= + - @ TAB
  CR`) get a leading apostrophe inside the quoted cell; plain numbers (`-20`)
  stay numeric. Pinned in `export.test.ts`.
- **S3-3 POST-only signout** (`api/auth/signout.ts` + `AuthContext`): non-POST
  now 405s with `Allow: POST`; the client sign-out does a synthetic form POST
  (same-origin, JSON-never parses — the content-type gate's second line).
  Rationale: the session cookie is SameSite=Lax, which rides top-level GETs
  across sites but never cross-site POSTs.
- **S3-10 auth rate limits**: `api/_lib/authThrottle.ts`, 30/min burst 60 per
  IP (token bucket, same shape as the commit/snapshot throttles) on
  `auth/start`, `auth/callback`, `auth/session` and signout, answering
  429 + `Retry-After`. In-memory per warm instance, like the other throttles.
- **S3-11 Retry-After honored client-side** (`src/lib/dbApi.ts`): 429/503 now
  throw `ThrottledError(retryAfterSec)`; the save queue reschedules on it
  instead of its fixed backoff.
- **S3-9 env fail-closed** (`api/_lib/auth.ts`): `WORKOS_ORG_ID` unset refuses
  EVERY session with an error naming the var — loudly locked out beats quietly
  unvalidated (previously the wrong-org refusal AND the membership gate were
  both skipped when the var was missing). **Production env must now carry
  WORKOS_ORG_ID or nobody can sign in — verify it before the next deploy.** A
  session with no org claim still passes (WorkOS omits it in some flows); the
  membership probe is now unconditional in the cookie branch.
- **S3-7 admin role ceilings** (`api/admin/users.ts`, `roles.ts`): actions that
  GRANT or take over access (create, set-roles, reset-link, set-permissions)
  require the union of the involved roles' permissions ⊆ caller's own set —
  `page.admin-users` alone is no longer full-admin equivalence. Reduce-access
  actions (deactivate/remove/delete) are deliberately NOT ceiling-gated: the
  last-admin guard bounds them and removing access is never escalation.
  Reactivate is also ungated (it grants nothing beyond what the member had).
  The flattened session can't say which roles the caller holds, so the ceiling
  compares against the whole permission set — conservative by construction.
- **S3-8 audit before mutate**: every WorkOS mutation is preceded by its audit
  row + revision bump. A failure upstream now leaves an attempt-row (over-
  recording a failed attempt beats an un-recorded landed action), and a Zoho
  lock during the audit write means NOTHING landed — the 503 text says so.
  `writeAdminAudit` costs 2 writes per mutation, so admin.test mocks
  `writesPerMin: 100_000` (a new documented `ClientOpts` test override,
  symmetric to `readsPerMin`; the production 17/min cap stays pinned in
  zoho.test).
- **S3-12 shared-device attribution** (`api/_lib/commit.ts`): the stored audit
  `actor` stays the DRAINING session's email; a well-formed email-like claim
  that differs from the drainer is preserved as `"; queued by <who>"` appended
  to Details. Matching, empty and malformed claims are dropped — the payload's
  claim is not evidence, and Details is not a free-text channel.
- **S3-13 Apptics bytes out of unconfigured builds**: the finding was worse
  than a tripwire gap — the deployed `dist/` carried the SDK chunk with the
  trial's live ids, because `.env.local` (gitignored, dev-only) feeds every
  LOCAL build while the guard (`APPTICS_CONFIGURED`) gated only the calls, not
  the bytes; the workbox precache glob then shipped the orphan chunk. Fixes:
  the facade dynamic-imports the SDK; vite.config `define`s the three
  `VITE_APPTICS_*` ids so the guard folds at build time and marks the module
  `external` in unconfigured builds (rolldown emits dynamic chunks before dead-
  code pruning, so folding alone still emitted an unreferenced chunk); and
  `scripts/assert-no-apptics.mjs` (wired into `npm run build`) fails the build
  if `apptics.zoho.*`/`appticssettings` reach `dist/` in a build no env source
  configured. A configured staging build passes with a note; ASSERT_APPTICS_
  ALLOWED=1 forces the pass. Verified in all three worlds: unconfigured dist
  carries no marker and no chunk; a planted marker fails the build; the
  configured local build still emits and references the SDK chunk.
- **Masters masking (Phase 3's deferral)** (`api/_lib/snapshot.ts`): masters
  stay readable whole-tier, but contacts ride only with the owning page —
  vendors' phone/email need `page.vendors`; customers' gst/phone/email/
  contactPerson need `page.customers` (exactly the fields Vendors.tsx and
  Customers.tsx render; nothing functional consumes them elsewhere). Fields
  are DROPPED from per-caller row copies — never blanked, never named in
  `withheld` (the client must not bridge them back), substrate never narrowed;
  the write gate already demands the same slugs, so a masked caller can never
  round-trip a field they never saw.
- **S2-5 (version-column OCC)** was left OPEN here by decision — the full fix
  needs a live Zoho schema change. Closed after Phase 4, 2026-10-07: see the
  "Phase 5 — S2-5 closed" section below.

Not done, noted: the auth throttle is per-instance (like every throttle here) —
a determined distributed caller rotates instances; the ceiling to beat that is
Vercel WAF/rate limiting at the platform, which is configuration, not code.
Production runs previous code — a redeploy is needed for any of this to reach
users, and the S3-9 fail-closed behavior means WORKOS_ORG_ID must be present in
the production environment BEFORE that redeploy.

### Phase 5 — S2-5 closed: the version-column conditional write (2026-10-07)

The schema window opened the same day, and the whole item shipped: probe, schema,
code, tests. The production base was modified too, additively (authorized: "for
production db also it shoud be done"); every row-writing probe ran against the
scratch base only.

**The probe came first, because the design lives or dies on the criteria grammar**
(`scripts/zoho/probe-version.mjs`, full wire log in
`docs/zoho-version-probe-results.md`, scratch base, 2026-10-07):

- The criteria grammar is single-condition text equality, nothing else. Every
  AND shape — plain and parenthesized — answers HTTP 200 wrapping
  `INTERNAL SERVER ERROR`, on `fetchRecordsWithCriteria` and on `PUT /records`
  both. A "version AND key" conditional write is impossible on this API.
- A colon inside a quoted criteria value is safe (`"FVER" = "VEN-1:5"` matches).
- `is_upsert_needed: false` is honored: a match answers
  `records.updated:[{…}]`; a no-match answers HTTP 200
  `records.updated:[]` — nothing written, no error. That empty array is the
  machine-readable conflict signal.
- `is_upsert_needed: true` against a non-matching criteria CREATES A DUPLICATE
  ROW (pinned live). The conditional write can never fall back to the upsert
  shape — update-only or nothing.

**The schema**: a `Version` column (single-line text, field type 23) on the 21
editable tables of BOTH bases — scratch `dhorj90a…` and production `gerc53f…`
— added by `scripts/zoho/add-version-columns.mjs` (skip-if-exists, additive;
no row was touched). Both topup state files re-synced and `api/_lib/baseSchema.ts`
regenerated with every table's `Version` field id. Skipped by design: Vendor
Types + Order Lines (not client-writable), Sticker Prints (immutable), Ledger +
Audit Log (insert-only — history has no versions), Config (`app_revision` is its
OCC), Counters (COUNTER_JUMP_MAX + period gates are its concurrency control).

**The write path** (`api/_lib/zoho.ts`, `api/_lib/commit.ts`): the token is
`<AppID>:<n>` — row identity rides INSIDE the token value because AND is dead,
and the strict parse (`startsWith(appId + ':')` + digits-only tail) keeps the
criteria unambiguous even across keys containing colons. `upsertByKey`'s
optional `cas` turns the write into one text equality on the Version field with
`is_upsert_needed: false`; an empty `records.updated` throws
`ZohoCasConflictError` (an unrecognized success body reads the same way — the
only safe answer to "did my write land?" is no), which `commitChanges` maps to
the same 409 `kind: 'changed'` the `expect` pre-flight produces, so the
client's adoption path needs no new shape. A CAS token carrying a quote is
refused client-side like any key value.

**Lazy migration, no backfill**: a legacy row (empty token — every existing row
of both bases), a malformed token, or a foreign one (a hand edit in the Zoho UI)
keeps today's unconditional keyed upsert and stamps its first token `:1`;
inserts do the same. Only rows already carrying their own strict token are
written conditionally. The client protocol never changes, and the read path
never sees the Version column (`rowToDoc` reads App ID + Data JSON only) —
snapshots and clients are untouched.

**The fixup chose defer over fail**: the 4b same-commit link fixup re-sends the
whole row, so a fixup over a row another instance moved would clobber the
winner — the exact destruction the conditional write exists to prevent. Its CAS
gates on the token THIS commit just stamped; on `ZohoCasConflictError` it skips
(one `console.warn`, links complete on that row's next save) instead of failing
the commit. A conflict inside the section-4 loop still refuses the commit whole
— the same recoverable pause a mid-commit lock always was, healed by the retry's
`jsonEq` idempotence skip.

**Residual races, documented**: the legacy first-edit race (two instances
editing the same never-versioned row) and the insert race (two devices minting
one new key) are exactly today's behavior, unchanged — the first writer stamps,
and every edit after that is conditional, so each row converges to protected
on its first save. The pre-flight `expect` check still stands as the first
line; the CAS is the second, spanning instances.

**What is NOT closed**: the budget window remains per-instance (the accepted
Phase 3 interim) — N warm instances still share Zoho's global 26/min read
window; the per-email snapshot throttle, the pre-flight shape caps and the
cold/warm burst pacing carry that exposure, and a shared-state window stays a
separate ops decision.

Gates: 480 tests green across 43 files — the S2-5 pins are the three wire pins
in `zoho.test.ts` (the conditional-write shape, the empty-`updated` conflict
signal, the quote refusal) and the four commit pins in `commit.test.ts` (the
two-instance interleave refusal, the versioned write-through,
legacy/insert lazy-migration stamps, the fixup-skip); `tsc -b` clean,
`npm run build` whole, oxlint at the 10-warning baseline. Production runs
previous code until the next deploy — and WORKOS_ORG_ID must be in the
production env BEFORE that redeploy (S3-9 fail-closed).

---

## Verified sound (no action)

Sealed iron-webcrypto sessions with PKCE + state cookies; org/membership checks;
open-redirect and injection guards on `?return=`; uniform auth errors; constant-time
state compare; criteria injection refused at every Zoho query builder
(`fetchSince`/`fetchByKeyIn`/`upsertByKey` reject quotes/backslashes; payloads travel
JSON-stringified); prototype pollution (own-properties only, regex-gated counter
keys); fail-closed table permissions including `vendor_types`/`order_lines`;
config per-key gates with union-of-keys semantics; `app_revision` writable only by
the server's `bumpRevision`; audits insert-only with session-stamped `actor`; no
`dangerouslySetInnerHTML`/`innerHTML`/`eval` sinks in `src/`; PWA precaches static
assets only with `/api/` on the navigate-fallback denylist; uploads are blob-URL,
MIME-allowlisted and size-capped; no credentials in localStorage/IndexedDB; no
secrets in git history; ops scripts behind typed `--production` hatches; chunker
boundary arithmetic and idempotent-retry semantics hold under the tests that pin
them.
