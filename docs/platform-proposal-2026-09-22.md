# Plant Operations Platform — Proposal & Recommendation

**Prepared for:** Roligt Foods management
**Date:** 22 September 2026
**Decision requested:** approve one of two options for the plant operations platform, both of which run the business on Zoho.

---

## 1. Recommendation

**Adopt Option 2 — the existing web application connected to Zoho Tables, with Kinde managing sign-in.**

The plant's operations app is already built and working: procurement, production, quality control, packing, orders, dispatch, planning, roster, traceability, and label printing. Option 2 keeps all of it — screens, offline capability, and business rules — and moves its data into Zoho Tables, so the company gains consolidated Zoho-based reporting **without rebuilding the software**.

Option 1 (building the app inside Zoho Creator) remains available and has been prototyped. For standard form-and-ledger operation it covers most needs natively, and for existing licensed staff it adds no licence cost. But it means re-creating, screen by screen, software that already works — an estimated **3–6 months of rebuild** — and it cannot deliver three things the plant relies on: **operation in the cold room with weak signal**, the **tailored screens** the team already uses, and **app access that is independent of Zoho licensing** (every Option 1 user must hold a licensed Zoho identity — see §6). The first two are platform characteristics, not features that can be added later.

Both options store data in the same Zoho Tables database, which is already built. **No work done to date is discarded under either option.**

---

## 2. The two options

**Option 1 — Build inside Zoho Creator.**
Zoho's low-code platform generates the forms, lists, and mobile access; business logic runs in Zoho's own scripting language. Zoho hosts everything — there is no software for us to run. **Anyone who uses the app signs in with a Zoho account and must be a licensed user** (see §6 for what this means on our Zoho One All Employee plan). Extending the app requires a specialist in Zoho's scripting language (a niche skill), and changes are made by hand inside Zoho's design tool. A working prototype exists: data-entry forms for all modules plus automatic document numbering, verified live (a GRN was numbered correctly in the plant's RFTC series, with the counter confirmed to persist).

**Option 2 — Existing web app on Zoho Tables, with Kinde sign-in.**
The current application (a modern web app, installable on phones/tablets like a native app) is kept as-is. A small connection layer moves its data into Zoho Tables. Sign-in is handled by Kinde, a specialist authentication service — **no passwords stored by us**; invites, password resets, and role assignment (Admin / Operator) are managed through its console, free at our scale. **App users do not need Zoho accounts**; the Zoho side needs only one or two existing licensed administrator accounts for the data link. Extending the app uses mainstream web technology — the most common developer skills in the market. Most of this connection layer is already built and tested.

**Either way:** all operational data lands in the same Zoho Tables base; Zoho Analytics reports on it identically; the current app's separate cloud-database subscription (Supabase) is retired after switchover.

---

## 3. What has already been validated (why this recommendation is evidence-based, not opinion)

Working prototypes were completed on **both** platforms, and each option has a full implementation record:

- The **Zoho Tables database is built and populated** — 30 tables covering every module, shared by both options.
- The **Creator prototype** is live: data-entry forms for all modules, master data seeded, and automatic document numbering proven in live use — correct number minted, counter advanced and persisted.
- The **Option 2 connection layer** is built and automatically tested against Zoho's live systems, including their published usage limits; a safe test copy of the database is used for all validation. The remaining work is connecting module-by-module, starting with goods receipt (GRN).

The Creator track's own implementation assessment concluded the platform carries most of the app's standard value, and identified its hard limits: no offline operation, no all-or-nothing save, and the bespoke screens do not transfer. The comparison below reflects those **ongoing operational characteristics** — what each option is like to run, extend, and use.

---

## 4. Side-by-side comparison

| | **Option 1 — Zoho Creator** | **Option 2 — Web app + Zoho Tables + Kinde** |
|---|---|---|
| **Features available at go-live** | Data-entry forms module by module; full parity only after the full rebuild | **Everything the plant uses today**, including planning, roster, traceability graph, label printing |
| **Time to first live transaction** | GRN entry possible early | **~1–2 weeks** (connection already ⅓ built) |
| **Time to complete switchover** | **3–6 months** (rebuild of all modules) | **~4–8 weeks** (connection work only; the app itself is done) |
| **Cold room / weak signal** | **Not supported** — requires reliable Wi-Fi or a kiosk at the door | **Fully supported** — work continues offline; records sync when signal returns |
| **Screens & usability** | Standard Zoho forms and lists; functional but generic | **Tailored to the plant** — refined over multiple feedback rounds; registers, dashboards, in-place editing |
| **Mobile access** | Zoho Creator mobile app (requires Zoho account sign-in) | Installable web app on any phone/tablet; no app store needed |
| **Who can use the app** | **Licensed Zoho users only** — see §6 | Anyone with an email invite (free) |
| **Save integrity** | Each entry saves its record, then posts to the ledger as a second step; **if posting fails, the entry is left for an operator to correct and resubmit**; two entries at the same instant could receive the same document number (unverified until tested) | Single verified save per entry, with automatic safe retry; duplicate document numbers prevented by design |
| **Who can extend it** | Specialist Zoho-scripting developers (niche skill); changes copied into Zoho's design tool by hand — the live app can drift from the master copy until re-checked | Any web developer (among the most common skills in the market); changes ship through standard, versioned releases |
| **Monthly running cost** (see §6) | **$0 extra** for existing licensed staff | **~$0–20** (hosting only) |
| **Adding seasonal / contract / auditor users** | Each needs a Zoho licence (a Creator seat, or a change to the company's Zoho One plan — both cost money) | **Free and instant** — an email invite in Kinde; no Zoho account needed |
| **Sign-in & user management** | Zoho user accounts, managed by the org's Zoho admin | Kinde — hosted sign-in, self-service resets, Admin/Operator roles; free |
| **Servers / infrastructure to run** | None (Zoho-hosted) | None to purchase — a small service on Vercel's free/low tier that we administer |
| **Reporting** | Zoho Analytics over Tables | **Identical** — Zoho Analytics over the same Tables data |
| **Data ownership & exit** | Data exportable from Zoho | Data exportable from Zoho; the application itself is ours, and can be pointed at a different database if ever needed |

---

## 5. UI & user experience — what the floor actually sees

The current app's screens are not a generic interface — they are the product of multiple feedback rounds with the plant team, including a dedicated usability overhaul and a language/accessibility review. This is the investment Option 2 preserves exactly, and Option 1 replaces with the platform's standard patterns.

| Capability | Option 2 — web app (as used today) | Option 1 — Creator |
|---|---|---|
| **Registers & lists** | Sortable, filterable grids across every module; click a row to open its full details and edit in place without losing your place in the list | Standard list views with native search and sort — functional, but detail/edit happens in generic form pages, not in-place |
| **The planning screen** | The "what must ship" table computes open orders minus released stock, and a **Plan button that pre-fills the entry form**, with the bulk math shown ("Fills 300 L of Coconut Water — short by 300 L") and one-tap product chips | The same numbers can be computed, but as a report next to a standard form — the guided, one-screen flow does not exist and cannot be built |
| **Traceability** | Interactive lot-tracing map: click any lot or item and walk its full history visually | Not available in the app — traceability becomes an exploration view in Zoho Analytics: a different screen, a different audience, not a floor tool |
| **Dashboards & daily view** | A plant dashboard tailored to the day's work | Creator home pages — serviceable summaries, generic layout |
| **Label & report printing** | The current label and PDF pipeline, already working against plant printers | Creator print templates must be rebuilt and re-verified printer by printer |
| **Mobile experience** | Installable on any phone/tablet home screen; full-screen app behaviour; an offline indicator tells staff when they are working locally | Zoho's standard mobile app: reliable, but its navigation and screens are Creator's, not the plant's |
| **Screen changes after feedback** | Days — each change goes through an automated check and a preview link before release (this loop already ran for the usability overhaul and the wording review) | Small layout and wording tweaks can be made by admin staff in Zoho's design tool — a genuine advantage for minor edits; bespoke patterns are unavailable at any price |
| **Training & adoption** | The team is already trained; screens use the plant's own vocabulary (stages, products, statuses) | Retraining on generic forms; plant vocabulary must be re-applied field by field |

**A fair note both ways:** Creator's standard patterns are consistent and well-made — for pure data entry they will feel familiar to anyone who uses Zoho products, and admin-editable layouts are a real convenience. The loss is not general usability; it is the **plant-specific flows** — the guided planning screen, the traceability map, in-place editing, and the tailored mobile feel — which are exactly the parts the floor touches all day.

---

## 6. Licensing, users & cost

**Our Zoho position.** The company holds **Zoho One on the All Employee plan** — every employee is a licensed user, and access to Zoho apps (including Creator) is limited to those licensed users. This has three consequences for Option 1:

1. **Regular staff are covered.** Existing licensed employees can be given app access at no extra cost, under either option.
2. **People who are not licensed employees do not fit the model.** Seasonal workers, contractors, and auditors who need to use the app must either be given paid Creator licences individually, or the company must move Zoho One to the **Flexible User plan**, which licenses selectively but at a materially higher per-user rate — an org-wide cost change driven by one app's access needs.
3. **App-user growth is coupled to Zoho licensing forever.** Every future operator the plant hires for the app becomes a licensing decision under Option 1.

**Option 2 decouples app users from Zoho entirely.** The application's users are managed in Kinde (no per-user cost at any realistic plant size). The Zoho side needs only **one or two existing licensed administrator accounts** for the data link — plus the managers who already view Zoho Analytics, who are licensed anyway. Hiring ten seasonal operators costs **zero** in additional licences under Option 2.

### Monthly cost at today's position (5 users, all licensed staff)

| | Option 1 | Option 2 |
|---|---|---|
| Licence cost (staff) | $0 (Zoho One All Employee) | $0 (database reached through existing licences) |
| Hosting | none | ~$0–20/month (Vercel) |
| Sign-in | included | $0 (Kinde free tier) |
| **Total** | **~$0** | **~$0–20** |

### What changes as the plant grows

| Scenario | Option 1 | Option 2 |
|---|---|---|
| +4 seasonal operators | 4 additional licences (Creator seat each), or limited portal accounts, or a move to the Flexible plan — **all cost money** | **$0** — four Kinde invites |
| An auditor needs 2 weeks of read-only access | A licence or portal account for the duration | **$0** — invite, then revoke in one click |
| App grows to 15 users | 15 licensed Zoho identities touching the app | 15 Kinde users; Zoho licences unchanged |

Prices above are list-price indications; the company's India-region Zoho pricing applies and should be confirmed with the Zoho account representative — along with the two checks already recommended in the Creator implementation report (Creator-only licence cost for non-Zoho-One staff, and portal-user pricing). **For existing staff the two options cost the same; they diverge exactly where the plant is most likely to grow — seasonal and non-employee users.**

---

## 7. Maintainability — what the options are like to live with

| | Option 1 | Option 2 |
|---|---|---|
| Making a change | Edited in Zoho's design tool; logic changes are **copied in by hand** and go live immediately — no review step, and the live app can drift from the documented master copy (this already happened once during prototyping) | Standard development flow: the change is made, automatically checked, reviewed, and released through a controlled, versioned process — **what is documented is always what is running** |
| Testing before release | Manual testing inside Zoho's design tool, by a person | Automated quality checks on every change, plus an automated walkthrough of the app in a real browser — the same checks that built the entire current app |
| Skills needed to support it | Specialist in Zoho's scripting language — few developers available | Standard web development — among the most common skills in the market |
| If the vendor changes the platform | Platform updates arrive automatically and can change behaviour under us (the Creator version change during prototyping altered how custom logic must be written, mid-build) | Zoho-side changes are caught by our automated checks; all other components are ours to update on our schedule |
| Documentation & handover | App structure can be exported; day-to-day knowledge lives largely with whoever built it | Full version history by default; any competent web developer can pick it up |
| Ongoing obligations | Low — Zoho runs the infrastructure | Low but real — we run one small, fully tested hosted service and keep its supporting software up to date |

---

## 8. Deployment & releases

| | Option 1 | Option 2 |
|---|---|---|
| Getting a change to users | Edits in Zoho's design tool go live immediately; the formal staging pipeline exists but hit platform limits during prototyping and was bypassed | Changes are released automatically through our web host (Vercel), with a **one-click return** to the previous version if anything is wrong |
| Testing before users see it | A separate copy of the app must be maintained by hand | Every change can be privately previewed before release; all testing runs against a safe copy of the database — the live database is never used for testing |
| Returning to a previous version | Manual — restore a previous export | Automatic — any prior release can be restored in minutes |
| Adding/removing users | Zoho admin console (and the licensing steps of §6) | Kinde console — invite or deactivate instantly, no cost |
| Software updates on devices | Zoho Creator mobile app updates via the app store | The web app updates itself on next launch; no app store involved |

---

## 9. Security & data protection

Both options keep plant data **in the company's Zoho Tables base, hosted in Zoho's India data centre** — the same location and the same vendor controls over data at rest, under either choice. The differences are in identity, access control, and devices:

| | Option 1 | Option 2 |
|---|---|---|
| Sign-in | Zoho accounts (company-managed; multi-factor available at the account level) | Kinde — a dedicated authentication service with hosted sign-in pages, encrypted connections, and multi-factor support; **we never store passwords** |
| Who can see what | Zoho profiles and per-form sharing (coarser; anything more surgical must be hand-coded into the scripting layer) | Two roles (Admin / Operator) enforced **on the server** on every request — the same rule set the current app's database enforced, independently of the device |
| Company Zoho credentials on devices | Not applicable (users sign in as themselves) | **None.** The Zoho data link's credentials exist only on the server; staff phones hold nothing but a short-lived sign-in session for the app |
| Data on devices | Nothing is stored on the device (requires signal — the cold-room limitation) | A working copy of plant data is held on the device for offline use. It is operational data (stocks, lots), not sensitive personal data; sessions expire automatically, and sign-out clears the local copy. Device-loss handling should be confirmed at go-live |
| Audit trail | Platform audit plus the app's own audit log | The app's audit log (recording who did what, drawn from the sign-in identity) plus server logs |
| Vendor footprint | Zoho only | Zoho (data) + Kinde (sign-in) + Vercel (hosting) — two additional reputable specialist vendors, each holding only what their role requires (sign-in metadata; application hosting) |

---

## 10. Risks & mitigations

| Risk | Applies to | Mitigation |
|---|---|---|
| Peak-hour saving bursts (e.g. several GRNs posted at once) reach Zoho's per-minute data-writing limits, briefly delaying saves | Option 2 | The app is designed for this: during a burst, saves **queue on each device and retry automatically** — nothing is lost, entries complete a minute or two later. A rush-hour simulation is the first validation gate (§11) before further build-out. A dedicated upgrade path exists if the plant ever outgrows it. |
| Duplicate document numbers if two entries are saved at the exact same instant (the platform offers no locking) | Option 1 | Known limitation of the numbering design; a concurrency test is required **before real use**, with a re-sequencing workaround available if the race proves real |
| A failed posting step leaves an entry un-posted until an operator corrects and resubmits it | Option 1 | Pre-save checks catch most errors before the record exists; the exception list is monitored — but there is no automatic undo on this platform |
| Loss of offline working and familiar screens slows adoption on the floor | Option 1 | Not mitigable — platform characteristic; identified in the Creator assessment as the issue that can veto the platform |
| Rebuild overruns; modules arrive months late | Option 1 | Inherent to the option; mitigated only by reducing scope (fewer modules at go-live) |
| App access becomes a licensing constraint (seasonal/non-employee users force licences or a Zoho One plan change) | Option 1 | Structural under the All Employee plan; Option 2 removes the coupling entirely |
| Dependence on a specialist developer for future changes | Option 1 | Mitigated by retaining documentation; risk remains for anything non-trivial |
| Logic changes deployed manually into the design tool; live app drifts from the master copy | Option 1 | The documented master copy is kept safe and periodically compared against the live app (drift already occurred once in prototyping) |
| Dependence on our small connection layer | Option 2 | It is fully tested and documented; any competent web developer can maintain it — no specialist required |
| Vendor changes (pricing, product direction) | Both | Both options keep data in exportable Zoho tables; Option 2 additionally keeps the application code, which can be re-pointed at a different database |

**Fallback position:** if Option 2's peak-hour validation fails and cannot be remedied, the Creator prototype and plan resume — the shared database and numbering work carry over. Approving Option 2 does not burn the alternative.

---

## 11. Recommended plan

1. **Weeks 1–2 — Validation gate.** Connect the goods-receipt flow end-to-end and run the rush-hour simulation on a test copy of the database. Success criteria: a GRN posts correctly on a phone with intermittent signal, and a simulated morning burst of entries completes without loss.
2. **Weeks 2–8 — Module switchover.** Connect the remaining modules in plant order: procurement → production → quality → packing, orders & dispatch → planning & roster → labels. Old and new systems run in parallel until each module is verified.
3. **Cutover.** Real data migrated (one-time move with reconciliation checks), the current Supabase subscription retired, and Zoho Analytics reporting live on plant data.
4. **Retain.** The Creator prototype is kept as an optional back-office console for master-data editing (vendors, customers, items) — a task it performs well — and as a documented fallback. (If the fallback is ever exercised, its own pre-go-live tests — concurrent numbering and the no-signal phone test — are already identified in its implementation report.)

## 12. Decision requested

Approve **Option 2** and the two-week validation gate in §11.1. Total commitment at decision time is the connection work already ⅓ complete; the go/no-go checkpoint arrives before the majority of spend.

---

*Supporting documents (same workspace): full technical evaluation `platform-decision-report-2026-09-22.md`; Creator implementation record `../roligt-foods-ops/docs/creator-implementation-report-2026-09-22.md`.*
