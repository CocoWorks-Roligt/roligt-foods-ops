# RBAC.md — roles, actions, endpoint matrix (ARCHITECT, 2026-10-13)
Model: permissions are page slugs `page.<id>` (28 today, src/lib/pages.ts) + NEW action slugs `can.<action>` (ARCHITECTURE §2). WorkOS roles are composed of slugs at runtime; a caller holding any slug is scoped to exactly those pages; NO slugs = Operator (open tier, behavior unchanged) — INTERNAL users only. External users (delivery agents) are default-deny: an agent account with no explicit role sees nothing (REQUIRED before the PWA ships; see DECISIONS 2026-10-13). New catalog slugs ship with their pages: `page.shipments` (board), `page.my-deliveries` (delivery PWA), `page.dashboards` (module dashboards hub). Admin auto-inherits new slugs (`sessionPermissions`). Seed via `scripts/workos/seed-rbac.mjs` (`npx tsx --env-file=.env …`).

## (a) Roles
| role (WorkOS slug) | pages | landing | notes |
|---|---|---|---|
| app-admin | all 28 + every new slug | / | unchanged; only role with page.settings/admin-* |
| Operator (implicit) | none held → open tier (20 pages) as today | / | compatibility: any role ticking zero pages stays Operator |
| npd | page.npd | /npd | existing seeded role |
| procurement_officer | page.procurement, page.vendors, page.purchase-products, page.dashboards, page.live-reports | /procurement | receipts, grading (staged), material masters |
| production_operator | page.production, page.storage, page.stickers | /production | extraction/blend runs, put-away |
| packing | page.packing, page.stickers, page.storage | /packing | packing runs incl. control-sample capture |
| qc_analyst | page.quality, page.control-samples, page.test-parameters, page.reports, page.dashboards | /quality | release gate owner |
| store_dispatch | page.orders, page.dispatch, page.inventory, page.packing-materials, page.stock-issues, page.storage, page.shipments, page.dashboards | /dispatch | dispatch, shipments, challan correction |
| delivery_agent | page.my-deliveries ONLY | /my-deliveries | external; heavy scoping §(d) |
| manager | every Operations+Records page (incl. page.shipments, page.dashboards, page.traceability, page.audit); no Masters/Settings/Admin | / | page ticks carry WRITES, not reads only — a manager holding page.quality can write QC records (and release, see proxy note in (b)); grant Masters explicitly if wanted |

## (b) Action permissions `can.<action>`
| action | roles |
|---|---|
| can.release_lot | qc_analyst, app-admin — ENFORCED (qc_gate_v2 release arm, rulesGate gateQcReleases; proxy: page.quality until action slugs ship) |
| can.fail_lot | qc_analyst, app-admin |
| can.rework_lot | qc_analyst, app-admin |
| can.close_run | production_operator, packing, app-admin (guard: spoilage≥1 + mass-balance ok) |
| can.confirm_dispatch | store_dispatch, app-admin |
| can.create_shipment | store_dispatch, app-admin |
| can.start_delivery | delivery_agent (assigned shipment only) |
| can.submit_delivery | delivery_agent (assigned shipment only) |
| can.issue_challan | server auto on submit_delivery; store_dispatch, app-admin manual |
| can.correct_challan | store_dispatch, app-admin (new linked version + reason; NEVER delivery_agent) |
| can.decide_return | qc_analyst, app-admin |
| can.edit_reference_data | app-admin, manager (spoilage_reasons, carton_specs; masters keep their page gates) |
| can.manage_flags | app-admin |

## (c) Endpoint matrix (AUDIT §4 + ARCHITECTURE §5-6)
| method+path | required permission | notes |
|---|---|---|
| GET /api/auth/start\|callback\|session | any signed-in | PKCE; sealed cookie |
| POST /api/auth/signout | any signed-in | POST-only |
| GET /api/revision | any signed-in | poll token |
| GET /api/snapshot | any signed-in | page-projected + withheld list; delivery_agent: own shipments slice only |
| POST /api/commit | per-table gates (commitGates.ts: writePermission + page narrowing + ride-alongs) | unchanged; NEW collections are server-endpoint-only, never changeset-writable |
| GET/POST /api/admin/roles | page.admin-roles | last-admin guard |
| GET/POST /api/admin/users | page.admin-users | |
| POST /api/attachments/upload | page owning the record | presigned R2 PUT |
| GET /api/attachments/file | page owning the record | 302, expiring |
| GET/POST /api/compliance/documents, /upload, /file | page.compliance | |
| GET /api/compliance/remind | Bearer CRON_SECRET | cron only |
| GET /api/kpis/:module | module's page slug OR page.dashboards | delivery_agent: none; revision-keyed, last_updated+stale |
| GET /api/exports/:report | report's page slug | stream small / job+notify large; presigned expiring download; audited |
| GET /api/search | any signed-in except delivery_agent | agents get 403 (as built, B3); their own shipments/challans arrive via /api/shipments + /api/challans, not search |
| GET /api/events (SSE) | any signed-in | revision-keyed; delivery_agent stream scoped to own shipments |
| GET /api/genealogy | any signed-in except delivery_agent | BFS fold, both directions |
| POST /api/grading | page.procurement | staged mode (grns.grading_mode); Idempotency-Key |
| POST /api/purchase-orders | page.procurement | Idempotency-Key; vendor+lines validated; audit po.created (WORKFLOW W3) |
| GET /api/purchase-orders | page.procurement | newest first, for the Receipt stage's PO form |
| PATCH /api/purchase-orders/:id | page.procurement | Idempotency-Key; purchaseOrder machine + fully_received guard; audit po.status |
| POST /api/transformations/close | can.close_run + owning page (production\|packing) | Idempotency-Key; spoilage + mass-balance guards; audit |
| POST /api/dispatch/confirm | can.confirm_dispatch | atomic pouch+carton decrement, FEFO, reservations; Idempotency-Key |
| GET /api/shipments | page.shipments OR delivery_agent | server filter agentUserId=self for agents |
| POST /api/shipments | can.create_shipment | Idempotency-Key; audit |
| GET /api/shipments/:id | page.shipments OR assigned delivery_agent | agent payload strips costs, other customers/agents; 404 not 403 on unassigned |
| PATCH /api/shipments/:id | can.create_shipment | agent/vehicle reassignment, ETA |
| POST /api/shipments/:id/events | assigned delivery_agent OR can.create_shipment | append-only delivery_events; GPS optional |
| POST /api/shipments/:id/submit | can.submit_delivery (assigned) | signature + challan + PDF; Idempotency-Key; audit |
| GET /api/challans, /api/challans/:id | page.dispatch OR page.shipments OR delivery_agent (challans.agentId=self) | register + PDF via expiring URL |
| POST /api/challans/:id/correct | can.correct_challan | new linked version + reason + audit |
| POST /api/returns | delivery_agent (own shipment, rejected lines) OR store_dispatch | creates Return; no stock effect yet |
| POST /api/returns/:id/decision | can.decide_return | coldroom\|quarantine\|writeoff + ledger post; audit |

## (d) delivery_agent scoping (server-enforced)
- Shipments list/get: WHERE agentUserId = self — DB filter on every query, never a UI filter. Unassigned id → 404 (no existence leak).
- Own challans only (challans.agentId = self); create only via submit; correct_challan denied.
- Snapshot projection: MUST be an ALLOWLIST (shipments slice only) before page.my-deliveries goes live. As built today the projection is a withhold list over page-carrying collections — page-less keys (items, products, melanges, vendors, …) reach ANY signed-in caller, so the §(d) withholding below is the TARGET, not current behaviour (verified 2026-10-13, DECISIONS).
- Target withholding: ledger, items, products, grns, batches, orders, qcs, dispatches withheld entirely; shipment payload strips unit costs, other customers, other agents.
- No access to: KPIs, search (403 as built), genealogy, inventory, masters, audit log.
- Default-deny: an external account with no explicit delivery_agent role sees NOTHING (not the Operator open tier) — required before the PWA ships.
- Offline queue replay keeps scoping: events/submit re-validated against assignment at drain time.

## Exports & file URLs (all roles)
- Every export gated by the report's page slug and audited (who/what/when/filters).
- Files (challan PDFs, PoD photos, signatures, spoilage photos) served via expiring presigned URLs only — no permanent links; TTL short (minutes); grant itself audited.
- Injection-guarded CSV/XLSX/PDF; header shows title, filters, generated-by, timestamp.

## Audit coverage (must be logged, who/what/when/old→new)
lot release/fail/rework · run close · dispatch confirm · shipment events + signature submit · challan issue + correction (version link) · return decisions · all stock movements (ledger ride-along) · exports + file-URL grants · app_config edits · reference-data edits (spoilage_reasons, carton_specs, test_parameters) · flag toggles · user/role changes · counter resets.
