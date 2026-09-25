# Auth Provider Decision Report — WorkOS AuthKit

**Date:** 2026-09-24
**Status:** Decision — adopt WorkOS AuthKit
**Scope:** Authentication, user management, roles & permissions for ProductionDashboard (Roligt Foods ops platform)

---

## 1. Decision

**WorkOS AuthKit is selected as the auth provider for ProductionDashboard.**

It is the only evaluated option that satisfies all four product requirements on a free tier, with no added infrastructure, and with an API surface complete enough to run *all* user/role/permission management from inside our own application dashboard.

---

## 2. Requirements (the use case)

Stated by the product owner:

| # | Requirement |
|---|---|
| R1 | Create **more than two roles** — admins must be able to define new roles at runtime |
| R2 | **Permissions** must be assignable to roles |
| R3 | **Users** must be addable and manageable |
| R4 | All of the above must be manageable **through our application's dashboard** (via APIs), not only through the provider's dashboard |

Constraints derived from the existing architecture (not negotiable without rework):

| # | Constraint |
|---|---|
| C1 | No new infrastructure — the stack is a Vite React SPA + Vercel serverless BFF + Zoho Tables; there is **no SQL database** and no long-running server |
| C2 | Free or near-free pricing (internal plant tool, ~20–50 users) |
| C3 | Token format verifiable by the BFF with `jose`/JWKS (the existing `api/_lib/auth` pattern) |
| C4 | Usable from India — sensible data region, no provider-side cold starts |
| C5 | Production maturity — this system runs a food plant's procurement, production, QC, and traceability |

---

## 3. Candidates evaluated

Kinde (Free and Pro), Logto (Cloud and self-hosted OSS), Better Auth, Hexclave, SuperTokens (Cloud and self-hosted), Hanko, Auth.js (NextAuth), Authorizer, WorkOS AuthKit.

---

## 4. Evaluation matrix

| Provider | R1: >2 roles | R2: permissions | R3: users | R4: manage via our app | C2: free | C1: no new infra | Verdict |
|---|---|---|---|---|---|---|---|
| **WorkOS AuthKit** | ✅ unlimited custom roles | ✅ permission slugs → roles | ✅ Mgmt API | ✅ full Mgmt/Authorization API | ✅ free to 1M MAU | ✅ hosted | **Selected** |
| Kinde Free | ❌ **2 roles / 10 permissions** | ✅ | ✅ | ✅ Mgmt API | ✅ | ✅ | Fails R1 outright |
| Kinde Pro ($25/mo) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | Viable paid fallback |
| Logto Cloud Free | ❌ RBAC = $32/mo add-on (needs ~$56/mo total) | ⚠️ paid | ✅ | ✅ | ❌ | ✅ | RBAC gated; costs more than Kinde Pro |
| Logto OSS self-host | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ needs Node + Postgres host | Ops burden rejected (C1, C5) |
| Better Auth | ❌ role *catalog is code*, not data | ⚠️ code-defined | ✅ | ⚠️ assignment only, not creation | ✅ | ❌ needs SQL DB | Fails R1/R4 as stated |
| Hexclave | ✅ | ✅ | ✅ | ✅ REST API | ✅ 10k users | ✅ | Rejected on maturity (C5) |
| SuperTokens Cloud | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ 5k MAU | ✅ | Weaker fit, smaller free tier |
| Hanko | ❌ passkey-specialist scope | ❌ | ⚠️ | ⚠️ | ✅ 10k MAU | ✅ | Narrow; fails breadth |
| Auth.js | ❌ no role model | ❌ | ❌ no mgmt API/dashboard | ❌ | ✅ | ⚠️ Next.js-centric | Fails R2–R4 |
| Authorizer | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ self-host + DB | Ops burden rejected (C1) |

---

## 5. Why each alternative was rejected

**Kinde (current integration, Free plan).** The free plan caps at **2 custom roles / 10 permissions**, which fails R1 (the stated reason for moving). Users and roles *can* be managed via Kinde's Management API (free, client-credentials M2M), so R4 was satisfiable — but only with roles moved out of the provider into our own Zoho Tables data model (app-owned RBAC). That workaround is sound engineering, but it means building and maintaining an entire authorization subsystem ourselves. Raising to Kinde Pro ($25/mo) unlocks unlimited roles but still costs money for what WorkOS provides free.

**Logto Cloud.** Architecturally excellent (standard OIDC, JWT access tokens for API resources, verified `jose`-compatible). However, the free tier **does not include RBAC** — roles/permissions are a **$32/month add-on on top of the Pro base (~$56/mo total)**, and custom JWT claims (roles inside tokens) are Pro-only. That is more expensive than Kinde Pro for the same capability. The "RBAC free" reputation comes from the self-hosted edition.

**Logto OSS / Authorizer (self-hosted).** Unlimited RBAC for $0 in software cost, but both require running a Node service + PostgreSQL alongside our Vercel-only deployment — a second hosting bill, cold starts on a free host, backups, upgrades, and a database to operate (violates C1). Wrong trade for a two-developer team.

**Better Auth.** A first-class TypeScript library (MIT) with an admin plugin — user creation, ban, impersonation, role-based access. Decisive flaw for R1/R4: **the role and permission catalog is defined in application code**, with no API for an admin to create new roles at runtime (adding a role requires a deploy; confirmed by community discussions). Dynamic *assignment* exists; dynamic *creation* does not. It also requires a SQL database (violates C1) and makes us our own IdP — password flows, reset emails, brute-force protection, security patching (weakens C5). Its strength is total self-ownership, which is not our requirement.

**Hexclave.** Surprisingly strong technical fit: React SDK, ES256 JWTs with a public JWKS endpoint (drops into our `jose` verification), REST management API with near-full SDK parity, RBAC with project/team scopes, free to 10k users. Hexclave is the rebranded **Stack Auth** (YC S24, founded 2024, ~7 employees) — the rename coincided with a scope expansion from auth into a "user infrastructure platform" (payments, emails, analytics, session replay). Rejected on maturity/risk (C5): a ~2-year-old, 7-person company mid-repositioning; thin documentation (REST endpoints for user/role management and self-hosting undocumented despite the open-source repo); no verifiable compliance certifications (enterprise HIPAA/SOC 2 offered as contracts, not audits); no documented data-region choice (single `api.hexclave.com` endpoint); near-zero third-party reviews or community troubleshooting depth. Not yet a safe foundation for a production food-plant system; revisit in 6–12 months.

**SuperTokens / Hanko / Auth.js.** SuperTokens' managed free tier (5k MAU) is smaller than alternatives with no compensating advantage; self-hosting has the same infra problem as Logto OSS. Hanko is deliberately passkey/passwordless-specialized — too narrow for full user/role/permission administration. Auth.js has no management API, no admin dashboard, and is Next.js-centric while our app is a Vite SPA.

---

## 6. Why WorkOS AuthKit satisfies the use case

**R1 — more than two roles.** Unlimited custom roles, created via dashboard *or* API, on the free tier. A non-deletable `member` role is seeded by default; any role can be the default. Multiple roles per user is supported but **disabled by default** — we will enable it during setup. (No published numeric cap on roles or permissions-per-role exists; the only physical bound is the ~4KB session cookie, addressed in §8.)

**R2 — permissions.** Permissions are immutable string slugs (e.g. `quality.release`, `masters.edit`), attachable to any number of roles via the Authorization APIs. Role changes propagate into new session tokens at next sign-in/refresh.

**R3 — users.** The User Management API supports creating users, invitations, deactivation, and password/email flows.

**R4 — manage everything from *our* dashboard.** This is the decisive requirement, and WorkOS passes it natively: the Management/Authorization APIs cover users, roles, permissions, and assignments, so our admin screens (Users, Roles & permission matrix, Assignments) call the BFF, which holds an M2M API key — the plant admin never sees the WorkOS dashboard. Roles/permissions ride inside the access-token claims, so **enforcement needs zero per-request WorkOS calls**.

**Supporting evidence gathered during evaluation:**

- **Free tier:** User Management (AuthKit) free up to **1M MAU**; RBAC included at no cost. Paid items are enterprise features we do not need (SSO $125/mo/connection, Directory Sync, Audit Logs).
- **Architecture fit (C1, C3):** AuthKit's session model is a **sealed encrypted cookie + JWT access token + refresh token**, with WorkOS itself recommending a thin BFF for SPAs — which we already run. Verification is standard JWT/JWKS via `jose`, the same pattern as our existing auth guard. No database required.
- **Rate limits (verified):** 6,000 req/60s per API key overall; AuthKit reads 1,000/10s and writes 500/10s per environment; `/authenticate` 10/60s per email. At our scale these are unreachable by three orders of magnitude; the only tight limits are anti-abuse controls on login endpoints. 429s return `Retry-After`; our existing `ThrottledError` retry pattern covers this.
- **Latency & cold starts (C4):** WorkOS's API is always-on regional infrastructure (no provider-side cold starts); the hosted login page is CDN-served. Post-login requests never touch WorkOS (local unseal + cached-JWKS verification; server-side refresh every few minutes). We will pair a **EU WorkOS region (`api.eu.workos.com`)** with a **`fra1` Vercel function region** for the best India latency (~130ms browser→BFF). The only cold start in the system is our own Vercel functions, already mitigated by the localStorage mirror + revision fast-path.
- **Maturity (C5):** WorkOS is an established, well-funded company; AuthKit is its mainstream product (SOC 2 posture, widely deployed).

---

## 7. Cost summary

| Item | WorkOS AuthKit |
|---|---|
| Up to 1M MAU | $0 |
| RBAC (roles + permissions) | $0 |
| Management API usage | $0 (within rate limits) |
| We would only ever pay for | Enterprise SSO ($125/mo/conn), SCIM, Audit Logs — none required for an internal tool |

Every rejected alternative either failed a hard requirement (Kinde Free, Better Auth, Auth.js), charged for the same capability (Logto Cloud ~$56/mo, Kinde Pro $25/mo), or demanded infrastructure we don't run (Logto OSS, Authorizer, Better Auth).

---

## 8. Known limitations & mitigations

| Limitation | Mitigation |
|---|---|
| Roles/permission slugs live in session JWT claims; browser cookies cap at ~4KB | Model permissions as real capabilities (a few dozen: `quality.release`, `stock.move`, …), not per-button flags |
| Multiple roles per user disabled by default | Enable in Authorization configuration during initial setup |
| Short-lived access tokens refresh server-side every few minutes | One BFF→WorkOS EU round trip (~20–50ms with fra1 pairing); imperceptible |
| Invite emails via WorkOS's shared sender have anti-abuse limits | Acceptable internally; connect own email provider later if deliverability matters |
| Vendor lock-in for auth config | Standard OIDC/JWT patterns throughout; swapping providers later touches only the auth adapter |

---

## 9. Integration outline (next steps)

1. **Provision** WorkOS account in the **EU region**; enable **multiple roles per user**; create M2M API key for the BFF; note the JWKS endpoint for `jose`.
2. **BFF**: add AuthKit callback + sealed-session handling; replace Kinde token verification with WorkOS JWKS verification (`api/_lib/auth`); add `api/_lib/workosAdmin.ts` (M2M client for user/role/permission management).
3. **Swap SPA auth wiring**: `KindeProvider` → AuthKit flow (`src/main.tsx`, `src/lib/kindeSession.ts` → workos session), keeping the existing "run standalone in dev" mode.
4. **Permission catalog in code, roles as data**: define permission slugs alongside the features that enforce them; admins create roles (bundles of known permissions) at runtime — safe by construction.
5. **Admin screens**: Users (add/invite/deactivate + role assignment), Roles (create/edit, permission matrix), all via BFF endpoints; extend the app's audit trail to log administrative actions.
6. **Snapshot/commit**: include the signed-in user's effective permissions in the snapshot payload so UI gating (`AdminOnly` → permission-keyed) needs no extra fetches.
7. **Regions**: set Vercel function region to `fra1`; keep WorkOS EU.

Estimated effort: ~4–6 working days including the admin screens and migration off the current Kinde wiring (user count is currently zero — the cheapest possible moment to switch).

---

## 10. Sources

- WorkOS pricing & free tier: https://workos.com (AuthKit free to 1M MAU; RBAC included)
- WorkOS API rate limits: https://workos.com/docs/reference/rate-limits
- WorkOS RBAC configuration (multiple-roles default, `member` seed role, cookie size): https://workos.com/docs/user-management/roles/configuration
- WorkOS AuthKit sessions (sealed cookie, JWT access token): https://workos.com
- Kinde pricing (2 roles / 10 permissions on Free; Pro $25/mo): https://kinde.com/pricing
- Logto pricing (RBAC $32/mo add-on; free 50k MAU): https://logto.io/pricing
- Better Auth admin plugin & runtime role-creation limitation: https://better-auth.com , https://www.answeroverflow.com
- Hexclave docs & pricing: https://docs.hexclave.com , https://www.hexclave.com/pricing
- 7 open-source Clerk alternatives (background on Logto OSS/Better Auth/Auth.js/SuperTokens/Hanko/Authorizer): https://dev.to/haneem/i-tested-7-open-source-clerk-alternatives-for-full-stack-developers-3d4c
