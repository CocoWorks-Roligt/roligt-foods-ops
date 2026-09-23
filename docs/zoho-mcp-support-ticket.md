# Zoho MCP support ticket — draft

**Submit as:** it@roligtfoods.com · **Zoho One org:** 60080551781 (India DC) · **MCP service:** Zoho's official hosted servers at `zohomcp.in`
**Reproduced from two independent MCP clients** (ZCode and Claude Desktop/Code) with identical results — this is not client-specific.

---

## Issue 1 — Zoho Tables MCP: all portal-scoped calls return FORBIDDEN

**Auth user:** it@roligtfoods.com — portal Owner of "Roligt Foods Pvt Ltd" (portal_id `60087437927`), plan Zoho One Enterprise.

**Behavior:** Account-level `listPortals` succeeds. Every portal-scoped call (`listWorkspaces`, `getPortal`) returns:

```json
{"code":"FORBIDDEN","message":"MCP access is not enabled for this user or portal"}
```

**Already attempted:** MCP access enabled for the Tables server in the Zoho MCP console; server disconnected and re-authorized (fresh consent). Behavior unchanged.

**Evidence the account is not the problem:** the same user, same portal, over the **direct Zoho Tables v1 REST API** with a Self Client token (scopes `ZohoTables.portals.READ`, `workspaces.READ`, …) — everything works: portals listed, workspaces listed, full base built (30 tables, fields, records). The gate exists only in the MCP layer.

**Request IDs:**
- `f367b873-6f12-4667-bb09-8529a4dc69b8`
- `2c8ede2d-84f3-4316-84df-ccbe3e8586b9`
- `68794cd7-371d-449b-8f13-9b516d3aebe1`

**Ask:** enable MCP access for portal 60087437927 / it@roligtfoods.com on the hosted Tables server, or explain which flag actually controls it.

---

## Issue 2 — Zoho Creator MCP: builder tools return success but never execute

**Auth user:** it@roligtfoods.com — super admin on workspace `it_roligtfoods` (60009969901).

**Behavior:** every builder write returns a canned success message (`"ZohoCreator_createApp executed successfully!"`) with **zero effect**, verified by an immediate read after each call:

| Call | Verifications after |
|---|---|
| `createApp` × 4 (plain and `enable_environments: true`) | `getApplications` + `getApplicationsByWorkspace` — app never appears |
| `createForm` × 3 (incl. on a fresh hand-created app `roligt-productiion-ops`) | `getForms` — form never appears |
| `createField` × 3 on a real form (`Vendor_Type`) | `getFormMetadata` — field never appears |

**Proof the endpoint executes:** `createField` with an invalid body correctly returns `2945 EXTRA_KEY_FOUND_IN_JSON` — the validation layer is live; only the write no-ops.

**Root cause identified:** `getAppEnvironmentStatus` returns

```json
{"code":11580,"message":"Environments are not supported for this version of creator."}
```

The builder tools require an `environment: development` header (enforced client-side by the tool schema), i.e. Creator's ADLM environment stack. Our Creator does not support environments, so builder calls appear to validate and then silently no-op.

**Data-plane tools on the same connection work perfectly** (`addRecords`, `deleteRecordByID` — including live form validation firing on bad input), which isolates the fault to the builder/environment routing.

**Ask:** either make the hosted Creator MCP builder tools function against non-environments (legacy) apps, or enable the environments stack for org 60080551781 so the documented header route works.
