# AuthKit theme — Production mirror kit (2026-09-28)

Staging's hosted sign-in page (`palatable-dew-12-staging.authkit.app`) is themed
Husk × Ledger; **Production is still on WorkOS defaults** because the WorkOS MCP
refuses production-environment mutations (`FORBIDDEN`, role hint: sandbox-only)
until the dashboard account has MFA or the MCP connection is granted production
access. This is the exact theme, paste-ready for the dashboard.

**Where:** WorkOS Dashboard → project *IT's Project* → environment **Production**
→ *Appearance* (AuthKit branding). Every value below maps to one control there.
Whoever has dashboard access applies it; the logo/favicon (an R mark + favicon)
are also dashboard-only uploads — staging never got them either.

## Global

| Setting | Value |
|---|---|
| Display name | `Roligt Foods Ops` |
| Theme | Light |
| Corner radius | Large |
| Font | `Bricolage Grotesque` (typed/picked — WorkOS serves it from Google Fonts) |
| Page background | `#f6f4ee` |
| Button background | `#15181b` |
| Button foreground | `#ffffff` |
| Link color | `#5a4531` |

## Sign-in page

| Setting | Value |
|---|---|
| Layout | Two column |
| Content panel alignment | Left |
| Heading | `Sign in to Operations Control` |
| Legal text | `CocoWorks · A Roligt Foods company` (field exists but does not render on the sign-in step — set anyway, harmless) |

### Custom HTML (content panel)

```html
<div class="rf-panel">
  <svg class="rf-rings" viewBox="0 0 200 200" aria-hidden="true">
    <circle cx="100" cy="100" r="96"/>
    <circle cx="100" cy="100" r="72"/>
    <circle cx="100" cy="100" r="48"/>
    <circle cx="100" cy="100" r="24"/>
  </svg>
  <div class="rf-brand">
    <div class="rf-mark">R</div>
    <div>
      <span class="rf-eyebrow">Roligt Foods</span>
      <div class="rf-wordmark">Operations<br/>Control</div>
    </div>
  </div>
  <p class="rf-lede">One ledger from the farm gate to the dispatch truck &mdash; procurement, extraction, melange, packing and quality, posted as they happen.</p>
  <div class="rf-flow">
    <span>Receiving</span>
    <span>Extraction</span>
    <span>Melange</span>
    <span>Packing</span>
    <span>Dispatch</span>
  </div>
  <ul class="rf-points">
    <li><b>Offline-first.</b> The floor keeps working when the network drops; saves sync when it returns.</li>
    <li><b>One ledger.</b> Every edit reverses its own lines &mdash; stock is never hand-corrected.</li>
    <li><b>Traceable.</b> Any lot, back to its farm and forward to its truck.</li>
  </ul>
  <div class="rf-foot">CocoWorks &middot; A Roligt Foods company</div>
</div>
```

### Custom CSS (sign-in page)

```css
.rf-panel{position:relative;height:100%;min-height:520px;display:flex;flex-direction:column;justify-content:center;padding:52px 46px 84px;background:#f3f0e7;color:#15181b;text-align:left;overflow:hidden;border-left:3px solid #5a4531;font-family:'Bricolage Grotesque',system-ui,sans-serif}
.rf-rings{position:absolute;top:-84px;right:-84px;width:260px;height:260px;fill:none;stroke:#5a4531;stroke-width:1;opacity:.09;pointer-events:none}
.rf-brand{display:flex;align-items:center;gap:16px;position:relative}
.rf-mark{width:64px;height:64px;flex:none;border-radius:50%;background:#ffffff;border:1px solid #e3dfd4;display:grid;place-items:center;color:#5a4531;font-weight:800;font-size:32px}
.rf-eyebrow{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#5a4531;margin-bottom:4px}
.rf-wordmark{font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1.02}
.rf-lede{position:relative;margin:22px 0 0;max-width:46ch;font-size:14px;line-height:1.55;color:#5b626a}
.rf-flow{position:relative;display:flex;flex-wrap:wrap;align-items:center;margin-top:18px;font-size:12px;font-weight:600;color:#5b626a}
.rf-flow span{display:inline-flex;align-items:center;background:#ffffff;border:1px solid #e3dfd4;border-radius:8px;padding:5px 10px}
.rf-flow span:not(:last-child)::after{content:'\203A';margin-left:10px;color:#5a4531;font-weight:700}
.rf-flow span:not(:first-child){margin-left:8px}
.rf-points{position:relative;list-style:none;margin:22px 0 0;padding:0;font-size:13px;line-height:1.5;color:#5b626a}
.rf-points li{display:flex;gap:10px;padding:9px 0;border-top:1px solid #e3dfd4}
.rf-points li:last-child{padding-bottom:0}
.rf-points b{color:#15181b;font-weight:600}
.rf-points li::before{content:'';flex:none;width:7px;height:7px;margin-top:6px;border-radius:2px;background:#5a4531;opacity:.55}
.rf-foot{position:absolute;left:49px;right:46px;bottom:30px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8c9098}
```

## Custom CSS elements (all AuthKit pages)

The branding font/colors only reach the first screen reliably; the later steps
(`/password`, `/magic-code`) and error surfaces need the per-element Custom CSS
(dashboard: Appearance → Custom CSS; MCP: `customCssElements`). The branded font
**loads** on every step — these rules make the UI actually use it.

| Element | CSS |
|---|---|
| Global | `font-family: 'Bricolage Grotesque', system-ui, sans-serif;` |
| Background | `background: #f6f4ee;` |
| Card | `border: 1px solid #e3dfd4; border-radius: 10px; box-shadow: 0 1px 2px rgba(31, 26, 17, 0.05), 0 2px 10px rgba(31, 26, 17, 0.04);` |
| Button | `background: #15181b; color: #ffffff; border-radius: 8px; font-weight: 700;` |
| Input | `border-color: #e3dfd4; border-radius: 8px;` |
| Label | `color: #5b626a;` |
| Callout | `border-radius: 8px;` |
| Footer | `color: #8c9098;` |
| SSO profile trigger | `border-color: #e3dfd4; border-radius: 8px;` |

## Two ways to apply

1. **Dashboard (works today):** paste the values above into the Production
   environment's Appearance page. Two-column layout and the custom HTML/CSS
   boxes are under the sign-in page section.
2. **MCP (once unblocked):** enable MFA on the dashboard account (or grant the
   WorkOS MCP connection production access), then ask Claude to re-run the
   `updateAppBranding` mutation against Production
   (`app_branding_01M390YKDK6XS7BEPQQ7BTHXSV`) — this file carries every value.

Note: theming alone doesn't turn production auth on — the production app still
needs its redirect/logout URIs (`https://roligt-foods-ops.vercel.app/api/auth/callback`),
the env vars in Vercel, and the RBAC seed (see the pending list in
`workos_auth_integration` memory / `docs/auth-provider-decision-report-2026-09-24.md`).
