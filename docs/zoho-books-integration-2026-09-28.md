# Zoho Books integration — invoices & bills from the ops dashboard

**Date:** 2026-09-28
**Status:** Plan, decisions locked 2026-09-29 (researched against the official Zoho Books API v3 docs, verified 2026-09-28; nothing implemented yet)
**Scope:** Push contacts, items, sales invoices and purchase bills from ProductionDashboard into Zoho Books (India DC), and read payment status back for the documents we pushed. Sandbox Books org for dev/staging, live org for production.
**Audience:** Naresh (implementation), founder/accountant (remaining confirmations in §12).

**Decided 2026-09-29 (founder answers to the open questions):** sell price is **fixed on the recipe** — one price per product, billed on invoices *and* printed on labels (MRP retires); **HSN is asked at recipe creation, one code per recipe** (same across pack sizes), with plain **Tender Coconut Water and Coconut Malai modelled as recipes too**, so every sellable shares one schema and new melanges change nothing; **GST is 5%** (2.5% CGST + 2.5% SGST intra-state — Books applies 5% IGST automatically for out-of-state customers, same total); **transport rides as its own labelled line on bills, never on invoices**; farmer contacts carry **no GST**; pushed documents are **tagged in Books** and their **status syncs back** (two-way = writes out, statuses in; documents created by hand in Books are never imported into ops); Books plan is **Premium (10,000 calls/day)**; **dev/preview → sandbox Books org, production → live org**; **one challan = one customer = one invoice** confirmed.

---

## 1. What this is and why

Today the office does the same work twice. A vendor or customer is entered in the dashboard, then re-typed into Zoho Books. A delivery leaves on a challan, then someone opens Books and hand-builds the invoice — customer, product lines, quantities, rates. The Books entry is slow, duplicates data the dashboard already holds as its source of truth, and drifts when it is done from memory.

The integration makes the dashboard the place the document is *created* and Books the place it is *accounted*: one push per challan creates a **draft** sales invoice in Books with every line already on it; one push per GRN creates the purchase bill with the landed cost already computed. The office reviews in Books and marks sent — Books keeps everything that must stay in Books (GST series numbering, tax computation, e-invoicing/IRN, payments, aging).

Verified 2026-09-28 by grep: the codebase has zero existing Books groundwork (`invoice`, `hsn`, `books` as a product reference — no hits in `src/` or `api/`). The only GST-adjacent field is `Customer.gst` (src/types.ts:185-195), already surfaced in the Customers UI and already a column in the Zoho Tables Customers table.

## 2. How the integration is shaped (the decisions)

| Decision | Choice | Why |
|---|---|---|
| Sync direction | **One-way, dashboard → Books** | The dashboard is the ops system of record (masters, stock, documents); Books is the accounting system of record (statutory documents, tax, payments). Two-way sync of masters buys conflict-handling for nothing we need. |
| Trigger | **Explicit push, not automatic** | A button on the record ("Create invoice in Books"), admin-gated. Automatic pushes would create statutory documents as a side-effect of plant-floor actions — the office must stay in the loop. |
| Document state | **Draft-first in Books** | `POST /invoices` creates as `draft` natively (office marks sent in Books). Bills have no draft status — they arrive `open`; the gate there is Books' submit/approve if wanted. |
| Invoice granularity | **One invoice per challan** | A Dispatch row is one stock line (src/types.ts:749-774); the challan (`DC0001/2026`) is the document that groups them and is already what the customer knows. Invariant enforced at push: all rows of a challan must name one customer. |
| Invoice numbering | **Books auto-numbering, never custom** | `invoice_number` left empty lets Books mint from its GST-compliant series; our `ignore_auto_number_generation` flag stays untouched. We store the returned number. Bills are the mirror: Books requires `bill_number` and offers no auto-series — the GRN id (`RFTC20260001`) becomes it, passed as data (never parsed back off a code). |
| Idempotency | **Three layers** | (1) A unique Books custom field carries our key (`cf_ops_id` = `CUS-00001` / `VEN-00001` / `FG-00001`; `cf_challan` = `DC0001/2026`) and every push uses the `PUT` + `X-Unique-Identifier-Key`/`X-Unique-Identifier-Value`/`X-Upsert: true` form — a retried push updates, never duplicates. (2) The stored `booksInvoiceId`/`booksBillId` short-circuits a re-push. (3) The push route re-reads the rows before creating (same pre-flight discipline as `commitChanges`). |
| Tax computation | **Lives in Books, not in the payload** | Items are synced with `hsn_or_sac` + `item_tax_preferences` (intra/inter `tax_id`), contacts with `place_of_contact`; Books then computes CGST/SGST/IGST from `place_of_supply` on its own. Our invoice lines carry only `item_id`, `rate`, `quantity`. The dashboard never encodes a tax rate. |
| Sell rate | **Fixed on the recipe** | One `price` per product in the dashboard master — invoices bill it and labels print it (it replaces MRP). No per-customer rates, no push-time dialog. |
| Books ↔ dashboard | **Writes out, statuses in** | Masters/invoices/bills push out, tagged "Ops Dashboard"; a scheduled sync-back pulls sent/paid/overdue for exactly the docs we pushed, keyed on our stored Books ids. Hand-created Books documents are never imported into ops. |
| Auth | **Self Client (first-party), refresh token in env** | The app and the Zoho org are managed by the same people; no browser redirect flow, no user-facing consent. Refresh token does not expire until revoked and does not rotate on refresh (verified, §4). |
| Budgets | **Books client gets its own looser budget; Budget(26) untouched** | Books allows 100 req/min/org and 2,000–10,000/day by plan. Reads/writes to Books never touch the Zoho Tables Budget(26); only the write-back of ids into Tables counts there (a handful of row-writes per push, inside the existing 17/min write budget). |

**Explicitly out of scope for v1:** credit notes (returns/rejections), vendor payments, e-way bills (no API exists — UI-only in Books), IRN push (Books does it in-product, §11), and any two-way master sync. Status sync-back is committed and lands in Phase 5 (§9).

## 3. The Books API surface we use (India DC)

Base `https://www.zohoapis.in/books/v3` (the old `books.zoho.in/api/v3` domain is dead since June 2024), `organization_id` query param on every call, header `Authorization: Zoho-oauthtoken <access_token>` (that exact form — not `Bearer`).

| Module | Endpoints | Load-bearing fields (verbatim from docs) |
|---|---|---|
| OAuth | `POST https://accounts.zoho.in/oauth/v2/token` | `grant_type=authorization_code` / `refresh_token`; response `access_token`, `refresh_token`, `expires_in: 3600` |
| Organizations | `GET /organizations` | to discover `organization_id` once (scope `ZohoBooks.settings.READ`) |
| Contacts | `POST /contacts`, `PUT /contacts` (+ upsert headers), `GET /contacts`, `POST /contacts/{id}/active|inactive` | `contact_name` (only required on create; **`contact_type` also required on update**), `contact_type: customer|vendor`, **`gst_no`** (the GSTIN field — there is no `gstin`), `gst_treatment: business_gst\|business_none\|overseas\|consumer`, **`place_of_contact`** (2-letter state code, e.g. `TN`), `contact_persons[]` (**omitted persons are deleted on PUT — always send the full list**), `billing_address`/`shipping_address` objects, `custom_fields: [{index, value}]` |
| Items | `POST /items`, `PUT /items` (+ upsert headers), `GET /items?filter_by=Status.Active` | `name` + `rate` required (pass `unit` too), `product_type: goods`, `sku` = our product code, `hsn_or_sac` (the India HSN field), `item_tax_preferences: [{tax_id, tax_specification: intra|inter}]` — top-level `tax_id` is **not applicable in India**; scopes are `ZohoBooks.settings.*` (there is no classic `ZohoBooks.items.*`) |
| Invoices | `POST /invoices` (creates `draft`), `GET /invoices/{id}`, `GET /invoices/{id}?accept=pdf`, `POST /invoices/{id}/status/sent`, `POST /invoices/{id}/email` | `customer_id`, `line_items[]` (`item_id` required, `rate`, `quantity`; `hsn_or_sac` inherited from the item), `date`, `reference_number` (carries the challan code), `place_of_supply` (defaults from the contact's `place_of_contact`), `custom_fields`, `notes`/`terms`; statuses `draft/sent/overdue/paid/void/unpaid/partially_paid/viewed`; response carries `invoice_url` |
| Bills | `POST /bills` | `vendor_id` + **`bill_number` required** (no auto-numbering) = GRN id; `line_items[]` (`item_id` or `account_id`, `rate`, `quantity`, `hsn_or_sac`, `reverse_charge_tax_id`), `source_of_supply`/`destination_of_supply` (default from contacts); created `open`; statuses `paid/open/overdue/void/partially_paid` |
| Credit notes (later) | `POST /creditnotes?invoice_id=…` with `is_draft: true` | `customer_id`, `date`, `line_items[]` |
| Payments (later) | `POST /customerpayments`, `POST /vendorpayments` | apply arrays against invoice/bill ids |

Rate limits (official): **100 requests/min/org**, 1,000–10,000 **per day by plan** (Free 1,000 · Standard 2,000 · Professional 5,000 · Premium+ 10,000), 5–10 concurrent; 429 carries `{code: 44|45|1070}`; no `Retry-After` is documented — back off on our own. Lists paginate at `per_page` max 200. Every response (success and error) is `{code, message, …}` with `code: 0` on success.

## 4. Auth & one-time setup runbook (manual, before any code works)

1. **Books plan confirmed Premium** (founder, 2026-09-29) — 10,000 API calls/day, the roomiest cap; nothing to do here unless the plan changes (Gear → Subscription).
2. **Create the custom fields and the tag in the Books UI** (custom fields each marked *unique*, which is what powers the upsert headers):
   - Contacts → `Ops ID` (api name `cf_ops_id`)
   - Items → `Ops ID` (api name `cf_ops_id`)
   - Invoices → `Challan` (api name `cf_challan`)
   - Bills → `Ops GRN` (api name `cf_ops_grn`) — the bills create API does not document a top-level `tags` field, so this custom field is the machine marker there (bills' *line items* do take tags, but a document-level field is the honest key)
   - A tag named **`Ops Dashboard`** (native Books tags) — every pushed invoice carries it, so anyone working in Books sees a document's origin at a glance; the sync-back (§9 Phase 5) keys on our stored Books ids, so the tag is visibility for humans, not plumbing
3. **Create the Self Client**: `https://api-console.zoho.in` → Self Client → CREATE NOW. Note `Client ID` / `Client Secret`. (Register on the **.in** console — the org is India-DC; tokens must be minted on the DC where the account lives.)
4. **Generate the grant code**: console → Generate Code tab → scope string exactly:
   ```
   ZohoBooks.contacts.ALL,ZohoBooks.settings.ALL,ZohoBooks.invoices.ALL,ZohoBooks.bills.ALL,ZohoBooks.creditnotes.ALL,ZohoBooks.customerpayments.ALL
   ```
   (settings covers Items and Organizations; payments scopes are included now so a later phase never needs a re-consent.) Time duration: 10 minutes. The code is one-time-use.
5. **Exchange it** (within the window):
   ```bash
   curl -s -X POST 'https://accounts.zoho.in/oauth/v2/token' \
     -d client_id=<ID> -d client_secret=<SECRET> \
     -d grant_type=authorization_code -d code=<GRANT_CODE>
   ```
   Store `refresh_token` — it **does not expire** until revoked, does **not rotate** on refresh (max 20 live per user; revoking an old one is the only invalidation).
6. **Create the sandbox org, then discover both org ids** (decided 2026-09-29: dev/preview talk to a sandbox org, production to the live org). In Books: org switcher (top-left) → create a new organization — a trial org to play in. Then one-off `GET https://www.zohoapis.in/books/v3/organizations` calls → note both `organization_id`s. The same user account (and the same refresh token) addresses every org the account belongs to; the `organization_id` param selects the target per call — so only `ZOHO_BOOKS_ORG_ID` differs between environments, and no second Self Client is needed. If Zoho ever forces per-org consent, a second refresh token for the sandbox org slots into the dev env vars the same way.
7. **Env block** (Vercel + `.env.example`; treat the refresh token like a live credential — colleague zips never carry env files):
   ```
   ZOHO_BOOKS_CLIENT_ID=…
   ZOHO_BOOKS_CLIENT_SECRET=…
   ZOHO_BOOKS_REFRESH_TOKEN=…
   ZOHO_BOOKS_ORG_ID=…        # sandbox org id on Development/Preview, live org id on Production
   # optional, default https://www.zohoapis.in/books/v3
   ZOHO_BOOKS_API_BASE=
   ```
8. **In Books, set up GST — rates decided 2026-09-29**: **GST 5%** (2.5% CGST + 2.5% SGST) and **IGST 5%**. Both orgs (sandbox and live) get the same setup. Attach both to every synced item's intra/inter `item_tax_preferences`, so Books picks 2.5+2.5 for in-state customers and a single 5% IGST for out-of-state ones from `place_of_supply` on its own — the dashboard never encodes a rate. Also set the org's invoice number series. One-time org configuration, not code.

Token-refresh rules the client must respect (all documented): access token lives **1 hour**; **max 10 tokens per refresh token per 10 minutes** — so the token is cached module-level and single-flighted (one refresh in flight; callers await the same promise), exactly like the Tables client's chain. On a cold serverless instance the first call refreshes; that is well inside the throttle.

## 5. Data mapping (dashboard → Books)

| Dashboard | Books | Mapping notes |
|---|---|---|
| `Customer` | Contact `contact_type=customer` | `name`→`contact_name`; `gst`→`gst_no`; `gst_treatment` = `business_gst` if `gst` present else `business_none`; `place_of_contact` = first two chars of the GSTIN (the state code is embedded there) for registered, else the new `state` field (§7); `contactPerson`/`phone`/`email` → one `contact_persons[]` entry; `shipTo`→`shipping_address.address`; `cf_ops_id` = customer id |
| `Vendor` (farmer or trade) | Contact `contact_type=vendor` | Same shape; farmers are mostly unregistered → `business_none`, place defaults to the home state (new `state` field); `payment` (Cash/Credit) → `payment_terms` hint only — the accountant sets terms in Books |
| `Product` (the recipe — plain Tender Coconut Water and Coconut Malai included; one schema for every sellable, decided 2026-09-29) | Item | `name`→ composite `"{name} · {type} {size}{unit}"`, `sku` = product code (e.g. `FG-00001`), `rate` = the recipe's fixed `price` (what the invoice bills and the label prints — MRP retires), `product_type=goods`, `hsn_or_sac` = the recipe's `hsn` (asked at creation; one code across pack sizes, per recipe), `item_type=sales` (we do not track stock in Books), `cf_ops_id` = product id |
| `PurchaseProduct` (Farm Produce) | Item | `item_type` with purchase side (`purchase_rate` = typical rate), `hsn_or_sac` per the accountant's code for fresh coconut; packing materials can follow the same route later |
| GRN | Bill | `bill_number` = GRN id; `cf_ops_grn` = GRN id (the unique custom field that powers idempotent re-push, since the bills API has no document-level tag); `vendor_id` via vendor→contact map; date = GRN date; line 1: farm-produce item, qty = `accepted` at `rate`; line 2 (when `transport > 0`): `account_id` = the freight account (env), amount = `transport`, description "Transport — {GRN id}" — its own visibly labelled line so anyone reading the bill sees what the transport cost was (decided 2026-09-29); transport never appears on sales invoices; `reference_number` = lot code; total then equals `landed` exactly — the bill reconciles with `src/lib/grn.ts` cost math by construction |
| Challan (group of `Dispatch` rows, one customer, status Delivered) | Invoice (draft) | `customer_id` via customer→contact map; `date` = delivery date; `reference_number` = challan code; one line per distinct sku (qty summed across the challan's rows), `item_id` via product→item map, `rate` = the recipe's fixed `price` — no dialog, no override (decided 2026-09-29); `notes` = dispatch ids + vehicle; `cf_challan` = challan code (the idempotency key); `tags` = [`Ops Dashboard`] |
| Rejection/return (later) | Credit note | from the invoice, `is_draft`, reason in notes |

Every mapped master stores the Books id back on its row (`booksContactId` / `booksItemId`, §7), so pushes are local lookups with no Books read at invoice time.

## 6. Server design

**`api/_lib/books.ts` — the Books client** (sibling of `api/_lib/zoho.ts`, mirroring its conventions):
- module-level token cache with a refresh margin, single-flighted through a promise chain (the Tables client's `this.chain` pattern) — the 10-tokens/10-min throttle makes naive refresh-per-call a outage;
- `Budget(90, maxWaitMs)` on calls vs the 100/min org limit (same `Budget` class, looser number), plus a daily counter logged not enforced (plan-dependent);
- JSON bodies (Books accepts JSON; the Tables client's form-urlencoded workaround is a Tables transport quirk, not needed here);
- `organization_id` query param + `Zoho-oauthtoken` header on every call;
- error mapping: `{code, message}` envelope → `ZohoBooksError(op, code, message)`; HTTP 429 → the existing `ZohoLockedError` so routes already know to answer 503 + Retry-After.

**Routes** (each follows `api/admin/*.ts` precedent: `authenticate()` → admin gate → act → `writeAdminAudit` → `bumpRevision` + `invalidateSnapshotCache()` when local rows changed):

| Route | Does |
|---|---|
| `GET  /api/books/status` | token + org reachable, org name/plan, counts of unsynced masters/challans/GRNs — the connection smoke test |
| `POST /api/books/contacts` | `{kind: 'customers'\|'vendors'}` — upsert-push all (or listed) masters via the custom-field upsert |
| `POST /api/books/items` | upsert-push products / purchase products |
| `POST /api/books/invoice` | `{challan}` — group that challan's Delivered dispatch rows, refuse mixed customers, pre-flight `booksInvoiceId`, create draft, write `booksInvoiceId`+number onto every row of the challan, audit, return `{invoiceId, invoiceNumber, invoiceUrl}` |
| `POST /api/books/bill` | `{grnId}` — same shape for the purchase bill (bill carries `cf_ops_grn` = GRN id, its marker where the API has no document tag) |
| `POST /api/books/sync-back` *(Phase 5)* | no body — re-reads every pushed invoice/bill whose stored status is not terminal and writes the status home; on a Vercel cron plus a manual admin button |

Admin-gated (`isAdmin`), **no new page permission** — the 26 `page.*` vocabulary stays untouched; the buttons live inside existing pages' DetailViews and row actions. Id write-backs into Tables go through `upsertByKey` with the `expect` base read in the route (the optimistic-concurrency protocol, server-side instance of it).

**UI (minimal, reskins nothing):** a `btn-light` action in the Dispatch row-actions/DetailView ("Invoice in Books") and on the GRN view ("Bill in Books"), visible to admins; a DetailView section "Zoho Books" showing number/status/date and a link out to `invoice_url`; a small "Sync to Books" action on Vendors/Customers/Products masters. The status chip reuses the existing `.status` family (`info` for draft, `success` for sent/paid) — no new chrome, per the blend's locked rules.

## 7. Schema changes (SQL-first: the DDL is this list; nothing is created before it)

No new tables. Columns added to existing Zoho Tables tables (then `scripts/zoho/gen-base-schema.mjs` re-run so `api/_lib/baseSchema.ts` knows them):

- **Customers**: `state` (text, optional — place of supply when unregistered), `books_contact_id` (text, optional)
- **Vendors**: `gst` (text, optional), `state` (text, optional), `books_contact_id` (text, optional)
- **Products**: `price` (number, optional — the fixed sell price per recipe; the invoice bills it and the label prints it, replacing `mrp`), `hsn` (text, optional — asked at creation, one code per recipe across pack sizes), `books_item_id` (text, optional)
- **PurchaseProducts**: `hsn` (text, optional), `books_item_id` (text, optional)
- **GRNs**: `books_bill_id`, `books_bill_status` (text, optional — status written by the Phase 5 sync-back)
- **Dispatches**: `books_invoice_id`, `books_invoice_number`, `books_invoice_status` (text, optional — same values on every row of the challan; status written by the Phase 5 sync-back)

All optional, all backwards-compatible; the mirror and the diff engine carry them like any other field.

## 8. Testing plan

- `api/_lib/books.test.ts` — the client against a scripted `fakeFetch` (the `zoho.test.ts` pattern): token cache + single-flight (two concurrent calls → one token request), budget refusal, 429 → `ZohoLockedError`, error-envelope mapping, upsert headers attached.
- Payload-builder unit tests: challan→invoice lines (sku grouping, qty summing, mixed-customer refusal), GRN→bill lines (transport line, total = landed), contact/item mappings incl. `gst_treatment` inference and GSTIN state-code extraction.
- Route tests: admin gate (scoped caller refused), pre-flight refusal when `booksInvoiceId` already set (no double invoice), audit row written, revision bumped.
- Live verification on the staging org first (a test Books org if available): push one contact, one item, one challan, one GRN; confirm draft state, numbering, and totals in the Books UI; then re-push the same challan and confirm it updates rather than duplicates.
- The local UI harness (fake `dbApi`, per `local_ui_harness` memory) for the button/DetailView work without touching anything live.

## 9. Phases

1. **Phase 0 — setup (§4 runbook, no code).** Sandbox org created, Premium plan confirmed, GST 5% + IGST 5% configured in both orgs, custom fields + `Ops Dashboard` tag created.
2. **Phase 1 — connection.** `books.ts` client + `GET /api/books/status` + tests + env block in `.env.example` (org id per environment — sandbox on dev/preview, live on production).
3. **Phase 2 — masters, recipe schema first.** The product master ("recipe") gains `price` + `hsn` (asked at creation), MRP gives way to the recipe price on printed labels, and plain **Tender Coconut Water** and **Coconut Malai** become recipes exactly like every melange — one schema for everything sellable, so new melanges change nothing. Then contacts sync (customers, then vendors — needs the §7 vendor columns) and items sync. Ends with every existing master mirrored in Books.
4. **Phase 3 — invoices.** Challan→draft-invoice push at the recipe's fixed price, dispatch fields, audit, UI action + DetailView section. This is the headline feature.
5. **Phase 4 — bills.** GRN→bill push, labelled freight-account transport line, UI.
6. **Phase 5 — status sync-back (the "two-way" half, committed 2026-09-29).** `/api/books/sync-back` on a Vercel cron + a manual admin trigger: for every pushed invoice/bill whose stored status is not terminal, re-read it in Books and write `books_invoice_status` / `books_bill_status` home through the normal keyed upserts, bumping the revision so Dispatch/GRN views show Sent/Paid/Overdue in the existing `.status` chip family. A Books webhook (UI-configured, HMAC `X-Zoho-Webhook-Signature`, exactly 5 retries — the receiver must be idempotent, which keyed upserts are) can replace the poll later. Documents created by hand in Books are never imported into ops. Credit notes and vendor payments stay later.

## 10. What stays manual (on purpose)

Marking invoices sent; IRN push (Books is a registered GSP — IRN generation is in-product via Settings → e-Invoicing; our drafts only need to carry correct GSTIN/HSN, which the mapping guarantees); e-way bills (no API exists — UI-only); payments and reconciliation; tax rates and HSN codes (Books org config); voiding/cancelling.

## 11. GST & e-invoicing posture

The ₹5 crore aggregate-turnover e-invoicing mandate is unchanged for FY 2026-27 (CBIC Notification 10/2023-CT); B2B invoices and exports need IRN within the reporting window (30 days from invoice date at this threshold — verify in-org). Because Books generates IRN itself through its GSP channel, **the integration does zero e-invoice work**: it creates correctly-attributed drafts; the office pushes IRN from Books. The one discipline the mapping enforces: registered customers must carry a valid `gst_no` before their first invoice push (validate the 15-char format client-side, warn don't block).

## 12. Decisions & remaining confirmations

**All six open questions answered 2026-09-29:**

1. **Sell rate** → a fixed `price` on the recipe, used everywhere: invoice lines bill it, printed labels carry it (MRP retires). No per-customer rates, no push-time dialog.
2. **HSN + schema** → HSN asked at recipe creation, one code per recipe shared across pack sizes; plain Tender Coconut Water and Coconut Malai are modelled as recipes alongside the melanges so every sellable shares one schema. **GST 5%** (2.5% CGST + 2.5% SGST); Books automatically applies 5% IGST instead when a customer is out of state — same total, correct law.
3. **Farmer purchases** → transport is its own labelled freight line on the bill, never on invoices; farmer contacts carry no GST (`gst_treatment=business_none`).
4. **Tag + two-way** → every pushed invoice carries the `Ops Dashboard` tag (bills carry `cf_ops_grn`), and Phase 5 syncs statuses back. Documents created by hand in Books stay in Books.
5. **Books plan** → Premium (10,000 calls/day).
6. **Orgs** → sandbox Books org for dev/preview, live org for production — same token, `ZOHO_BOOKS_ORG_ID` differs per environment (§4 step 6).
7. **Challan practice** → confirmed: one challan is one customer, invoiced whole.

**Still to confirm (small, none blocking):**

1. **RCM on farmer purchases** — default taken: *no* reverse charge, plain unregistered purchase lines. If the accountant says RCM applies to any vendor class, it is one field on the bill line (`reverse_charge_tax_id`) and a tax configured in Books; nothing structural changes.
2. **The HSN values themselves** — the field exists from Phase 2; the actual codes for tender coconut water and malai get filled in per the accountant's list (one code per recipe, all pack sizes).

## 13. Zoho MCP & webhooks (adjacent, not the integration)

Zoho MCP (mcp.zoho.com) is GA and free: compose a remote MCP server from Books/Tables connectors, per-user OAuth (Authorization-on-Demand), no separate quota (it consumes the same Books API budget). It adds no capability over REST, so the product integration stays direct REST; a small composed server (a handful of tools, not a 700-tool catalog — the Cliq context blowout is the cautionary memory) is a reasonable QA convenience later, added with `claude mcp add --transport http` exactly like the existing `zoho-apptics` server. The remote URL embeds an API key — treat it as a credential; regenerate on leak.

Webhooks (Phase 5 candidate): configured in the Books UI (Settings → Automation → Workflow Actions), one per workflow rule, payload signed with `X-Zoho-Webhook-Signature` (HMAC-SHA256 over sorted key-values), exactly 5 automatic retries resending the same payload — a receiver must be idempotent, which our keyed upserts already are.

**References** — Zoho Books API v3: introduction & rate limits (zoho.com/books/api/v3/introduction/), OAuth (…/oauth/), errors (…/errors/), invoices (…/invoices/), contacts (…/contacts/), items (…/items/), pagination (…/pagination); Zoho Accounts self-client flow (zoho.com/accounts/protocol/oauth/self-client/); finance-domains migration (help.zoho.com community announcement); e-invoicing with Zoho Books (zoho.com/in/books/help/e-invoicing/); Zoho MCP (zoho.com/mcp, help.zoho.com/portal/en/kb/mcp); Books webhooks (zoho.com/us/books/help/settings/automation/workflow-actions/webhooks.html). Codebase facts: `api/_lib/zoho.ts`, `api/_lib/commit.ts`, `api/_lib/adminAudit.ts`, `src/types.ts`, `src/lib/numbering.ts`, `src/lib/grn.ts`.
