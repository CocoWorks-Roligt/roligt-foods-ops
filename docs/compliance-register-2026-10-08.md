# Compliance register — licence PDFs, expiry dates, one reminder email

**Date:** 2026-10-08
**Status:** Code-complete and green (546 tests, `tsc -b` clean, build + PWA whole, oxlint at baseline, live scratch smoke of the documents route passed). **Not yet live**: the setup steps in §7 are the remaining work. Resend + Vercel Blob were built first and replaced on 2026-10-08 per founder decision — sending is the plant's own **Zoho Mail SMTP**, storage is **Cloudflare R2**.
**Scope:** A Compliance page (masters-tier, tick on roles) holding the plant's licences/permits/certificates: upload the PDF, record the expiry, and receive one email reminder per document when the expiry nears. Recipients are per-document; the lead window is configurable in Settings.
**Audience:** Naresh (remaining setup + deploy), any future session touching the compliance code (§3's guards are load-bearing).

---

## 1. What this is and why

The plant has no system of record for its licences and permits — nothing warns anyone before one lapses. The register gives that one line of defence two halves: the documents live somewhere durable and findable (the app, with the actual PDF), and each expiry date has an owner who hears about it in advance (one email, at a configurable lead, to the address(es) on the document itself).

## 2. Decisions (all locked)

| Decision | Choice | Why |
|---|---|---|
| Data home | **Standalone Zoho `Compliance Documents` table**, NOT a synced collection, NOT in `TABLE_FOR` | The snapshot sweep is exactly 26 reads and the quiet-burst admission math depends on that count (snapshot.test.ts pins it; a 27th swept table re-breaks the 2026-10-07 warm re-sweep incident). `/api/compliance/*` reads the table on demand — the standalone-route shape the Books plan documented first. |
| Page access | **Masters-tier catalog row** (`page.compliance`) | Ticked-roles only: admins compose who sees it at runtime on the Roles screen; floor operators never do. |
| Page style | **Online page** (admin-screen idiom: `complianceApi.ts` fetch client, no domain hook, no offline queue) | The PDF upload needs the network anyway; offline editing of compliance rows has no value. The PWA precaches the lazy chunk regardless. |
| Reminders | **One email per expiry**, fired when the document comes inside the lead window (default 30 days, `complianceLeadDays` in Settings); past-expiry-never-reminded still gets one catch-up "Expired" email | Founder choice. No escalation, no repeats. |
| Re-arm | `reminderSentFor = expiresOn` at send time; due requires `reminderSentFor !== expiresOn` | Renewal changes the expiry, the marker stops matching, the next cycle reminds again — no reset step anyone can forget. |
| Recipients | **Per-document `remindEmails[]`**, required whenever `expiresOn` is set | A document with a deadline always has somewhere to send its warning; each licence's owner is whoever cares about it. |
| Sending | **Zoho Mail SMTP via nodemailer** (`api/_lib/mailer.ts`) | Same mail system as the recipients — the documented spam-foldering (workosAdmin.ts:158) was external senders (WorkOS). WorkOS itself cannot send app mail at all (auth-flow mail only). Requires a Zoho Mail plan with SMTP (the free plan has none) + an app password. |
| File storage | **Private Cloudflare R2 bucket** (`api/_lib/r2.ts`, hand-rolled S3 SigV4 presigner — no SDK) | Founder choice; free tier (10 GB, 1M writes/10M reads/month, zero egress) far exceeds need. Keeps documents outside the Vercel account. |
| Upload path | Route picks the key, mints a **presigned PUT** (content-type signed, 5 min); browser PUTs straight to R2 | Vercel's ~4.5 MB request-body cap never sees a file; R2 itself refuses a claim to any content type the route did not allow. |
| Downloads | Permission gate + `compliance/` prefix guard → **302 to a 120 s presigned GET** with attachment disposition | The check stays server-side; the URL is worthless minutes later. |
| Concurrency | Same `<AppID>:<n>` **Version CAS** as commits (`versionPlan` shared from commit.ts); client sends `baseVersion` | A stale edit gets the commit route's own 409 'changed' shape; retried identical saves are no-ops. |
| Scheduling | **Vercel cron** (`vercel.json`, the repo's first): daily 03:30 UTC = 09:00 IST → `/api/compliance/remind`, guarded by `CRON_SECRET` (Vercel auto-sends `Authorization: Bearer <CRON_SECRET>`) | Daily is enough at a 30-day lead; the timing-safe bearer check is the whole auth (no session). Manual curl with the same header is the smoke test. |
| Audit | Every mutation files an Audit Log row + bumps the revision (`writeAdminAudit`); the cron writes one summary row only when something was sent | The register's changes reach every client's Audit page on the next poll, same as admin actions. |

## 3. Guards the next session must not undo

- **Never add the table to `COLLECTIONS`/`TABLE_FOR`** — the sweep must stay 26 reads.
- **Never add a Zoho attachment column** to it — a string in one makes Zoho silently drop every later field in an upsert (mappers.ts). The PDF bytes live in R2; the doc carries the object key.
- **The upload route names the object key**, never the client — that is what keeps the download route's `compliance/` prefix guard meaningful.
- `isAdminPermissions` is catalog-complete (`PERMISSIONS.every`) — **every catalog growth must re-run seed-rbac before the deploy lands**, or every full admin silently stops being an admin (see §8).

## 4. Files

New: `src/lib/complianceRules.ts` (isomorphic rules + validation + due/email copy), `src/lib/complianceApi.ts`, `src/pages/Compliance.tsx`, `api/_lib/compliance.ts`, `api/_lib/mailer.ts`, `api/_lib/r2.ts`, `api/compliance/{documents,upload,file,remind}.ts`, tests `src/lib/complianceRules.test.ts`, `api/_lib/{compliance,complianceRoutes,r2}.test.ts`.
Touched: `src/types.ts` (ViewId + `Config.complianceLeadDays`), `src/lib/pages.ts` (catalog row 27; pages.test pin 26→27), `src/lib/utils.ts` (PAGES), `src/App.tsx` (route), `src/pages/Settings.tsx` (lead-days field), `api/_lib/commit.ts` (export `versionPlan`; `CONFIG_NUMBER_KEYS` += `complianceLeadDays`), `scripts/zoho/topup.mjs` (§2b table block — already run against **scratch**), `api/_lib/baseSchema.ts` (regenerated; production base gains the table only after §7 step 5), `scripts/dev-server.mjs` (4 routes), `scripts/vercel/sync-env.mjs`, `.env.example`, `vercel.json` (crons), `package.json` (+nodemailer; −@vercel/blob).

## 5. Environment

| Name | Source | Notes |
|---|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Zoho Mail | `smtp.zoho.in` (India DC), 587 STARTTLS default (465 = implicit TLS); password is an **app-specific password**. Plan must include SMTP access. |
| `MAIL_FROM` / `MAIL_REPLY_TO` | optional | Display from / reply target. |
| `R2_ACCOUNT_ID` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2 | Private bucket; token scoped **Object Read & Write** to that bucket. |
| `CRON_SECRET` | `openssl rand -hex 32` | `vercel env add` production + preview, and `.env`. |

Absent SMTP/R2 values make those routes answer 503 — the rest of the app is unaffected. No `VITE_` prefixes anywhere.

## 6. Verification already done

`npm test` 546 green (due/renewal matrix, validation, route gates, 409 paths, send-then-mark ordering, presigner determinism/encoding); `tsc -b` clean; build + PWA whole; oxlint at the 10-warning baseline; **live scratch smoke**: save → `CMP-SMOKE-1:1` → idempotent retry (no second write) → stale `baseVersion` → 409 → remove → clean; cron refuses open without `CRON_SECRET`.

## 7. Remaining to implement (in this order — every step before the push is safe to run now)

1. **Re-seed RBAC** (closes the admin window, §8): `npx tsx scripts/workos/seed-rbac.mjs` — creates `page.compliance` in WorkOS and reconciles `app-admin` to all 27 slugs. Admin sessions pick it up within a poll cycle.
2. **CRON_SECRET**: `openssl rand -hex 32` → `vercel env add CRON_SECRET production` + `preview`, same value into `.env` (else the cron 500s daily once deployed — fail-closed, noisy, harmless).
3. **Zoho Mail**: confirm the plan has SMTP access → create an app password → set `SMTP_HOST/SMTP_USER/SMTP_PASS` (+`MAIL_FROM`) in `.env`/Vercel. Send one test mail to a plant inbox.
4. **Cloudflare R2**: create private bucket `coco` (shared since 2026-10-09 with the QC lab reports and proof-of-delivery photos — compliance files live under `compliance/`, record attachments under `attachments/qc/` and `attachments/pod/`; one bucket, one token, one CORS rule); create an Object Read & Write API token scoped to it; note the account id from the S3 endpoint; set the four `R2_*` values (`R2_BUCKET=coco`). Bucket → Settings → CORS policy (add every origin the app is served from — `GET` is for the attachments, which the app fetches through the download route's redirect and opens itself):
   ```json
   [
     {
       "AllowedOrigins": ["https://roligt-foods-ops.vercel.app", "http://localhost:3000"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
5. **Production base**: `node scripts/zoho/topup.mjs gerc53fe9f1e44e5f4a13809d9bd47367ba9d --production gerc53fe9f1e44e5f4a13809d9bd47367ba9d` — creates the table; commit the regenerated `api/_lib/baseSchema.ts` with the feature.
6. **Env sync + push**: `node scripts/vercel/sync-env.mjs production --production production` (new keys are in `OPTIONAL_KEYS`; `CRON_SECRET` in `BFF_KEYS`), then commit + push — the push deploys.
7. **Grant + smoke**: tick `page.compliance` onto a role on the Roles screen (admins can grant it now — they hold it); as that operator: add a document with a real PDF → list shows it → the file link opens it (**first live R2 PUT/GET — the presigner's final proof**); then force a due one (expiry inside the window) and `curl -H "Authorization: Bearer $CRON_SECRET" https://roligt-foods-ops.vercel.app/api/compliance/remind` → email arrives, `reminderSentFor` set, second call sends nothing, one audit row lands. The automatic cron fires 09:00 IST the next day.
8. **Attachments smoke** (same R2 setup, no extra step): on Quality, attach a PDF to a test row → toast says it uploads automatically → DevTools → IndexedDB `roligt-ops-attachments` / `outbox` empties within seconds → open the row from a second browser profile (fetched through `/api/attachments/file`). Then DevTools offline → attach a delivery photo on Dispatch → it opens locally and the outbox holds it → back online → the outbox empties. Before R2 is set, the outbox simply waits (503 counts against no file) and every file still opens on the device that added it.

## 8. Push safety (asked 2026-10-08: "if we push this now, will it break anything?")

Pushed **as-is, alone**: existing users' daily work is unaffected — the page is invisible (nobody holds the slug), no existing code path reads the new modules, and the Zoho/commit engines' changes are additive (`versionPlan` export, one config-number key). But three hazards, two of them real:

1. **Every full admin silently stops being "admin"** — `isAdminPermissions` requires the whole catalog, now 27 slugs; existing roles hold 26. The commit engine's admin skips (counter-vault ceiling, scoped-gate bypass) and the client's role derivation then treat admins as scoped operators until the role gains the slug — and the Roles screen's ceiling **blocks** granting a permission the caller lacks, so only `seed-rbac` (or the WorkOS dashboard) can fix it. **Run §7 step 1 before pushing and there is no window at all.** Custom hand-built "full-catalog" roles beyond `app-admin` would still need the slug ticked once.
2. **The cron 500s daily** until `CRON_SECRET` exists — fail-closed by design (§7 step 2), noisy in logs/emails, breaks nothing.
3. **The Compliance page 500s for anyone granted it before §7 step 5** — `docTable()` throws because the production base lacks the table. Nobody is granted it before step 7, so this window only exists if the order is inverted deliberately.

The safe order is §7's: everything through step 5 can run **before** the push, which makes the deploy itself a no-op for every existing user except the new page appearing for whoever gets ticked afterwards.

## 9. Limits & notes

- Daily cron ⇒ a reminder can land up to ~24 h after entering the window — noise at a 30-day default lead.
- Orphan blobs (an abandoned modal after upload, a removed document) are left in R2 by design — trivial cost, honest references. The same holds for record attachments (a QC test re-attached, a dispatch photo removed before save).
- Record attachments (`api/attachments/*`) invert this feature's key rule on purpose: the device mints `attachments/<qc|pod>/…` so a record saved offline already carries its key; the routes refuse anything outside that grammar and any area the caller's page permission does not cover (`page.quality` / `page.dispatch`).
- The reminder's wording lives in `complianceRules.ts` (`reminderSubject`/`reminderHtml`), escaped; the resend path marks only after the SMTP send resolves, so a refused send retries next run, and a CAS race on the mark (a concurrent human edit) defers to the edit and re-evaluates tomorrow.
- Free-tier posture: Zoho SMTP within any plan's daily cap at this volume; R2 free tier (10 GB / 1M writes / 10M reads per month, zero egress) — both far beyond a licence register's needs.
