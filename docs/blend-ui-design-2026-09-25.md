# Roligt Foods Ops — "Leaf × Ledger" blend design

**Status:** Proposal (2026-09-25). Implementation not started.
**Author:** Naresh + Claude (adaptation session).
**Source design:** the SmoothieBar admin's "Mineral × Botanical" blend — `admin/docs/superpowers/specs/2026-06-12-smoothiebar-blend-design.md`. This doc carries that design language over **lightly**: tokens, locked rules, and component treatments, adapted to this app's reality. It is not a port of SmoothieBar's power-user chrome.

---

## 1. Why this exists

The plant app works; the skin doesn't match what it is. The current look (`src/index.css` `:root`) is a cream field (`#f5f0e6`) with a **dark green sidebar** (`#253d2b`), terracotta and gold accents, `16px` radii, and a soft ambient shadow on every card (`--shadow: 0 10px 30px …`). It reads as a warm brochure; the app is a **ledger reader** — nearly every screen is a table folded out of the append-only stock ledger, read all day by people standing in a plant.

The sister project (SmoothieBar admin) already solved this with the **blend**: white-forward surfaces, hairlines instead of shadows, one variable type family with tabular numerals, one brand ink that is never a button fill, and a quiet status-accent family. That language fits a ledger app even better than it fits a fleet console. Adapt it here; drop the cream, the dark sidebar, and the resting shadows.

### What carries from the blend, what stays Roligt's own

| Carried from the **blend** | Kept from **Roligt's current app** (do not restyle away) | Dropped |
|---|---|---|
| White surfaces, hairline depth, ink-family text, brand-as-ink, status wash family, Bricolage + role scale, tabular numerals | The RBAC page catalog + grouped nav (Operations / Masters / Administration), the **phone thumb bar** + drawer, the offline bar + save indicator, PWA install prompts, the document/DocViewer model, print report sheets | Cream field, dark-green sidebar fill, gold accents, resting card shadows, `16px` radius, Segoe UI stack |

---

## 2. Locked rules (carried from the blend — do NOT re-litigate)

- **Brand leaf-green is INK ONLY** — links, active nav, the "needs attention" highlight, the brand mark. **Never a button fill.** Primary CTAs are ink-strong (`--ink`).
- **No dark surfaces**, ever. The green sidebar becomes a light chrome surface. (The offline bar may stay ink-dark — it is an alert strip, not a surface; see §6.)
- **No card shadows on resting surfaces.** Hairlines do the depth. Exactly three shadow tokens survive: popover, dialog, drawer.
- **No emoji as UI affordance. Never render raw enum strings.** (`statusLabel`/`statusClass` in `lib/utils` already hold this line — keep it that way as statuses evolve.)
- **Numerals are tabular, everywhere** — `font-feature-settings:'tnum' 1` on every qty, UoM total, ₹ figure, KPI, count. This is a ledger app; ragged number columns are a defect.
- **Buttons:** primary = ink fill (`--ink` bg, white text); secondary = white + hairline; the current terracotta `.btn-accent` fill retires (accent lives in text/ink, not chrome).
- **No `transform: scale()` zoom hacks** (none known here; keep it that way).
- **The thumb bar, drawer, offline bar and save indicator stay** — they are the plant-floor reality, and the blend was never tested against phones. They get reskinned, not redesigned.

---

## 3. Design tokens (the Leaf × Ledger blend)

All in `:root` of `src/index.css` — this app's singlestylesheet is an advantage: one file to change. Old names map to new values in place where a class already reads them.

### Surfaces
| Token | Value | Replaces | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#f5f0e6` cream | content surface — white-forward |
| `--chrome` | `#fbfaf7` | — (new) | sidebar / topbar / table head — faint warm white |
| `--well` | `#f6f5f1` | `--panel #fffdf7` | recessed wells: chip tracks, KPI strips, pick lists |
| `--panel` | `#ffffff` | `#fffdf7` | cards — now pure white, hairline-bordered |

### Hairlines
| Token | Value | Replaces |
|---|---|---|
| `--hair` | `#e8e5dd` | `--line #d8d0c1` |
| `--hair-soft` | `#f0eee8` | — (new) |

### Ink (warm-cool neutral)
| Token | Value | Replaces | Use |
|---|---|---|---|
| `--ink` | `#15181b` | `#1f251f` | primary text, primary buttons |
| `--ink-soft` | `#5b626a` | `--muted #697065` | secondary text |
| `--ink-mute` | `#8c9098` | — | labels, captions |
| `--ink-faint` | `#b3b7bd` | — | footnotes, placeholders |

### Brand — leaf green (ink only)
Roligt's two greens (`#253d2b`, `#3e5b45`) collapse into one ink-grade leaf:
| Token | Value | Use |
|---|---|---|
| `--leaf` | `#355a44` | brand/positive ink, active nav underline, links, brand mark |
| `--leaf-deep` | `#274634` | inline text actions ("Edit", "Adjust") |
| `--leaf-wash` | `#eef3f0` | tinted fill for badges only |

### Status accents (a family, not a stoplight)
| Status | fg | wash | Replaces |
|---|---|---|---|
| Positive / brand | `--leaf #355a44` | `#eef3f0` | `--success #2f6b42` |
| Warning | `--amber #a4761f` | `#faf3e4` | `--warning #9b6b18` + gold `#d9a847` (gold retires) |
| Error / attention | `--clay #b4543a` | `#faeeea` | `--danger #a23f34` + accent `#c96543` (the two terracottas merge into one clay) |
| Info | `--slate #4a6d8c` | — | — |

### Depth + shape (Roligt addition — the blend spec is silent here, decide once)
| Token | Value | Note |
|---|---|---|
| `--shadow-pop` / `--shadow-dialog` / `--shadow-drawer` | small y-offset, low-alpha ink | the only three shadows in the app (modal, DocViewer, drawer) |
| `--radius` | `10px` (cards) / `8px` (controls, chips) | down from 16px; crisp but not sharp — plant-gloved fingers still tap these |

---

## 4. Typography — one variable family

**Family:** **Bricolage Grotesque** (variable; axes `opsz 12..96`, `wght 300..800`) — the same family the SmoothieBar blend locked. Editorial at display size; its optical-size axis keeps dense 13px ledger rows legible.

**Loading (Vite, not Next):** self-host — `BricolageGrotesque[opsz,wdth,wght].woff2` in `public/fonts/` + one `@font-face` with `font-weight: 300 800` and `font-stretch/opsz` axes. No Google Fonts link: the app is an **offline PWA**, so the font must come from the precache, not the network. (Add the woff2 to the service worker's precache `globPatterns` if it doesn't match.)

Segoe UI / Source Sans 3 are removed. No mono family by default — ledger numerals use Bricolage's tabular figures.

### Role scale (same as blend)
| Role | Size / weight | Notes |
|---|---|---|
| Display | 46 / 600, `-0.025em` | dashboard headline, login mark |
| Headline | 26 / 600, `-0.014em` | page titles in the topbar |
| Title | 14 / 600 | card titles, doc IDs |
| Body L | 14 / 400 | forms, detail views |
| Body | 13 / 400 | tables, ledger rows |
| Label | 11 / 600, `0.14em`, uppercase | eyebrows, column heads, nav groups |
| Numerals | 700, **tabular** | every qty, UoM, ₹, KPI |

---

## 5. Component rules (mapped to this app's classes)

- **`.status` badges** (StatusBadge + `statusClass`): wash fill + accent-family ink text (leaf/amber/clay per `statusClass`). No borders, no radius beyond 8px. The kind chips (`.kind-grn`, `.kind-qc`, …) get the same wash treatment, keyed to a small fixed palette — they distinguish document kinds, not severity.
- **Filter chips (`.chip-row`, `.page-chip`):** active = **ink fill**, neutral; inactive = white + hairline. Never leaf fill.
- **Buttons (`.btn`, `.btn-primary`, `.btn-light`, `.btn-danger`):** primary = ink fill; light/secondary = white + hairline; danger = clay **text or outline**, not a clay fill. `.btn-accent` (terracotta fill) is deleted; its call sites move to primary or an inline leaf-deep text action.
- **Cards (`.card`, `.stage-card`, `.qc-card`, …):** white + `--hair` border, `--radius`, **no shadow**. `.metric`/`.kpi-row`: numeral 700 tabular, label in `--ink-mute` Label role.
- **Tables (`.table-wrap`, `.cell-num`):** 13px Body, hairline row separators, `--chrome` head with Label role, tabular numerals right-aligned. `.cell-id` (doc IDs) in 600 weight — the ID is the handle the whole app trades in; it should scan like a name.
- **Attention rows** (dashboard exceptions, stock issues, QC holds): a 3px **lead bar** at the row's left edge (clay/amber) — not a full-row tint. `buildExceptions` already computes the severity; it drives the bar color.
- **Sidebar:** `--chrome` background, hairline right edge, nav items ink; active item = leaf text + a straight 2px leaf underline on the left edge (the blend's clean-underline treatment, rotated to a vertical rail). Group titles (`Operations` / `Masters` / `Administration`) in the Label role. The `.mark` "R" chip: leaf ink on `--leaf-wash`.
- **Topbar:** white, hairline bottom edge (no shadow). Title/subtitle in Headline/Body; the email `.pill` becomes a hairline chip. **Save indicator stays exactly as it is** — its honesty is a feature — restyled to `--ink-mute` with the offline case in clay.
- **Offline bar:** may stay ink-dark (`--ink` bg, white text) — it is an alert, one of the few justified dark moments, matching the blend's "three shadows" style of rationing.
- **Modal / DocViewer / drawer:** the only surfaces that earn a shadow token. DocViewer document chrome goes white + hairline; the **print report sheets** (`.report-sheet` and friends) are print CSS and are **not touched** by this design at all.
- **Toast:** hairline + white (or ink for success), consistent with badges.

---

## 6. Shell reskin — structure untouched

The shell is already right for this app; it gets a reskin only:

- Keep: RBAC-driven nav (the page catalog), the grouped sidebar, the mobile app bar + drawer, the **bottom thumb bar** (Dashboard · Procure · Produce · Quality · More), `OfflineBar`, install prompts.
- Change: sidebar cream→chrome (see §5), topbar de-shadowed, thumb bar → white + hairline top edge with active = leaf icon + ink label (active icons on phones need the ink weight, underline alone is too subtle at thumb size).
- **Editorial moment (optional, cheap):** the dashboard opens with one sentence in Display type — "The day's work" headline + the day's date and open-exception count — the blend's Console moment, one-line version. Not a fleet paragraph; this app's poetry is the ledger itself.

**Explicitly not ported** from SmoothieBar (its power-user chrome — wrong users here): command palette + keyboard model, Workstrip, WorkspaceDock, the 12-tab machine-detail strip. Plant operators are on phones with gloves, not mod-keys. Revisit only if an office power-user role emerges.

---

## 7. Plan (light, three phases, each shippable)

**Phase A — Foundations (one file):** replace `:root` tokens per §3, add the `@font-face` + role-scale utility classes in `src/index.css`, delete `--shadow` resting use, set `tnum` on numeral cells. Nothing moves structurally; the whole app shifts skin in one commit.

**Phase B — Shell:** sidebar → chrome + leaf active rail; topbar hairline; thumb bar + drawer reskin; `.mark` re-ink; save-indicator/offline-bar restyle. Verify drawer focus behaviour and `body.drawer-open` still hold (JS untouched).

**Phase C — Pages in place:** per-surface pass down the nav order (dashboard → procurement → production → quality → …), applying §5 as each page is touched: cards de-shadowed, chips → ink-active, attention lead bars, `.btn-accent` call sites migrated. Report sheets and PDF exports (jspdf) untouched.

Each phase is a normal PR; no route, data, or RBAC changes anywhere in this design.

---

## 8. Open questions for build time

1. **Leaf value** — `#355a44` proposed from the existing two greens; confirm against the brand mark / logo art once, before Phase A lands.
2. **Radius** — 10/8 proposed (blend is silent); check the densest tables (Production, Inventory) at 8px before committing.
3. **Font weight of the offline bar + toasts** — ink-dark allowed, or hairline-light like everything else? Decide in Phase B with the real bar on a phone.
4. **Whether jspdf exports should ever pick up Bricolage** — default no (embedded fonts bloat the bundle; reports are paper, not UI).
5. **Dashboard editorial sentence** — in for Phase C, or cut as decoration?

---

## 9. Next step

Phase A alone (tokens + type in `src/index.css`) is small enough to review as a single diff and big enough to judge the whole direction — start there, look at it on a phone, then commit to B and C.
