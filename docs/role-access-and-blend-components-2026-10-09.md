# Role-user CRUD and "blend components not stored" — 2026-10-09

Two questions from the floor, one session: why could a role user (Josh,
"production manager" — every page except Roles) not edit anything in production,
and why do blend components look like they are not being stored. Both answers
were checked against the deployed build, the production dump, and a live D1
scratch run; the real defects found are fixed on this branch.

## 1. Why a role user could not edit anything

**Production runs the fixed code.** The deployed bundle at
`roligt-foods-ops.vercel.app` carries the post-incident rename exactly (2
"Blends" strings in the PurchaseProducts chunk, zero "Melanges" — matching
current main), and the incident record confirms the fixes deployed end of day
2026-10-07.

**The cause was the 2026-10-07 incident, already fixed and deployed** — but it is
worth naming because it is exactly "unable to change/edit anything":

- Every non-admin save that carries ride-alongs (ledger lines, counters, audit
  rows — which is every master create and most document postings) was refused
  `403 Forbidden('ledger')`, because the gate only counted collection changes on
  tables with a `page`, and masters tables carry `writePermission` instead
  (fixed in 0e6efd5).
- An edit that changed nothing diffed to a lone audit row → `Forbidden('audits')`
  → the refused row rode in every later save, wedging the device's whole queue
  (fixed in 9c242bb: audits-only diffs are a no-op; the chunker never strands
  ride-alongs).
- The client keeps refused work on-device and retries — so one wedge looks like
  "nothing can be edited", on every screen, forever.

**What her role can do now**: a page tick carries that page's reads AND writes;
"every page except Roles" therefore covers every table she can see — day's-work
tables through their page, masters tables through the same pages'
`writePermission`. Nothing server-side refuses her saves. If her device still
shows the symptom today, it is the known residual: **a tab whose offline queue
holds a permanently-refused save retries forever** — the cure is clearing site
data on that browser (postmortem item 5), or simply verifying from a fresh
login/tab.

**Refusal reasons** — the user's ask was "_state a proper reason why they are not
allowing_". The business gates already do, client-side, with specific wording:
- A GRN/lot already used in production: "This lot is already in production — only
  farmer, area, harvest date and notes can be edited."
- Stock issued or moved: "This stock has already been issued/moved — …" (per case)
- Deleting used stock: "Cannot delete: coconuts from this lot have already been
  used in production."
- Deleting a blend with runs: the delete button is titled "Already blended — has
  run history" and refuses.
- A blended recipe's uom: "… has already been blended, so it stays measured in …"

One message was actively wrong and is fixed here: the client's permission gate
said "**X is an admin task**" — untrue for scoped pages like Roster or Storage
that a non-admin can hold. It now says what is actually true:
"**X needs a permission your role does not hold — ask an administrator to grant
it.**"

## 2. Why blend components look "not stored"

Naming first: these are **blend** components, not melange components — a blend
is any recipe that mixes bulks into one finished product, and the plant's
smoothies and shakes are blends too. "Melange" survives only as code and data
names (the `melanges` collection, `Melange` types, ledger types) — the UI says
Blends everywhere a person reads.

**They are stored.** The recipe's `components` array lives inside the blend
row's Data JSON (Zoho) / `documents.json` (D1), byte-for-byte. Hard evidence:
the production dump (`dump-gerc53fe-…`) carries all 5 production blend recipes
with their full component arrays, and today's 1000-row D1 load test round-tripped
every component array exactly (docs/d1-load-test-2026-10-09.md, phase 5).

**Why it looks otherwise**: the Zoho base's visible "Melange Components" child
table (a legacy name) and the link columns are never written — deliberately; the
app never read them back and the D1 migration drops them outright (schema.sql
documents this). Anyone inspecting the base or building Analytics over that
child table sees it empty forever and reasonably concludes "not stored". The
data is in the parent row's JSON.

**Where components genuinely could vanish — all fixed on this branch:**

1. **A half-filled recipe row was dropped silently.** The dialog's payload
   filtered `.filter((c) => c.item && share > 0)` before validation, so a
   component with a bulk but no share (or 0) vanished on save with no word — the
   blend then stored fewer components than the screen showed. Now:
   `checkMelange` refuses the save with "Every component needs a bulk and a
   share — complete or remove the half-filled rows." (`bulk.ts`; the payload no
   longer pre-filters).
2. **A run draw with a missing lot or quantity was dropped silently.**
   `blendLines` filtered the same way at post time — a draw with item and qty but
   no lot (the lot dropdown reads "No stock" when nothing is drawable) vanished
   from the run. Now the post refuses with the reason, and a bulk with nothing
   left to draw gets its own words: "No batch lot of X is available to draw — its
   stock may already be fully used." (`MelangeRuns.tsx`).
3. **Editing a recipe that left this device's copy closed silently.**
   `updateMelange` returned `null` with no toast when the id was missing. Now it
   says: "That blend is no longer in this device's copy — reload the page and
   edit it again."

Known and unchanged: the optimistic "added." toast is the app-wide pattern (every
master does it); a save that is later refused or still syncing is signaled by the
server's own toast and the offline banner, and the work stays on-device until it
lands. On D1 nothing strips components anywhere — the write engine stores the
document whole.

## Tests and gates

`src/context/domains/bulk.test.tsx` (new, 3): the half-filled-row refusal stores
nothing and states the reason; the complete recipe lands with every component and
its bulk item; the missing-target edit toasts instead of closing silently.
`inventory.test.tsx` re-pinned to the new permission wording. Full gates:
`tsc -b` clean, 591 tests green (+3), oxlint at the 10-warning baseline, vite
build + PWA whole, assert-no-apptics pass.
