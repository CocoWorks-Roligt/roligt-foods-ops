# Wording review — scope for improvements

**Date:** 19 September 2026 (post-commit `e8ab1bd`)
**Corpus:** all user-facing strings in `src/` — 130 toasts, 19 confirm dialogs, 90 placeholders, 57 help notes, every button/save label, page subtitle and empty state.
**Companion doc:** the 6-sprint copy/a11y/polish plan (38-string rewrite tables) lives outside the repo at `../roligt-copy-ux-deai-plan.md`; this report is the current-state re-audit and the scope view. Line numbers below are from today's tree — the plan's older references have drifted.

---

## 1. Where the wording stands

**What's already good — protect it.** The app never loses concrete identifiers (lot ids, areas, counts). Domain register is consistent and unpretentious: *challan*, *lot*, *farmer*, *melange* (deliberately unaccented, 138 uses, zero variants), *BiB*. Most confirm dialogs state the consequence, not just the question ("Delete RFTC20260001? This reverses the raw material RF… put into store."). Table headers are short. Empty states mostly explain where records come from.

**The core problem: the app narrates.** It explains design rationale, system mechanics and history to people who need a 12-word instruction. It uses em-dashes as a stylistic crutch (15 toasts, 17 page subtitles, most long notes). And the same situation is phrased three different ways in three places, so nothing reads like one product.

## 2. Findings

### A. Toasts — 130 strings, three problems

1. **15 still carry em-dashes** (`grep "showToast(" src | grep " — "`), e.g. storage/sales/inventory domains: `"Nothing to print — pick a record…"`, `"Offline — working from this device…"`. The em-dash itself is the tell; every one of these rewrites to two short sentences or one comma.
2. **Refusal voice is inconsistent.** Same situation, three shapes:
   - "Cannot delete: X is filled from…" (block + reason) ✓ this is the good one
   - "That product is no longer in the master." (narrates state)
   - "They cannot have been destroyed before the run…" (reasons aloud)
   Roughly 20 refusal sites; each should be *block + next action*, one phrasing per situation.
3. **Success toasts are fine** ("${id} updated." / "${name} added.") — standardize on this terse form; no work needed beyond consistency.

### B. Help notes — 57 blocks, 12 are essays

Word counts of the top offenders: **Packing 114 words**, Settings numbering explainer 90, Production/QC/report-type notes 62–84 each. They teach the data model ("books the blend as a new lot… carrying the full cost", "costed itself at") instead of saying what to do. Target: ≤2 sentences, zero internal mechanics (*ledger*, *re-posted*, *folding*, *costed*). One confirmed AI-tell survives in UI text: `MelangeRuns.tsx:298` "…which is exactly what it does on the floor."

### C. Buttons & save labels — a verb zoo, plus casing drift

- **Casing bug, mechanical fix:** "Save Changes" ×8 vs "Save changes" ×2 (`Storage.tsx` area modal, `StockIssues.tsx`).
- Create-verbs across modals: *Post Receipt, Post Production, Post Packing, Post Melange, Raise Order, Confirm Dispatch, Generate, Save Evaluation, Save Pack Product, Move stock, Issue stock*. The Posts are a coherent family and worth keeping; but "Generate" alone (`Reports.tsx` COA modal) says nothing about what happens, and *Save Melange* (the recipe) next to *Post Melange* (the run) needs one glossary line somewhere so nobody thinks they're the same screen.
- "Edit / Review" on Quality vs plain "Edit" everywhere else — pick one.

### D. Confirm dialogs — 19, mostly good, four bare

Four end at the question with no consequence line ("Delete ${o.id}?", "Delete ${m.name}?") while the other fifteen say what reversal happens. Standardize: "Delete X? <what it undoes>." — the existing good ones are the template.

### E. Placeholders — 90, mixed voice, one factual error

- **Factual:** `Settings.tsx:337` "Always store in Cool (**-18°C**) Dry and Hygiene Place" — −18°C is a freezer, not "cool"; and line 345 says "Cool (4°C) Dry **&** Hygiene" vs "Dry **and** Hygiene" on 337. If these defaults print on stickers, this is a label-correctness issue, not just wording.
- **Voice mix:** instruction placeholders ("Search GRN, lot…", "Enter a stock ID…", "Pick a batch…") share screens with bare noun placeholders ("Cost", "Name", "Qty", "Material"). Rule: *instruction* for search/filter fields, *noun* for data-entry fields — today it's random per screen.

### F. Page subtitles — strong content, em-dash habit

17 of ~30 subtitles lean on " — " ("Control sampling tracking — every bottle kept back off a packing run"). The sentences themselves are concrete and worth keeping; the punctuation just needs to vary (period, colon, or two sentences).

### G. Zero states and status words

The giant-"None" pattern the earlier walk flagged is gone from list pages; remaining gap is numeric cards showing "None" where a muted "Nothing yet" + reserving numerals for real quantities would read better (Dashboard, Inventory area totals).

### H. Copy added this session (self-audit)

The new strings follow the terse register (reports dialog, sort labels, Dispatch search/status toolbar, "Default order" mobile option). Two nits: the reports-dialog empty state's second sentence runs 24 words — trim to "Lab reports and QC attachments will appear here."; "Default order" could name the page's actual default ("Newest first") but the generic form is defensible until per-page labels exist.

## 3. Scope for improvements (sized, in order)

| # | Work | Size | Risk |
|---|------|------|------|
| 1 | **Quick wins, one commit:** fix the −18°C/"Dry and"/"&" sticker placeholders; unify "Save changes" casing (2); remove "which is exactly what it does on the floor"; trim the reports empty state | ½ day | none — pure strings |
| 2 | **Em-dash purge in UI strings:** 15 toasts + 17 subtitles rewritten to periods/colons; grep guard added so they stay out | ½ day | none |
| 3 | **Refusal-toast standardization:** ~20 sites onto the "Cannot delete: X. <action>." pattern | 1 day | low — wording only, paths already tested |
| 4 | **Note halving:** the 12 long help notes to ≤2 sentences, mechanics words banned | 1 day | low — review each keeps its identifiers |
| 5 | **Confirm-dialog completion:** add consequence lines to the 4 bare ones | ½ day | none |
| 6 | **Placeholder voice rule:** instruction-vs-noun split per field type; glossary line for Save Melange vs Post Melange; rename bare "Generate" | ½ day | none |
| 7 | **Voice rules as code:** commit `docs/voice.md` (10 rules) + `scripts/check-voice.mjs` failing CI on em-dash toasts and banned phrases | ½ day | none |
| 8 | **README + code-comment de-AI pass** (per companion plan Sprints 3–4: rhetorical amplifiers, 49 "used to" flashbacks, 13 "deliberately") | 1 day | none — comments/docs only |

Items 1–7 are ~4 days of string-only work with zero behaviour change; item 8 is a separate skimmable PR. The a11y label work (every input programmatically named) is the natural next layer *after* the wording settles — the labels are the wording — and is scoped as Sprint 5 in the companion plan.

**Sequencing note:** do 1 and 2 first (highest visibility per minute), 3–6 as one reviewable batch per surface, 7 as the lock, 8 whenever. Keep the Indian-English register throughout — the target is brevity, not a different accent.
