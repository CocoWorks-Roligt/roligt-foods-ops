# Roligt Ops on Zoho Tables — Fork, Plan 1 (BFF + GRN vertical slice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `roligt-foods-ops-zoho` — a forked copy of the Roligt PWA that runs on the existing Zoho Tables base through a commit-oriented BFF with Kinde auth — and prove it end-to-end with the GRN posting vertical.

**Architecture:** The client keeps its exact sync model (`diffState` → `StateChanges` → save); `dbApi.ts` is re-implemented over three BFF endpoints (`/api/snapshot`, `/api/revision`, `/api/commit`). The BFF (Vercel Node functions) validates Kinde JWTs, maps docs onto the built base (App ID + Data JSON on every row, real columns as best-effort enrichment for Analytics), upserts everything keyed by App ID (idempotent retries), throttles to the published per-minute API caps, and bumps a revision row in Config that clients poll.

**Tech Stack:** React 19 + Vite (as-is), Vercel Functions (Node), `jose` (JWKS), `@kinde-oss/kinde-auth-react`, `vitest` (new to the fork), Zoho Tables v1 REST (IN DC).

**Spec:** `docs/zoho-tables-fork-design-2026-09-21.md`. **Plan 2** (not this file): remaining collections' column enrichment, Kinde hardening for production, deployment.

## Global Constraints

- Zoho DC is **IN**: API `https://tables.zoho.in/api/v1`, OAuth `https://accounts.zoho.in/oauth/v2/token`.
- Production base: id `gerc53fe9f1e44e5f4a13809d9bd47367ba9d` ("Zoho production analytics"). **Never run scripts or tests against it except Task 12, which is gated on explicit user confirmation.** All earlier live work targets the scratch base from Task 3.
- Zoho creds live at `../.zoho.env` (relative to the fork root; `client_id`, `client_secret`, `refresh_token`). The shared token cache `../.zoho-token.json` may be reused by scripts but NOT by the BFF (BFF keeps tokens in memory only).
- Published rate limits (verified in `../zoho-build-probe/help.html`): Create/Delete/Update **20 per minute** each, Fetch **30 per minute**; breach locks that API for **5 minutes**. Access tokens last 1 h; max 10 grant tokens per 10 min.
- Verified v1 contracts (from `scripts/zoho/build-tables.mjs`, live 2026-09-20): `POST /tables` (create/duplicate), `PUT/POST /fields` (type is mandatory on PUT; components must be re-passed), `POST /records` with `field_ids_with_values` query-param JSON (field IDs as keys), `DELETE /records` single-record. Documented in help.html: `POST /fetchRecordsWithCriteria` (criteria, `count` max 1000, `reference_record_id` cursor), `PUT /records` with `data` + `criteria` + **`is_upsert_needed`** + `is_ids_used_in_params`/`is_ids_used_in_data`.
- Field type codes: text `23`, number `15`, currency `6`, date `7`, select `21`, checkbox `4`, email `9`, phone `17`, attachment `2`, autonumber `3`.
- Gates for every task that touches the fork: `npx tsc -b` exits 0; `npx oxlint` stays at 10 warnings / 0 errors baseline; `npm test` (vitest) passes. Run them from the fork root.
- Commits happen **only in the fork's own new git repo**. Never commit the main `roligt-foods-ops` repo, never push anywhere (pushing triggers Vercel deploys).
- The fork never edits logic in `src/context/domains/`, `src/lib/sync.ts`, `src/lib/localDb.ts`, or any page except `Login.tsx`. If a task seems to need that, stop and re-read the spec.
- Zoho API values are sent as **strings** (`String(value)`); skip `undefined`/`null`.

## File Structure (created/modified over this plan)

```
roligt-foods-ops-zoho/               # the fork (Task 1)
├── api/
│   ├── _lib/
│   │   ├── zoho.ts                  # T2: client — token, limiter, fetch/upsert/delete
│   │   ├── auth.ts                  # T8: Kinde JWKS verification + dev session
│   │   ├── baseSchema.ts            # T6: GENERATED table/field ids — do not hand-edit
│   │   ├── mappers.ts               # T9: doc ⇄ base columns (read generic, write enrich)
│   │   ├── snapshot.ts              # T9: assemble Partial<AppState> from the base
│   │   └── commit.ts                # T10: StateChanges → idempotent Zoho upserts
│   ├── snapshot.ts                  # T9: GET handler
│   ├── revision.ts                  # T9: GET handler
│   └── commit.ts                    # T10: POST handler
├── scripts/zoho/
│   ├── make-scratch.mjs             # T3: duplicate 30 tables into the scratch base
│   ├── probe.mjs                    # T4: live contract probe (scratch only)
│   ├── topup.mjs                    # T5: App ID + Data JSON + Sticker Prints + revision row
│   ├── topup-state.json             # T5: resumable state (generated)
│   └── gen-base-schema.mjs          # T6: emits api/_lib/baseSchema.ts
├── src/
│   ├── lib/
│   │   ├── authToken.ts             # T9: token hand-off from AuthContext to dbApi
│   │   └── dbApi.ts                 # T9/T10: REWRITTEN over /api/* (same exports)
│   │   └── supabaseClient.ts        # T9: DELETED
│   ├── context/AuthContext.tsx      # T7: REWRITTEN (Kinde + dev fallback, same interface)
│   └── pages/Login.tsx              # T7: REWRITTEN (Kinde redirect button / dev picker)
├── api-tests/ …                     # colocated as *.test.ts next to sources (vitest)
└── .env                             # T2: server env for `vercel dev` (gitignored)
```

Two directories grow in Plan 2: more column mappers, delta snapshots.

---

### Task 1: Fork the repo

**Files:**
- Create: `../roligt-foods-ops-zoho/` (copy of `roligt-foods-ops/`)
- Modify: `package.json`, `.gitignore`, `.env.local` (dummy client env), `.env` (server env stub)

**Interfaces:**
- Produces: a buildable fork whose `npm run build` and dev server work exactly like the original.

- [ ] **Step 1: Copy, clean, init**

```bash
cd /Users/skc/Desktop/coding/cw-ops
rsync -a --exclude node_modules --exclude dist --exclude dev-dist --exclude .git \
  roligt-foods-ops/ roligt-foods-ops-zoho/
cd roligt-foods-ops-zoho
git init -b main
```

- [ ] **Step 2: Rename the package**

In `package.json` set `"name": "roligt-foods-ops-zoho"` and add scripts/deps that later tasks rely on:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "lint": "oxlint",
  "preview": "vite preview",
  "test": "vitest run"
},
"devDependencies": {
  "@types/d3-force": "^3.0.10",
  "@types/node": "^24.13.3",
  "@types/react": "^19.2.17",
  "@types/react-dom": "^19.2.3",
  "@vercel/node": "^3.2.31",
  "@vitejs/plugin-react": "^6.0.4",
  "jose": "^5.9.6",
  "oxlint": "^1.75.0",
  "typescript": "~6.0.2",
  "vite": "^8.2.0",
  "vite-plugin-pwa": "^1.3.0",
  "vitest": "^2.1.9"
},
"dependencies": {
  "@kinde-oss/kinde-auth-react": "^5.1.0",
  "d3-force": "^3.0.0",
  "jspdf": "^4.2.1",
  "jspdf-autotable": "^5.0.8",
  "react": "^19.2.8",
  "react-dom": "^19.2.8",
  "react-router-dom": "^7.18.2"
}
```

(`@supabase/supabase-js` is intentionally gone from this list; Task 9 deletes its last import. Until then the dummy env below keeps the copied code compiling and running.)

`npm install`.

- [ ] **Step 3: Dummy envs so the unmodified copy runs**

`.env.local` (client — same offline-dummy trick the main repo's harness uses):

```
VITE_SUPABASE_URL=https://dummy.supabase.co
VITE_SUPABASE_ANON_KEY=dummy-anon-key
```

`.env` (server — filled further in Task 2):

```
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_BASE_ID=
ZOHO_DC=tables.zoho.in
ALLOW_DEV_SESSION=1
```

Ensure `.env` and `.env.local` are in `.gitignore` (the copied `.gitignore` already covers `.env*` patterns; add `.env` if missing). Do NOT commit either file's real values — real Zoho creds are read from `../.zoho.env` by scripts only.

- [ ] **Step 4: Verify the gates pass on the untouched copy**

```bash
npm run build && npm run lint
```

Expected: build exits 0; oxlint 10 warnings / 0 errors (same baseline as the source repo).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: fork roligt-foods-ops as roligt-foods-ops-zoho"
```

---

### Task 2: Zoho client library (no network)

**Files:**
- Create: `api/_lib/zoho.ts`, `api/_lib/zoho.test.ts`
- Modify: `tsconfig.node.json` (include `api`)

**Interfaces:**
- Produces (consumed by Tasks 4, 9, 10):
  - `class ZohoClient { constructor(opts?: { fetchImpl?: FetchLike; baseId?: string; env?: Record<string,string|undefined> }) }`
  - `ZohoClient.fetchAll(tableId: string, fieldIds?: string[]): Promise<ZohoRecord[]>`
  - `ZohoClient.upsertByKey(tableId: string, keyFieldId: string, keyValue: string, values: Record<string, unknown>): Promise<void>`
  - `ZohoClient.deleteRecord(tableId: string, recordId: string): Promise<void>`
  - `type ZohoRecord = { recordID: string; data: Record<string, unknown> }`
  - `class ZohoLockedError extends Error { retryAfterSec: number }`, `class ZohoApiError extends Error`
  - `ZohoClient` limits itself: reads ≤26/min, writes ≤17/min, serialized; on a lock response it throws `ZohoLockedError`.

- [ ] **Step 1: Extend tsconfig so `api/` is type-checked**

In `tsconfig.node.json`, set `"include": ["vite.config.ts", "scripts/**/*.mjs", "api/**/*.ts", "api/**/*.test.ts"]` (keep whatever compilerOptions are already there). This is what makes `npx tsc -b` gate the BFF too.

- [ ] **Step 2: Write the failing tests** — `api/_lib/zoho.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ZohoClient, ZohoLockedError } from './zoho'

/** A fetchImpl that records calls and answers from a scripted map. */
function fakeFetch(calls: { url: string; init?: RequestInit }[], replies: Array<{ status?: number; body: unknown }>) {
  let tokenCalls = 0
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.startsWith('https://accounts.zoho.in')) {
      tokenCalls++
      return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }), { status: 200 })
    }
    const r = replies.shift()
    if (!r) throw new Error(`unexpected extra call: ${url}`)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }
}

const ENV = { ZOHO_CLIENT_ID: 'ci', ZOHO_CLIENT_SECRET: 'cs', ZOHO_REFRESH_TOKEN: 'rt', ZOHO_BASE_ID: 'BASE' }

describe('ZohoClient', () => {
  it('fetches pages via the reference_record_id cursor until a short page', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const replies = [
      { body: { records: { fetched: [
        { recordID: 'r1', data: {} }, { recordID: 'r2', data: {} }, { recordID: 'r3', data: {} },
      ] } } },
      { body: { records: { fetched: [] } } },
    ]
    // force pagination by treating count as 3: use a client with page override
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, replies), env: ENV, page: 3 })
    const out = await c.fetchAll('T1')
    expect(out.map((r) => r.recordID)).toEqual(['r1', 'r2', 'r3'])
    // calls[0] is the token refresh, calls[1] the first page — the cursor appears on calls[2]
    const second = new URL(calls[2]!.url)
    expect(second.pathname).toBe('/api/v1/fetchRecordsWithCriteria')
    expect(second.searchParams.get('reference_record_id')).toBe('r3')
  })

  it('upserts by key with is_upsert_needed and field-id criteria', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [{ body: { status: 'success' } }]), env: ENV })
    await c.upsertByKey('T1', 'FAPP', 'GRN-1', { FAPP: 'GRN-1', FDATA: '{"a":1}' })
    const u = new URL(calls[1]!.url)
    expect(u.pathname).toBe('/api/v1/records')
    expect(calls[1]!.method).toBe('PUT')
    expect(u.searchParams.get('is_upsert_needed')).toBe('true')
    expect(u.searchParams.get('is_ids_used_in_params')).toBe('true')
    expect(u.searchParams.get('is_ids_used_in_data')).toBe('true')
    expect(JSON.parse(u.searchParams.get('data')!)).toEqual({ FAPP: 'GRN-1', FDATA: '{"a":1}' })
  })

  it('maps a rate-limit lock response to ZohoLockedError', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const c = new ZohoClient({ fetchImpl: fakeFetch(calls, [
      { status: 429, body: { error: { code: 'LOCKED', message: 'API limit reached. Try after some time.' } } },
    ]), env: ENV })
    await expect(c.upsertByKey('T1', 'F', 'k', {})).rejects.toBeInstanceOf(ZohoLockedError)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module './zoho'`.

- [ ] **Step 4: Implement** — `api/_lib/zoho.ts`:

```ts
/**
 * Zoho Tables v1 client for the BFF.
 *
 * Two things this file is deliberately paranoid about:
 *  1. Rate limits are global per API key and a breach locks the API for five minutes —
 *     the plant stops. So every call goes through a serialized budget (26 reads, 17
 *     writes per minute, under the published 30/20) and a lock response becomes
 *     ZohoLockedError, which the commit endpoint surfaces as 503 + Retry-After.
 *  2. Writes are upserts keyed by a business key (App ID, Series, Setting), never blind
 *     creates — a retried commit after a partial failure re-writes the same row instead
 *     of duplicating a ledger line.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ZohoRecord {
  recordID: string
  data: Record<string, unknown>
}

export class ZohoApiError extends Error {
  constructor(op: string, status: number, body: string) {
    super(`${op} → HTTP ${status}: ${body.slice(0, 300)}`)
  }
}
export class ZohoLockedError extends Error {
  constructor(readonly retryAfterSec = 300) {
    super('Zoho Tables rate-limit lock engaged — retry shortly')
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Budget {
  private hits: number[] = []
  constructor(private readonly max: number) {}
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.hits = this.hits.filter((t) => now - t < 60_000)
      if (this.hits.length < this.max) {
        this.hits.push(now)
        return
      }
      await sleep(this.hits[0]! + 60_000 - now + 25)
    }
  }
}

interface ClientOpts {
  fetchImpl?: FetchLike
  baseId?: string
  env?: Record<string, string | undefined>
  /** Page size for fetchAll; default 1000 (the documented maximum). */
  page?: number
}

export class ZohoClient {
  private readonly f: FetchLike
  private readonly baseId: string
  private readonly env: Record<string, string | undefined>
  private readonly page: number
  private readonly reads = new Budget(26)
  private readonly writes = new Budget(17)
  private token: { value: string; expiresAt: number } | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: ClientOpts = {}) {
    this.f = opts.fetchImpl ?? fetch
    this.env = opts.env ?? process.env
    this.baseId = opts.baseId ?? this.env.ZOHO_BASE_ID ?? ''
    this.page = opts.page ?? 1000
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 120_000) return this.token.value
    const p = new URLSearchParams({
      refresh_token: this.env.ZOHO_REFRESH_TOKEN ?? '',
      client_id: this.env.ZOHO_CLIENT_ID ?? '',
      client_secret: this.env.ZOHO_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
    })
    const res = await this.f('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })
    const j = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) throw new ZohoApiError('token refresh', res.status, JSON.stringify(j))
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 }
    return this.token.value
  }

  /** One raw call. `kind` picks the budget; everything is serialized so budgets hold. */
  private async call(
    kind: 'read' | 'write',
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown> {
    const run = async () => {
      await (kind === 'read' ? this.reads : this.writes).take()
      const url = new URL(`https://${this.env.ZOHO_DC ?? 'tables.zoho.in'}/api/v1${path}`)
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      const res = await this.f(url.toString(), {
        method,
        headers: { Authorization: 'Zoho-oauthtoken ' + (await this.accessToken()) },
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        /* non-JSON body — treat as opaque text */
      }
      if (res.status === 429 || /limit|lock/i.test(text.slice(0, 400))) {
        throw new ZohoLockedError()
      }
      const err = errorOf(body)
      if (err && res.status >= 400) throw new ZohoApiError(`${method} ${path}`, res.status, text)
      return body
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  async fetchAll(tableId: string, fieldIds?: string[]): Promise<ZohoRecord[]> {
    const out: ZohoRecord[] = []
    let cursor: string | undefined
    for (;;) {
      const j = (await this.call('read', 'POST', '/fetchRecordsWithCriteria', {
        base_id: this.baseId,
        table_id: tableId,
        count: this.page,
        ...(fieldIds ? { field_ids: JSON.stringify(fieldIds) } : {}),
        ...(cursor ? { reference_record_id: cursor } : {}),
      })) as Record<string, any>
      const page = recordsFrom(j)
      out.push(...page)
      if (page.length < this.page) return out
      cursor = page[page.length - 1]!.recordID
    }
  }

  async upsertByKey(
    tableId: string,
    keyFieldId: string,
    keyValue: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const data: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue
      data[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    await this.call('write', 'PUT', '/records', {
      base_id: this.baseId,
      table_id: tableId,
      data: JSON.stringify(data),
      criteria: JSON.stringify([`${keyFieldId}`, '=', keyValue]),
      is_upsert_needed: true,
      is_ids_used_in_params: true,
      is_ids_used_in_data: true,
      first_match_only: true,
    })
  }

  async deleteRecord(tableId: string, recordId: string): Promise<void> {
    await this.call('write', 'DELETE', '/records', {
      base_id: this.baseId,
      table_id: tableId,
      record_id: recordId,
    })
  }
}

function errorOf(body: unknown): string | null {
  const b = body as Record<string, any> | null
  const e = b?.error ?? b?.records?.error
  return e ? `${e.code ?? ''} ${e.message ?? ''}` : null
}

function recordsFrom(j: Record<string, any>): ZohoRecord[] {
  const recs = j?.records?.fetched ?? j?.records?.data ?? j?.data?.records ?? j?.fetched
  if (!Array.isArray(recs)) {
    throw new ZohoApiError('fetchRecordsWithCriteria', 200, JSON.stringify(j).slice(0, 300))
  }
  return recs.map((r: Record<string, any>) => ({
    recordID: String(r.recordID ?? r.recordId ?? ''),
    data: (r.data ?? {}) as Record<string, unknown>,
  }))
}
```

Note on `criteria`: the documented examples are strings like `"Month" = "March"`. Field-ID criteria are enabled by `is_ids_used_in_params`; the probe (Task 4) verifies the exact shape and Step 5 there adjusts `upsertByKey` if the array form is rejected.

- [ ] **Step 5: Run tests until green**

```bash
npm test
```

Expected: 3 passed. Then `npx tsc -b` → exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): zoho tables client with budgets, cursor paging, keyed upserts"
```

---

### Task 3: Scratch base

**Files:**
- Create: `scripts/zoho/make-scratch.mjs`

**Interfaces:**
- Consumes: `../.zoho.env`, `../.zoho-token.json` pattern from `build-tables.mjs`; verified duplicate-table contract.
- Produces: scratch base id recorded in `.env` as `ZOHO_BASE_ID` (until Task 12 switches it back). Table IDs in the scratch base are NEW ids — everything downstream reads ids from the scratch base itself via `topup-state.json` (Task 5 re-lists fields there).

**Manual prerequisite (user, one minute, API cannot create bases — server 500s):** in the Zoho Tables UI, create an **empty base named `Roligt Fork Scratch`** in the same workspace. Copy its id from the URL (`.../base/<id>/...`). The script takes it as an argument.

- [ ] **Step 1: Write `scripts/zoho/make-scratch.mjs`** (reuses build-tables' token/throttle pattern; reads table names from `tables-state.json`):

```js
#!/usr/bin/env node
/** Duplicates the 30 built tables (structure only) into the scratch base. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..', '..')
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const TARGET = process.argv[2]
if (!TARGET) {
  console.error('usage: node scripts/zoho/make-scratch.mjs <scratch-base-id>')
  process.exit(1)
}
const SOURCE = 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const STATE_F = join(ROOT, 'scratch-state.json')
const state = existsSync(STATE_F) ? JSON.parse(readFileSync(STATE_F, 'utf8')) : {}
const save = () => writeFileSync(STATE_F, JSON.stringify(state, null, 2))

const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({
    refresh_token: ENV.refresh_token, client_id: ENV.client_id,
    client_secret: ENV.client_secret, grant_type: 'refresh_token',
  })
  const r = await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })
  const j = await r.json()
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j))
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastMut = 0
async function api(method, path, params = {}) {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`) }
}

const names = Object.keys(JSON.parse(readFileSync(join(ROOT, 'tables-state.json'), 'utf8')).tables)
const existing = (await api('GET', '/tables', { base_id: TARGET })).tables.fetched.map((t) => t.name)
for (const name of names) {
  if (state[name]) { console.log(`= ${name}`); continue }
  if (existing.includes(name)) { console.log(`! ${name} already in scratch`); state[name] = true; save(); continue }
  const src = JSON.parse(readFileSync(join(ROOT, 'tables-state.json'), 'utf8')).tables[name].id
  const j = await api('POST', '/tables', {
    base_id: TARGET, table_id: src, table_name: name, is_duplicate_with_records: false,
  })
  const e = j?.error || j?.tables?.error
  if (e) throw new Error(`${name}: ${JSON.stringify(e)}`)
  state[name] = true
  save()
  console.log(`+ ${name}`)
}
console.log('done — scratch base ready:', TARGET)
```

- [ ] **Step 2: Run it**

```bash
node scripts/zoho/make-scratch.mjs <scratch-base-id>
```

Expected: 30 `+` lines (or `=` on re-run); takes ~2 minutes at the write throttle. On failure the state file makes it resumable — just re-run.

- [ ] **Step 3: Point the fork's server env at the scratch base**

Set `ZOHO_BASE_ID=<scratch-base-id>` in `.env`, and fill `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET`/`ZOHO_REFRESH_TOKEN` by copying the matching values from `../.zoho.env` (`client_id`/`client_secret`/`refresh_token`).

- [ ] **Step 4: Commit**

```bash
git add scripts/zoho/make-scratch.mjs scripts/zoho/scratch-state.json && git commit -m "chore(zoho): scratch base bootstrap"
```

---

### Task 4: Live probe (go/no-go) — scratch base only

**Files:**
- Create: `scripts/zoho/probe.mjs`
- Create: `docs/zoho-fork-probe-results.md`

**Interfaces:**
- Consumes: `api/_lib/zoho.ts` (imported from the .mjs via a tiny ESM bridge is not possible across TS — so the probe re-implements thin raw calls; that is intentional, the probe validates the RAW contract, the library then trusts it).
- Produces: pinned answers to: (a) upsert-by-criteria shape, (b) fetch page shape + cursor, (c) numeric/string values, (d) large (~8 KB) query-param payloads, (e) criteria-by-field-id. If (a) or (b) disagree with `zoho.ts`, fix the library here and add a fixture test.

- [ ] **Step 1: Write `scripts/zoho/probe.mjs`**:

```js
#!/usr/bin/env node
/** Live probe of the read/upsert contracts against the SCRATCH base. Prints PASS/FAIL per check. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..', '..')
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const BASE = process.env.ZOHO_BASE_ID || (existsSync(join(ROOT, '..', '..', '.env'))
  ? Object.fromEntries(readFileSync(join(ROOT, '..', '..', '.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])).ZOHO_BASE_ID
  : '')
if (!BASE) { console.error('set ZOHO_BASE_ID (scratch!) first'); process.exit(1) }

const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({ refresh_token: ENV.refresh_token, client_id: ENV.client_id,
    client_secret: ENV.client_secret, grant_type: 'refresh_token' })
  const j = await (await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })).json()
  if (!j.access_token) throw new Error('token refresh failed')
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastMut = 0
async function raw(method, path, params) {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: null, text } }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// scratch Vendors table id + its primary field (Name) — read live
const tables = (await raw('GET', '/tables', { base_id: BASE })).json.tables.fetched
const vendors = tables.find((t) => t.name === 'Vendors')
const vfields = (await raw('GET', '/fields', { base_id: BASE, table_id: vendors.tableID })).json.fields.fetched
const nameField = vfields.find((f) => f.isPrimary)
const fid = (f) => f.fieldID ?? f.fieldid ?? f.id
const fname = (f) => f.fieldName ?? f.name
const phoneField = vfields.find((f) => fname(f) === 'Phone')

// 1. upsert by criteria on the PRIMARY field, string + then numeric-ish value
let r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(nameField)]: 'PROBE VENDOR', ...(phoneField ? { [fid(phoneField)]: '99999 00000' } : {}) }),
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
})
check('upsert-by-name-criteria', r.json?.status === 'success', JSON.stringify(r.json).slice(0, 160))

// 2. fetch it back via criteria
r = await raw('POST', '/fetchRecordsWithCriteria', {
  base_id: BASE, table_id: vendors.tableID,
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`, count: 10,
})
const fetched = r.json?.records?.fetched ?? r.json?.records?.data
check('fetch-by-criteria', Array.isArray(fetched) && fetched.length >= 1, JSON.stringify(r.json).slice(0, 200))

// 3. fetch page shape without criteria + cursor continuation
r = await raw('POST', '/fetchRecordsWithCriteria', { base_id: BASE, table_id: vendors.tableID, count: 2 })
const page1 = r.json?.records?.fetched ?? r.json?.records?.data
check('fetch-page-shape', Array.isArray(page1), `page1 keys: ${JSON.stringify(Object.keys(r.json?.records || {}))}`)
if (Array.isArray(page1) && page1.length === 2) {
  const r2 = await raw('POST', '/fetchRecordsWithCriteria', {
    base_id: BASE, table_id: vendors.tableID, count: 2,
    reference_record_id: page1[1].recordID ?? page1[1].recordId,
  })
  const page2 = r2.json?.records?.fetched ?? r2.json?.records?.data
  const first = (page1[0].recordID ?? page1[0].recordId)
  const p2first = Array.isArray(page2) && page2.length ? (page2[0].recordID ?? page2[0].recordId) : null
  check('cursor-continuation', p2first && p2first !== first, `page2 first: ${p2first}`)
}

// 4. large payload through a query param (~8 KB) on the upsert data
const big = 'x'.repeat(8192)
r = await raw('PUT', '/records', {
  base_id: BASE, table_id: vendors.tableID,
  data: JSON.stringify({ [fid(phoneField ?? nameField)]: big }),
  criteria: `"${fname(nameField)}" = "PROBE VENDOR"`,
  is_upsert_needed: true, is_ids_used_in_data: true,
})
check('large-query-payload', r.json?.status === 'success', `HTTP ${r.status}`)

// 5. read the record back and confirm the big value survived (truncated print)
r = await raw('POST', '/fetchRecordsWithCriteria', {
  base_id: BASE, table_id: vendors.tableID, criteria: `"${fname(nameField)}" = "PROBE VENDOR"`, count: 1,
})
const rec = (r.json?.records?.fetched ?? r.json?.records?.data || [])[0]
const dataStr = JSON.stringify(rec?.data ?? rec ?? {})
check('large-payload-roundtrip', dataStr.includes('xxxx'), dataStr.slice(0, 120))

writeFileSync(join(ROOT, '..', '..', 'docs', 'zoho-fork-probe-results.md'),
  `# Probe results — ${new Date().toISOString()}\n\n| check | ok |\n|---|---|\n` +
  results.map((x) => `| ${x.name} | ${x.ok ? 'yes' : '**NO**'} |`).join('\n') +
  `\n\nRaw first-record shape:\n\n\`\`\`json\n${JSON.stringify(rec, null, 2).slice(0, 2000)}\n\`\`\`\n`)

const failed = results.filter((x) => !x.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall checks passed')
process.exit(failed.length ? 1 : 0)
```

- [ ] **Step 2: Run against the scratch base**

```bash
export ZOHO_BASE_ID=<scratch-base-id>   # same value as .env — double-check it is NOT the production id
node scripts/zoho/probe.mjs
```

Expected: all checks PASS and `docs/zoho-fork-probe-results.md` written.

- [ ] **Step 3: Reconcile with the library**

Compare the raw record shape in the results doc against `recordsFrom` and the `criteria` shape against `upsertByKey`:
- If fetch returns a different array key → fix `recordsFrom` and add the shape as a second fixture in `zoho.test.ts`.
- If the string criteria `"Field" = "value"` worked but the library's array form is rejected → change `upsertByKey` to build `"${keyFieldId}" = "${keyValue}"` (keep `is_ids_used_in_params: true` only if probe (a) proved field-ID criteria; otherwise criteria must use the field NAME — pass it in).
- Re-run `npm test`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "spike(zoho): live probe pins fetch/upsert contracts"
```

**Go/no-go:** if `upsert-by-name-criteria` or `fetch-page-shape` cannot be made to pass, STOP — report to the user; the BFF design needs revisiting before any mapper work.

---

### Task 5: Base top-up — App ID + Data JSON + Sticker Prints + revision row

**Files:**
- Create: `scripts/zoho/topup.mjs` (writes `scripts/zoho/topup-state.json`)

**Interfaces:**
- Consumes: verified `/fields` create+rename pattern; table ids from `tables-state.json` (production names) or live `/tables` listing of the target base.
- Produces: every table gets fields `App ID` (text, 23) and `Data JSON` (text, 23) unless `Data JSON` already exists; a new `Sticker Prints` table; `Config` rows `app_revision=0` and `app_config={}`. `topup-state.json` maps `table → { id, appId, dataJson, fields }` — Task 6 consumes it.

- [ ] **Step 1: Write `scripts/zoho/topup.mjs`**:

```js
#!/usr/bin/env node
/**
 * Top-up for the fork: App ID + Data JSON on every table, a Sticker Prints table,
 * and the revision/config rows. Resumable via topup-state.json.
 *
 * usage: node scripts/zoho/topup.mjs <base-id>
 * Target the SCRATCH base first. The production run is Task 12, on explicit user go.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CW = join(ROOT, '..', '..', '..')
const TARGET = process.argv[2]
if (!TARGET) { console.error('usage: node scripts/zoho/topup.mjs <base-id>'); process.exit(1) }
const ENV = Object.fromEntries(
  readFileSync(join(CW, '.zoho.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const STATE_F = join(ROOT, 'topup-state.json')
const state = existsSync(STATE_F) ? JSON.parse(readFileSync(STATE_F, 'utf8')) : { tables: {} }
const save = () => writeFileSync(STATE_F, JSON.stringify(state, null, 2))

const TOKEN_F = join(CW, '.zoho-token.json')
let tok = existsSync(TOKEN_F) ? JSON.parse(readFileSync(TOKEN_F, 'utf8')) : null
async function token() {
  if (tok && tok.at + (tok.expires_in - 240) * 1000 > Date.now()) return tok.access_token
  const p = new URLSearchParams({ refresh_token: ENV.refresh_token, client_id: ENV.client_id,
    client_secret: ENV.client_secret, grant_type: 'refresh_token' })
  const j = await (await fetch('https://accounts.zoho.in/oauth/v2/token?' + p, { method: 'POST' })).json()
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j))
  tok = { access_token: j.access_token, at: Date.now(), expires_in: j.expires_in || 3600 }
  writeFileSync(TOKEN_F, JSON.stringify(tok))
  return tok.access_token
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastMut = 0
async function api(method, path, params = {}) {
  const gap = 3600 - (Date.now() - lastMut)
  if (method !== 'GET' && gap > 0) await sleep(gap)
  if (method !== 'GET') lastMut = Date.now()
  const url = new URL('https://tables.zoho.in/api/v1' + path)
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  const res = await fetch(url, { method, headers: { Authorization: 'Zoho-oauthtoken ' + (await token()) } })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`) }
  const e = j?.error || Object.values(j || {}).map((n) => n && n.error).find(Boolean)
  if (e) throw new Error(`${method} ${path}: ${JSON.stringify(e)}`)
  return j
}
const fid = (f) => f.fieldID ?? f.fieldid ?? f.id
const fname = (f) => f.fieldName ?? f.name

async function fieldsOf(tableId) {
  const fs = (await api('GET', '/fields', { base_id: TARGET, table_id: tableId })).fields.fetched
  return fs
}
async function ensureTextField(tableId, tableName, label) {
  const st = state.tables[tableName]
  if (st.fields[label]) return st.fields[label]
  const created = (await api('POST', '/fields', { base_id: TARGET, table_id: tableId, type: 23 })).fields.created[0]
  const id = fid(created)
  await api('PUT', '/fields', { base_id: TARGET, table_id: tableId, field_id: id, field_name: label, type: 23 })
  st.fields[label] = id
  save()
  console.log(`  + ${tableName}.${label}`)
  return id
}

const listing = (await api('GET', '/tables', { base_id: TARGET })).tables.fetched

// 1. App ID + (missing) Data JSON on every existing table
for (const t of listing) {
  if (!state.tables[t.name]) state.tables[t.name] = { id: t.tableID, fields: {} }
  const st = state.tables[t.name]
  const fs = await fieldsOf(t.tableID)
  for (const f of fs) {
    const n = fname(f)
    if (n && !st.fields[n]) st.fields[n] = fid(f)
  }
  save()
  if (!st.appId) st.appId = await ensureTextField(t.tableID, t.name, 'App ID')
  if (!st.fields['Data JSON'] && !['Counters', 'Config'].includes(t.name)) {
    st.dataJson = await ensureTextField(t.tableID, t.name, 'Data JSON')
  }
  save()
  console.log(`= ${t.name}`)
}

// 2. Sticker Prints table (fork-owned, absent from the base)
if (!listing.find((t) => t.name === 'Sticker Prints')) {
  const created = (await api('POST', '/tables', { base_id: TARGET, table_name: 'Sticker Prints' })).tables.created[0]
  state.tables['Sticker Prints'] = { id: created.tableID, fields: {} }
  save()
  console.log('+ Sticker Prints table')
  const st = state.tables['Sticker Prints']
  for (const label of ['Doc No', 'Stage', 'Title', 'Printed At', 'Qty']) {
    const c = (await api('POST', '/fields', { base_id: TARGET, table_id: st.id, type: 23 })).fields.created[0]
    await api('PUT', '/fields', { base_id: TARGET, table_id: st.id, field_id: fid(c), field_name: label, type: 23 })
    st.fields[label] = fid(c)
    save()
  }
  st.appId = await ensureTextField(st.id, 'Sticker Prints', 'App ID')
  st.dataJson = st.fields['Data JSON'] = await ensureTextField(st.id, 'Sticker Prints', 'Data JSON')
}

// 3. Config rows: app_revision / app_config
const cfg = state.tables['Config']
const settingId = cfg.fields['Setting']
const valueId = cfg.fields['Value']
const existingCfg = await api('POST', '/fetchRecordsWithCriteria', {
  base_id: TARGET, table_id: cfg.id, criteria: JSON.stringify([]), count: 1000,
})
// find (settings may not exist yet) — fall back to writing unconditionally via upsert
const seedRow = async (setting, value) => {
  await api('PUT', '/records', {
    base_id: TARGET, table_id: cfg.id,
    data: JSON.stringify({ [settingId]: setting, [valueId]: value }),
    criteria: `"Setting" = "${setting}"`,
    is_upsert_needed: true, is_ids_used_in_data: true,
  })
  console.log(`= Config row ${setting}`)
}
await seedRow('app_revision', '0')
await seedRow('app_config', '{}')
save()
console.log('top-up complete →', STATE_F)
```

- [ ] **Step 2: Run on the scratch base**

```bash
node scripts/zoho/topup.mjs <scratch-base-id>
```

Expected: ~60 writes ≈ 4 minutes; each table logs `=` and new fields log `+`. Re-runs are no-ops.

- [ ] **Step 3: Verify**

```bash
node -e "const s=require('./scripts/zoho/topup-state.json');const bad=Object.entries(s.tables).filter(([n,t])=>!t.appId||(!t.dataJson&&!['Counters','Config'].includes(n)));console.log(bad.length? 'MISSING: '+bad.map(b=>b[0]).join(', '):'all tables have App ID + Data JSON')"
```

Expected: `all tables have App ID + Data JSON`.

- [ ] **Step 4: Commit**

```bash
git add scripts/zoho/topup.mjs scripts/zoho/topup-state.json && git commit -m "feat(zoho): base top-up — App ID, Data JSON, Sticker Prints, revision row"
```

---

### Task 6: Generate `api/_lib/baseSchema.ts`

**Files:**
- Create: `scripts/zoho/gen-base-schema.mjs`
- Create (generated): `api/_lib/baseSchema.ts`
- Test: `api/_lib/baseSchema.test.ts`

**Interfaces:**
- Consumes: `scripts/zoho/topup-state.json` (scratch ids — the schema travels with whichever base was topped up; Task 12 regenerates for production).
- Produces (consumed by Tasks 9/10):

```ts
export const BASE_ID: string
export interface TableRef { name: string; id: string; appId: string; dataJson?: string; fields: Record<string, string> }
export const T: Record<string, TableRef>   // keys are the BASE table names, e.g. T['GRNs']
export const TABLE_FOR: Record<string, string>  // supabase table name ('grns') → base table name ('GRNs')
```

- [ ] **Step 1: Write the generator** — `scripts/zoho/gen-base-schema.mjs`:

```js
#!/usr/bin/env node
/** Emits api/_lib/baseSchema.ts from topup-state.json. Regenerate after any base change. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const st = JSON.parse(readFileSync(join(ROOT, 'topup-state.json'), 'utf8'))

// supabase table name → base table name (the 22 collections + ledger + audits)
const TABLE_FOR = {
  vendor_types: 'Vendor Types', vendors: 'Vendors', customers: 'Customers',
  purchase_products: 'Purchase Products', storage_locations: 'Storage Locations',
  items: 'Items', products: 'Products', melanges: 'Melanges', grns: 'GRNs',
  batches: 'Batches', packing_runs: 'Packing Runs', orders: 'Orders',
  order_lines: 'Order Lines', qcs: 'QC Records', dispatches: 'Dispatches',
  stock_issues: 'Stock Issues', lab_reports: 'Lab Reports',
  test_parameters: 'Test Parameters', sticker_templates: 'Sticker Templates',
  sticker_prints: 'Sticker Prints', staff: 'Staff', shifts: 'Shifts',
  attendance: 'Attendance', production_plans: 'Production Plans',
  ledger: 'Ledger', audits: 'Audit Log',
}

const entries = Object.entries(st.tables)
  .map(([name, t]) => `  ${JSON.stringify(name)}: ${JSON.stringify({ name, id: t.id, appId: t.appId, ...(t.dataJson ? { dataJson: t.dataJson } : {}), fields: t.fields })},`)
  .join('\n')

const out = `// GENERATED by scripts/zoho/gen-base-schema.mjs — do not edit by hand.
export interface TableRef {
  name: string
  id: string
  appId: string
  dataJson?: string
  fields: Record<string, string>
}

export const BASE_ID = ${JSON.stringify(process.env.ZOHO_BASE_ID ?? '')}

export const T: Record<string, TableRef> = {
${entries}
}

export const TABLE_FOR: Record<string, string> = ${JSON.stringify(TABLE_FOR, null, 2)}
`
writeFileSync(join(ROOT, '..', '..', 'api', '_lib', 'baseSchema.ts'), out)
console.log('wrote api/_lib/baseSchema.ts with', Object.keys(st.tables).length, 'tables')
```

- [ ] **Step 2: Generate and sanity-test** — `api/_lib/baseSchema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { T, TABLE_FOR } from './baseSchema'

describe('baseSchema (generated)', () => {
  it('covers every collection the app syncs, with App ID + Data JSON where required', () => {
    for (const [supa, base] of Object.entries(TABLE_FOR)) {
      const t = T[base]
      expect(t, base).toBeDefined()
      expect(t.appId, `${base}.appId`).toBeTruthy()
      if (!['Counters', 'Config'].includes(base)) expect(t.dataJson, `${base}.dataJson`).toBeTruthy()
    }
    expect(TABLE_FOR.grns).toBe('GRNs')
    expect(TABLE_FOR.ledger).toBe('Ledger')
  })
})
```

```bash
export ZOHO_BASE_ID=<scratch-base-id>
node scripts/zoho/gen-base-schema.mjs && npm test
```

Expected: generator logs 31 tables; test passes (4 = schema test + 3 zoho client).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(api): generated base schema bindings"
```

---

### Task 7: Kinde client wiring + dev fallback

**Files:**
- Create: `src/lib/authToken.ts`
- Modify: `src/context/AuthContext.tsx` (full rewrite), `src/pages/Login.tsx` (full rewrite), `src/main.tsx`

**Interfaces:**
- Produces (same interface pages already use — no page changes):
  - `AuthContextValue` unchanged: `{ session, ready, role, isAdmin, signIn, sendPasswordReset, signOut }` — `session` becomes `{ user: { email: string } } | null` (a structural subset of the old Supabase `Session`, so any `session?.user?.email` use keeps compiling).
  - `src/lib/authToken.ts`: `setAuthToken(t: string | null): void`, `getAuthToken(): string | null` — Task 9's `dbApi` reads it.
- Kinde envs (client): `VITE_KINDE_DOMAIN`, `VITE_KINDE_CLIENT_ID`, `VITE_KINDE_REDIRECT_URI`, `VITE_KINDE_LOGOUT_URI`. Absent → dev fallback session (role via `localStorage.devRole`, default `Admin`), which keeps every later task runnable before the Kinde account exists.

**User-side prerequisite (only when leaving dev fallback):** in Kinde: create business → add SPA application with redirect `http://localhost:3000` and logout `http://localhost:3000`; create roles **Admin** and **Operator**; invite users and assign roles. Put the values in `.env.local`.

- [ ] **Step 1: `src/lib/authToken.ts`**:

```ts
/** Hand-off between the auth layer and dbApi: the BFF token of the signed-in user. */
let token: string | null = null
export function setAuthToken(next: string | null): void {
  token = next
}
export function getAuthToken(): string | null {
  return token
}
```

- [ ] **Step 2: Rewrite `src/context/AuthContext.tsx`**:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Role } from '../types'
import { setAuthToken } from '../lib/authToken'

/** A structural subset of the old Supabase session — everything the app reads from it. */
export interface SessionLike {
  user: { email: string }
}

interface AuthContextValue {
  session: SessionLike | null
  ready: boolean
  /** Unknown until the provider resolved it; treated as Operator until then. */
  role: Role
  isAdmin: boolean
  /** Starts the Kinde hosted login (arguments kept for interface stability). */
  signIn: (email: string, password: string) => Promise<string | null>
  /** Kinde owns password resets; this tells the user where to go. */
  sendPasswordReset: (email: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const KINDE_CONFIGURED = Boolean(
  import.meta.env.VITE_KINDE_DOMAIN && import.meta.env.VITE_KINDE_CLIENT_ID,
)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionLike | null>(null)
  const [role, setRole] = useState<Role>('Operator')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!KINDE_CONFIGURED) {
      // Dev fallback: no Kinde account yet. Role is switchable from the login screen.
      const email = 'dev@roligt.local'
      const saved = localStorage.getItem('devRole')
      const devRole: Role = saved === 'Operator' || saved === 'Admin' ? saved : 'Admin'
      setSession({ user: { email } })
      setRole(devRole)
      setAuthToken(null) // BFF runs with ALLOW_DEV_SESSION=1
      setReady(true)
      return
    }
    let cancelled = false
    void (async () => {
      // The SDK is loaded dynamically so the fallback path has no Kinde code at all.
      const { getKindeSession } = await import('../lib/kindeSession')
      try {
        const s = await getKindeSession()
        if (cancelled) return
        setSession(s.session)
        setRole(s.role)
        setAuthToken(s.token)
      } catch {
        if (!cancelled) setSession(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async () => {
    if (KINDE_CONFIGURED) {
      const { login } = await import('../lib/kindeSession')
      await login()
      return null // the browser leaves for the hosted page
    }
    return null // fallback session is always signed in
  }, [])

  const sendPasswordReset = useCallback(async () => {
    return 'Passwords are managed in Kinde — ask an administrator to reset it.'
  }, [])

  const signOut = useCallback(async () => {
    if (KINDE_CONFIGURED) {
      const { logout } = await import('../lib/kindeSession')
      await logout()
      return
    }
    localStorage.removeItem('devRole')
    location.reload()
  }, [])

  return (
    <AuthContext.Provider
      value={{ session, ready, role, isAdmin: role === 'Admin', signIn, sendPasswordReset, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function setDevRole(role: Role) {
  localStorage.setItem('devRole', role)
}
```

- [ ] **Step 3: Create `src/lib/kindeSession.ts`** (the only file that touches the SDK):

```ts
/**
 * The one file that talks to Kinde. Loaded only when VITE_KINDE_* is configured.
 *
 * Roles: Kinde issues the access token with a `roles` claim (array of role keys)
 * for users assigned roles in the Kinde admin. 'Admin' (case-insensitive) maps to
 * the app's Admin; everything else is an Operator.
 */
import type { Role } from '../types'
import { KINDE_CONFIGURED } from '../context/AuthContext'
import type { SessionLike } from '../context/AuthContext'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kinde: any = null

async function sdk() {
  if (!kinde) {
    const mod = await import('@kinde-oss/kinde-auth-react')
    kinde = mod
  }
  return kinde
}

export interface KindeSession {
  session: SessionLike | null
  role: Role
  token: string | null
}

export async function getKindeSession(): Promise<KindeSession> {
  if (!KINDE_CONFIGURED) throw new Error('Kinde is not configured')
  // The SDK exposes hooks for React; outside components we use the underlying client
  // through the provider's singleton, read via the package's `getKindeClient`.
  const mod = await sdk()
  const client = mod.getKindeClient?.() ?? mod.kindeClient
  const token = await client.getToken()
  if (!token) return { session: null, role: 'Operator', token: null }
  const user = await client.getUser()
  const claims = await client.getClaims()
  const rolesClaim = (claims?.roles?.value ?? []) as Array<string | { key: string; name: string }>
  const roles = rolesClaim.map((r) => (typeof r === 'string' ? r : r.key || r.name))
  const role: Role = roles.some((r) => r.toLowerCase() === 'admin') ? 'Admin' : 'Operator'
  return {
    session: { user: { email: user?.email ?? 'unknown@user' } },
    role,
    token,
  }
}

export async function login(): Promise<void> {
  const mod = await sdk()
  // In-app the Login page triggers the SDK's own login via window location; the
  // provider exposes `login` through its hook. Outside React we fall back to the
  // authorization endpoint directly.
  const client = mod.getKindeClient?.() ?? mod.kindeClient
  await client.login({ appState: { path: location.pathname } })
}

export async function logout(): Promise<void> {
  const mod = await sdk()
  const client = mod.getKindeClient?.() ?? mod.kindeClient
  await client.logout()
}
```

NOTE for the implementer: the SDK's non-React surface differs across versions; if `getKindeClient` does not exist in the installed version, mount a hidden `<KindeBridge/>` inside `KindeProvider` (main.tsx, below) that calls `useKindeAuth()` once and re-exports the three functions through module-level variables — same public shape, no other file changes. Verify with `npm run build` and a manual login run before moving on.

- [ ] **Step 4: `src/main.tsx`** — wrap conditionally:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { KindeProvider } from '@kinde-oss/kinde-auth-react'
import { App } from './App'
import { AuthProvider, KINDE_CONFIGURED } from './context/AuthContext'
import './index.css'

const root = createRoot(document.getElementById('root')!)

const tree = (
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
)

root.render(
  KINDE_CONFIGURED ? (
    <KindeProvider
      clientId={import.meta.env.VITE_KINDE_CLIENT_ID}
      domain={import.meta.env.VITE_KINDE_DOMAIN}
      redirectUri={import.meta.env.VITE_KINDE_REDIRECT_URI}
      logoutUri={import.meta.env.VITE_KINDE_LOGOUT_URI}
    >
      {tree}
    </KindeProvider>
  ) : (
    tree
  ),
)
```

(Keep whatever PWA/service-worker registration `main.tsx` currently does — add it around this render exactly as the original file has it.)

- [ ] **Step 5: Rewrite `src/pages/Login.tsx`**:

```tsx
import { useState } from 'react'
import { OfflineBar } from '../components/PwaPrompts'
import { useAuth, setDevRole, KINDE_CONFIGURED } from '../context/AuthContext'
import type { Role } from '../types'

export function Login() {
  const { signIn, session, role } = useAuth()
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    const message = await signIn('', '')
    if (message) setError(message)
  }

  return (
    <div className="login-page">
      <div className="login-offline">
        <OfflineBar />
      </div>
      <div className="card login-card">
        <div className="section-head">
          <div>
            <h3>Roligt Foods</h3>
            <span>Sign in to Operations Control</span>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {KINDE_CONFIGURED ? (
            <button className="btn primary" type="submit">
              Sign in with Kinde
            </button>
          ) : (
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Dev session — role</label>
              <select
                value={role}
                onChange={(e) => {
                  setDevRole(e.target.value as Role)
                  location.reload()
                }}
              >
                <option value="Admin">Admin</option>
                <option value="Operator">Operator</option>
              </select>
              <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                Dev fallback active (no Kinde env). You are {session?.user.email}.
              </span>
            </div>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Verify**

```bash
npx tsc -b && npm run lint && npm run build
```

Then `npm run dev` and open the app — the login screen shows the dev role picker; picking Operator and reloading keeps you signed in as `dev@roligt.local`. (The Supabase client is still imported by `dbApi.ts` — that is expected until Task 9; the dummy env keeps it quiet.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(auth): kinde wiring with dev fallback session"
```

---

### Task 8: BFF auth guard

**Files:**
- Create: `api/_lib/auth.ts`, `api/_lib/auth.test.ts`

**Interfaces:**
- Consumes: request `Authorization: Bearer <jwt>`; env `KINDE_DOMAIN`, `KINDE_AUDIENCE?`, `ALLOW_DEV_SESSION`.
- Produces (consumed by Tasks 9/10):

```ts
export interface Caller { email: string; role: 'Admin' | 'Operator' }
export async function authenticate(req: Request): Promise<Caller>   // throws AuthError(401)
export class AuthError extends Error { status: 401 }
```

- [ ] **Step 1: Failing test** — `api/_lib/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, exportJWK, importJWK } from 'jose'
import { authenticate, AuthError } from './auth'

const ISSUER = 'https://roligt.kinde.com'

async function makeToken(roles: string[]) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
  return { token, jwk }
}

describe('authenticate', () => {
  it('maps the roles claim to Admin and passes the email through', async () => {
    const { token, jwk } = await makeToken(['Admin'])
    process.env.KINDE_DOMAIN = ISSUER
    process.env.ALLOW_DEV_SESSION = ''
    const mod = await import('./auth')
    mod.__setJwks({ keys: [jwk] }) // test hook: skip network JWKS fetch
    const caller = await authenticate(new Request('/api/revision', {
      headers: { Authorization: `Bearer ${token}` },
    }))
    expect(caller.role).toBe('Admin')
  })

  it('rejects a missing token with AuthError', async () => {
    process.env.KINDE_DOMAIN = ISSUER
    process.env.ALLOW_DEV_SESSION = ''
    await expect(authenticate(new Request('/api/revision'))).rejects.toBeInstanceOf(AuthError)
  })

  it('issues the dev session when ALLOW_DEV_SESSION=1 and no token is present', async () => {
    process.env.KINDE_DOMAIN = ISSUER
    process.env.ALLOW_DEV_SESSION = '1'
    const caller = await authenticate(new Request('/api/revision', { headers: { 'X-Dev-Role': 'Operator' } }))
    expect(caller).toEqual({ email: 'dev@roligt.local', role: 'Operator' })
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npm test` → FAIL (module missing).

- [ ] **Step 3: Implement** — `api/_lib/auth.ts`:

```ts
/**
 * Who is calling the BFF. With Kinde configured, the bearer JWT is verified against
 * the tenant's JWKS and the roles claim decides Admin/Operator. Without a token and
 * with ALLOW_DEV_SESSION=1 (local `vercel dev` only), a dev session is issued so the
 * app is runnable before the Kinde tenant exists. The guard is the RLS of this fork:
 * every endpoint calls it, and the commit endpoint refuses operator writes to
 * admin-only tables based on exactly this decision.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'

export class AuthError extends Error {
  readonly status = 401 as const
}

export interface Caller {
  email: string
  role: 'Admin' | 'Operator'
}

let jwksOverride: { keys: unknown[] } | null = null
/** Test hook — replaces the network JWKS fetch. */
export function __setJwks(jwks: { keys: unknown[] } | null): void {
  jwksOverride = jwks
}

const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksFor(issuer: string) {
  const url = new URL(issuer)
  const key = url.origin
  if (!jwkSets.has(key)) jwkSets.set(key, createRemoteJWKSet(new URL(url.origin + '/openid/jwks')))
  return jwkSets.get(key)!
}

export async function authenticate(req: Request): Promise<Caller> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    if (process.env.ALLOW_DEV_SESSION === '1') {
      return { email: 'dev@roligt.local', role: req.headers.get('x-dev-role') === 'Operator' ? 'Operator' : 'Admin' }
    }
    throw new AuthError('Sign in first.')
  }

  const issuer = (process.env.KINDE_DOMAIN ?? '').replace(/\/$/, '')
  if (!issuer) throw new AuthError('Auth is not configured on the server.')
  try {
    const { payload } = await jwtVerify(token, jwksOverride ?? jwksFor(issuer), {
      issuer,
      ...(process.env.KINDE_AUDIENCE ? { audience: process.env.KINDE_AUDIENCE } : {}),
    })
    const rolesClaim = payload.roles
    const roles = Array.isArray(rolesClaim)
      ? rolesClaim.map((r) => (typeof r === 'string' ? r : String((r as { key?: string; name?: string }).key ?? (r as { name?: string }).name ?? '')))
      : []
    return {
      email: typeof payload.email === 'string' ? payload.email : 'unknown@user',
      role: roles.some((r) => r.toLowerCase() === 'admin') ? 'Admin' : 'Operator',
    }
  } catch (e) {
    throw new AuthError(`Invalid session (${(e as Error).message}). Sign in again.`)
  }
}
```

- [ ] **Step 4: Tests green + gates** — `npm test && npx tsc -b && npm run lint`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): kinde jwks auth guard with dev session"
```

---

### Task 9: Snapshot + revision endpoints, client transport swap

**Files:**
- Create: `api/_lib/mappers.ts`, `api/_lib/snapshot.ts`, `api/snapshot.ts`, `api/revision.ts`, `api/_lib/snapshot.test.ts`
- Modify (rewrite): `src/lib/dbApi.ts`
- Delete: `src/lib/supabaseClient.ts`
- Modify: `src/lib/tables.ts` (only: keep exports; remove nothing — it has no supabase import)

**Interfaces:**
- Consumes: `ZohoClient`, `baseSchema`, `COLLECTIONS` + `collectionOf` from `src/lib/tables`, `migrateState` behavior (partial states are fine — verified).
- Produces:
  - `GET /api/snapshot` → `{ state: Partial<AppState> | null, revision: number }`
  - `GET /api/revision` → `{ revision: number }`
  - `src/lib/dbApi.ts` keeps its exact public surface: `fetchRevision(): Promise<number>`, `fetchDb(): Promise<DbSnapshot>`, `saveDb(next, prev): Promise<SaveResult>` (saveDb's network half lands in Task 10; until then it throws 'not wired').

- [ ] **Step 1: Read mappers** — `api/_lib/mappers.ts`:

```ts
/**
 * Doc ⇄ base rows.
 *
 * Reads are uniform: every table yields App ID + Data JSON, which is exactly the
 * (id, data) contract the Supabase client had — the app's own `fetchDb` shape. Writes
 * additionally fill the table's real columns (best-effort enrichment for Analytics and
 * link fields), but reads never depend on them, so a missing or wrong column can never
 * corrupt the app — only a report.
 */
import type { ZohoRecord } from './zoho'
import type { TableRef } from './baseSchema'
import type { Grn, LedgerEntry, AuditEntry, Vendor, PurchaseProduct, StorageLocation, Item } from '../../src/types'
import { ledgerFromRow } from '../../src/lib/tables'

/** One row → the app document it stores. */
export function rowToDoc(table: TableRef, r: ZohoRecord): Record<string, unknown> | null {
  const raw = r.data[table.dataJson!]
  if (raw === undefined || raw === null || raw === '') return null
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface LinkMaps {
  vendors: Map<string, string>              // vendor app id → zoho record id
  purchaseProducts: Map<string, string>
  storageLocations: Map<string, string>    // keyed by BOTH app id and ledger name
  items: Map<string, string>               // keyed by BOTH app id and item name
}

/** Build link maps from the master rows of a snapshot (App ID + Data JSON already read). */
export function buildLinkMaps(
  vendors: ZohoRecord[],
  purchaseProducts: ZohoRecord[],
  storageLocations: ZohoRecord[],
  items: ZohoRecord[],
  t: { vendors: TableRef; purchaseProducts: TableRef; storageLocations: TableRef; items: TableRef },
): LinkMaps {
  const byAppId = (rows: ZohoRecord[], table: TableRef) =>
    new Map(rows.map((r) => [String(r.data[table.appId] ?? ''), r.recordID]))
  const vendors_ = byAppId(vendors, t.vendors)
  const pp = byAppId(purchaseProducts, t.purchaseProducts)
  const loc = byAppId(storageLocations, t.storageLocations)
  const itm = byAppId(items, t.items)
  for (const r of storageLocations) {
    const doc = rowToDoc(t.storageLocations, r) as { name?: string } | null
    if (doc?.name) loc.set(doc.name, r.recordID)
  }
  for (const r of items) {
    const doc = rowToDoc(t.items, r) as { name?: string } | null
    if (doc?.name) itm.set(doc.name, r.recordID)
  }
  return { vendors: vendors_, purchaseProducts: pp, storageLocations: loc, items: itm }
}

const s = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))
const n = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v))

/** Best-effort real columns. Unknown field names in the base are skipped silently. */
export function columnsFor(
  key: string,
  doc: Record<string, unknown>,
  links: LinkMaps,
): Record<string, string> {
  const link = (m: Map<string, string>, id: unknown) => {
    const v = s(id)
    return v ? m.get(v) : undefined
  }
  switch (key) {
    case 'vendors': {
      const v = doc as unknown as Vendor
      return { Name: s(v.name), Phone: s(v.phone), Area: s(v.area), 'Payment Terms': s(v.payment), Status: s(v.status), Email: s(v.email), Notes: s(v.notes) }
    }
    case 'purchaseProducts': {
      const p = doc as unknown as PurchaseProduct
      return { Name: s(p.name), 'Default UOM': s(p.uom) }
    }
    case 'storageLocations': {
      const l = doc as unknown as StorageLocation
      return { Name: s(l.name), Label: s(l.label), Holds: s(l.holds), Type: s(l.type), Status: s(l.status) }
    }
    case 'items': {
      const i = doc as unknown as Item
      return { Name: s(i.name), Type: s(i.type), UOM: s(i.uom), 'Lot Controlled': i.lotControlled ? 'true' : 'false', 'Reorder Level': n(i.reorder), 'Cost Method': s(i.costMethod) }
    }
    case 'grns': {
      const g = doc as unknown as Grn
      return {
        'Doc No': s(g.id), Date: s(g.date), UOM: s(g.uom), Area: s(g.area), 'Harvested On': s(g.harvestedOn),
        Total: n(g.total), Accepted: n(g.accepted), Free: n(g.free), 'Grade A': n(g.a), 'Grade B': n(g.b), 'Grade C': n(g.c),
        Reject: n(g.reject), Rate: n(g.rate), 'Other Charges': n(g.transport), Status: s(g.status), Notes: s(g.notes),
        Vendor: link(links.vendors, g.farmerId), Product: link(links.purchaseProducts, g.purchaseProductId),
        Location: g.location ? links.storageLocations.get(g.location) : undefined,
      }
    }
    default:
      return {}
  }
}

/** Ledger rows arrive from the client in the flat snake_case shape `ledgerToRow` emits. */
export function ledgerColumns(row: Record<string, unknown>, links: LinkMaps): Record<string, string> {
  const l: LedgerEntry = ledgerFromRow(row)
  return {
    Doc: l.doc, Type: l.type, Lot: l.lot, Status: l.status,
    'Qty In': n(l.qtyIn), 'Qty Out': n(l.qtyOut), 'Unit Cost': n(l.unitCost),
    Expiry: s(l.expiry), Time: l.time,
    Item: link(links.items, l.item), Location: link(links.storageLocations, l.location),
  }
}

export function auditColumns(row: Record<string, unknown>): Record<string, string> {
  const a = row as unknown as AuditEntry
  return { Doc: a.doc, Action: a.action, Details: a.details, Actor: a.role, Time: a.time }
}
```

- [ ] **Step 2: Failing snapshot test** — `api/_lib/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { assembleState } from './snapshot'
import type { ZohoRecord } from './zoho'

const T = {
  GRNs: { name: 'GRNs', id: 't-grn', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Vendors: { name: 'Vendors', id: 't-ven', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Ledger: { name: 'Ledger', id: 't-led', appId: 'f-app', dataJson: 'f-data', fields: {} },
  'Audit Log': { name: 'Audit Log', id: 't-aud', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Counters: { name: 'Counters', id: 't-cnt', appId: 'f-app', fields: { Series: 'f-series', Next: 'f-next' }, dataJson: undefined },
  Config: { name: 'Config', id: 't-cfg', appId: 'f-app', fields: { Setting: 'f-set', Value: 'f-val' }, dataJson: undefined },
} as const

const rec = (appId: string, json: unknown, extra: Record<string, unknown> = {}): ZohoRecord => ({
  recordID: 'z-' + appId,
  data: { 'f-app': appId, ...(json === undefined ? {} : { 'f-data': JSON.stringify(json) }), ...extra },
})

describe('assembleState', () => {
  it('maps collections, ledger, audits, counters and config back into the app shape', () => {
    const state = assembleState(T as never, {
      grns: [rec('GRN-1', { id: 'GRN-1', lot: 'LOT-1', total: 100 })],
      vendors: [rec('V-1', { id: 'V-1', name: 'Sriram' })],
      ledger: [rec('L-1', { id: 'L-1', type: 'GRN', qtyIn: 100 })],
      audits: [rec('A-1', { id: 'A-1', action: 'posted' })],
      counters: [
        { recordID: 'c1', data: { 'f-series': 'grn', 'f-next': '5' } },
        { recordID: 'c2', data: { 'f-series': 'period:lot', 'f-next': '20260909' } },
      ],
      config: [
        { recordID: 'k1', data: { 'f-set': 'app_config', 'f-val': JSON.stringify({ company: 'Roligt' }) } },
        { recordID: 'k2', data: { 'f-set': 'app_revision', 'f-val': '7' } },
      ],
    })
    expect(state.state?.grns?.[0]?.lot).toBe('LOT-1')
    expect(state.state?.vendors?.[0]?.name).toBe('Sriram')
    expect(state.state?.ledger?.[0]?.qtyIn).toBe(100)
    expect(state.state?.audits?.[0]?.action).toBe('posted')
    expect((state.state?.counters as Record<string, number>)?.grn).toBe(5)
    expect(state.state?.counterPeriods?.lot).toBe('20260909')
    expect((state.state?.config as Record<string, unknown>)?.company).toBe('Roligt')
    expect(state.revision).toBe(7)
    expect(state.everWritten).toBe(true)
  })

  it('returns null state when nothing was ever posted', () => {
    const state = assembleState(T as never, {
      grns: [], vendors: [], ledger: [], audits: [], counters: [], config: [],
    })
    expect(state.state).toBeNull()
    expect(state.everWritten).toBe(false)
  })
})
```

- [ ] **Step 3: Run** — `npm test` → FAIL (`assembleState` missing).

- [ ] **Step 4: Implement** — `api/_lib/snapshot.ts`:

```ts
/**
 * Reads the base back into the app's own snapshot shape. Reads only ever use
 * App ID + Data JSON, so the fork's read path is byte-for-byte the contract the
 * Supabase client had (id, data) — `migrateState` fills any collection not yet
 * mapped from seed defaults, which is what lets the GRN slice ship before the rest.
 */
import type { ZohoClient, ZohoRecord } from './zoho'
import { T, TABLE_FOR } from './baseSchema'
import { rowToDoc } from './mappers'
import { COLLECTIONS } from '../../src/lib/tables'
import type { AppState } from '../../src/types'

export interface Assembled {
  state: Partial<AppState> | null
  revision: number
  everWritten: boolean
}

export type SnapshotRows = Record<string, ZohoRecord[]>

/** AppState is keyed by collection KEY (vendorTypes), not table name (vendor_types). */
function stateKeyFor(supa: string): string | null {
  if (supa === 'ledger' || supa === 'audits') return supa
  return COLLECTIONS.find((c) => c.table === supa)?.key ?? null
}

export function assembleState(schema: typeof T, rows: SnapshotRows): Assembled {
  const state: Partial<AppState> = {}
  // collections — including ledger and audits, whose Data JSON already holds the
  // document in its final shape — all read the same way
  for (const [supa, base] of Object.entries(TABLE_FOR)) {
    const table = schema[base]
    const key = stateKeyFor(supa)
    if (!table?.dataJson || !rows[supa] || !key) continue
    const docs = rows[supa]
      .map((r) => rowToDoc(table, r))
      .filter((d): d is Record<string, unknown> => d !== null)
    ;(state as Record<string, unknown>)[key] = docs
  }
  // audit reads newest-first, the order the in-memory list has always been kept in
  if (state.audits) state.audits = [...state.audits].sort((a, b) => b.time.localeCompare(a.time))

  const counters: Record<string, number> = {}
  const counterPeriods: Record<string, string> = {}
  const cnt = schema['Counters']
  for (const r of rows.counters ?? []) {
    const key = String(r.data[cnt.fields['Series']] ?? '')
    const value = String(r.data[cnt.fields['Next']] ?? '')
    if (!key) continue
    if (key.startsWith('period:')) counterPeriods[key.slice(7)] = value
    else counters[key] = Number(value) || 0
  }
  if (Object.keys(counters).length) state.counters = counters as AppState['counters']
  if (Object.keys(counterPeriods).length) state.counterPeriods = counterPeriods

  let revision = 0
  const cfg = schema['Config']
  for (const r of rows.config ?? []) {
    const setting = String(r.data[cfg.fields['Setting']] ?? '')
    const value = String(r.data[cfg.fields['Value']] ?? '')
    if (setting === 'app_revision') revision = Number(value) || 0
    if (setting === 'app_config' && value) {
      try { state.config = JSON.parse(value) as AppState['config'] } catch { /* leave unset */ }
    }
    if (setting.startsWith('period:')) counterPeriods[setting.slice(7)] = value
  }

  const everWritten =
    revision > 0 ||
    (state.ledger?.length ?? 0) > 0 ||
    Object.keys(TABLE_FOR).some((k) => ((state as Record<string, unknown>)[k] as unknown[] | undefined)?.length)

  return { state: everWritten ? state : null, revision, everWritten }
}

/** Reads every mapped table (App ID + Data JSON only) and assembles the snapshot. */
export async function readSnapshot(zoho: ZohoClient): Promise<Assembled> {
  const schema = T
  const rows: SnapshotRows = {}
  await Promise.all(
    Object.entries(TABLE_FOR).map(async ([supa, base]) => {
      const table = schema[base]
      if (!table) return
      rows[supa] = await zoho.fetchAll(table.id, [table.appId, ...(table.dataJson ? [table.dataJson] : [])])
    }),
  )
  rows.counters = await zoho.fetchAll(schema['Counters'].id, [schema['Counters'].fields['Series'], schema['Counters'].fields['Next']])
  rows.config = await zoho.fetchAll(schema['Config'].id, [schema['Config'].fields['Setting'], schema['Config'].fields['Value']])
  return assembleState(schema, rows)
}

/** Reads just the revision number (one row) — the client's 20-second poll. */
export async function readRevision(zoho: ZohoClient): Promise<number> {
  const cfg = T['Config']
  const rows = await zoho.fetchAll(cfg.id, [cfg.fields['Setting'], cfg.fields['Value']])
  for (const r of rows) {
    if (String(r.data[cfg.fields['Setting']]) === 'app_revision') return Number(r.data[cfg.fields['Value']]) || 0
  }
  return 0
}
```

- [ ] **Step 5: Tests green, then the endpoints.** `npm test` → pass. Then `api/revision.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoClient } from './_lib/zoho'
import { authenticate, AuthError } from './_lib/auth'
import { readRevision } from './_lib/snapshot'
import { toWebRequest } from './_lib/vercel'

module.exports = async function (req: VercelRequest, res: VercelResponse) {
  try {
    await authenticate(toWebRequest(req))
    const revision = await readRevision(new ZohoClient())
    res.status(200).json({ revision })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    res.status(503).json({ error: (e as Error).message })
  }
}
```

with `api/_lib/vercel.ts`:

```ts
import type { VercelRequest } from '@vercel/node'

/** Vercel's req → standard Request, for the auth guard. */
export function toWebRequest(req: VercelRequest): Request {
  const url = `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  })
}
```

`api/snapshot.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoClient } from './_lib/zoho'
import { authenticate, AuthError } from './_lib/auth'
import { readSnapshot } from './_lib/snapshot'
import { toWebRequest } from './_lib/vercel'

module.exports = async function (req: VercelRequest, res: VercelResponse) {
  try {
    await authenticate(toWebRequest(req))
    const snap = await readSnapshot(new ZohoClient())
    res.status(200).json({ state: snap.state, revision: snap.revision })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    res.status(503).json({ error: (e as Error).message })
  }
}
```

- [ ] **Step 6: Rewrite `src/lib/dbApi.ts`** (same exports; saveDb body arrives in Task 10):

```ts
/**
 * Reading and writing the plant — Zoho Tables edition.
 *
 * Everything the Supabase version did through its SDK now goes over three BFF
 * endpoints; the shapes are unchanged (`fetchDb` returns the same DbSnapshot,
 * `saveDb` the same SaveResult), so AppContext, the offline queue and the diff
 * engine keep working untouched. The BFF holds the Zoho credentials; the browser
 * only ever holds the caller's own session token.
 */
import { diffState, type StateChanges } from './sync'
import { COLLECTIONS } from './tables'
import type { AppState } from '../types'
import { getAuthToken } from './authToken'

async function api(path: string, init?: RequestInit): Promise<Response> {
  const token = getAuthToken()
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 503) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60
    throw new ThrottledError(retryAfter)
  }
  return res
}

export class ThrottledError extends Error {
  constructor(public retryAfterSec: number) {
    super('The server is busy — your change is saved on this device and will retry.')
  }
}

export async function fetchRevision(): Promise<number> {
  const res = await api('/api/revision')
  if (!res.ok) throw new Error(`Failed to read revision: ${await res.text()}`)
  const j = (await res.json()) as { revision: number }
  return Number(j.revision) || 0
}

export interface DbSnapshot {
  state: Partial<AppState> | null
  revision: number
}

export async function fetchDb(): Promise<DbSnapshot> {
  const res = await api('/api/snapshot')
  if (!res.ok) throw new Error(`Failed to read the plant: ${await res.text()}`)
  return (await res.json()) as DbSnapshot
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'forbidden'; message: string }
  | { ok: false; reason: 'error'; message: string }

export async function saveDb(next: AppState, prev: AppState | null): Promise<SaveResult> {
  const changes: StateChanges = diffState(prev, next)
  if (changes.empty) return { ok: true, revision: await fetchRevision() }
  const res = await api('/api/commit', {
    method: 'POST',
    body: JSON.stringify({ changes }),
  })
  if (res.ok) {
    const j = (await res.json()) as { revision: number }
    return { ok: true, revision: Number(j.revision) || 0 }
  }
  if (res.status === 403) {
    const j = (await res.json()) as { error?: string; table?: string }
    return {
      ok: false,
      reason: 'forbidden',
      message: j.error ?? `You do not have permission to change ${(j.table ?? 'this data').replace(/_/g, ' ')}.`,
    }
  }
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return { ok: false, reason: 'error', message: j.error ?? `commit failed (HTTP ${res.status})` }
}

/** Kept for the admin-only early check the domains use. */
export const writableByOperator = (table: string) =>
  !COLLECTIONS.find((c) => c.table === table)?.adminOnly
```

Delete `src/lib/supabaseClient.ts` and remove any remaining import (`grep -rn supabaseClient src/` must return nothing). Then check `grep -rn "@supabase" src/ api/` — expected: no hits. `npm uninstall @supabase/supabase-js`.

- [ ] **Step 7: Gates + manual check**

```bash
npx tsc -b && npm run lint && npm test && npm run build
```

Then run the BFF locally and read the scratch base through the app:

```bash
npm i -g vercel   # if missing
vercel dev --listen 3000 &
# in another shell, open http://localhost:3000 — dev fallback session, then check:
curl -s http://localhost:3000/api/revision -H 'x-dev-role: Admin'
```

Expected: `{"revision":0}`. The app loads with seed masters (migrateState fills unmapped collections); the Procurement page opens.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(api+app): snapshot/revision endpoints; dbApi over the BFF"
```

---

### Task 10: Commit endpoint

**Files:**
- Create: `api/_lib/commit.ts`, `api/commit.ts`, `api/_lib/commit.test.ts`

**Interfaces:**
- Consumes: `StateChanges` (from `src/lib/sync`), `COLLECTIONS`/`collectionOf` (from `src/lib/tables`), `ZohoClient.upsertByKey/deleteRecord/fetchAll`, `columnsFor/ledgerColumns/auditColumns/buildLinkMaps`, `Caller`.
- Produces: `POST /api/commit` body `{ changes: StateChanges }` → `200 { revision }` | `403 { error, table }` | `503` (+`Retry-After: 300`) | `400 { error }`.

- [ ] **Step 1: Failing tests** — `api/_lib/commit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { commitChanges, Forbidden } from './commit'
import type { ZohoClient, ZohoRecord } from './zoho'
import type { Caller } from './auth'

type Upsert = { table: string; key: string; values: Record<string, string> }

function fakeZoho(existing: ZohoRecord[] = []) {
  const ops: { upserts: Upsert[]; deletes: { table: string; recordId: string }[] } = { upserts: [], deletes: [] }
  const zoho = {
    fetchAll: async (tableId: string) => existing.filter((r) => r.data.__table === tableId),
    upsertByKey: async (tableId: string, keyFieldId: string, keyValue: string, values: Record<string, unknown>) => {
      ops.upserts.push({ table: tableId, key: keyValue, values: values as Record<string, string> })
    },
    deleteRecord: async (tableId: string, recordId: string) => {
      ops.deletes.push({ table: tableId, recordId })
    },
  } as unknown as ZohoClient
  return { zoho, ops }
}

const admin: Caller = { email: 'boss@roligt.local', role: 'Admin' }
const operator: Caller = { email: 'op@roligt.local', role: 'Operator' }

const CHANGES = {
  empty: false,
  tables: [
    { table: 'grns', upsert: [{ id: 'GRN-2026-0001', data: { id: 'GRN-2026-0001', lot: 'LOT-1', farmerId: 'V-1', total: 100, accepted: 90, status: 'Posted' } }], remove: [] },
    {
      table: 'ledger',
      upsert: [{ id: 'L1', type: 'GRN', doc: 'GRN-2026-0001', item: 'Tender Coconut', item_type: 'Raw Material', lot: 'LOT-1', location: 'Cold Room', status: 'In Stock', qty_in: 90, qty_out: 0, uom: 'Piece', unit_cost: 35, at: '2026-09-21T08:00:00Z' }],
      remove: [],
    },
    { table: 'audits', upsert: [{ id: 'A1', at: '2026-09-21T08:00:00Z', actor: 'Admin', action: 'posted', doc: 'GRN-2026-0001', details: '90 accepted' }], remove: [] },
  ],
  counters: { grn: 1 },
  config: undefined,
}

describe('commitChanges', () => {
  it('writes doc + ledger + audit + counter + revision, all keyed upserts', async () => {
    const { zoho, ops } = fakeZoho()
    const rev = await commitChanges(zoho, admin, CHANGES)
    expect(rev).toBe(1)
    const keys = ops.upserts.map((u) => u.key)
    expect(keys).toContain('GRN-2026-0001')
    expect(keys).toContain('L1')
    expect(keys).toContain('A1')
    expect(keys).toContain('grn')           // counter by Series
    expect(keys).toContain('app_revision')  // bumped last
    expect(ops.deletes).toEqual([])
  })

  it('refuses operator writes to admin-only tables', async () => {
    const { zoho } = fakeZoho()
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [{ table: 'vendors', upsert: [{ id: 'V-1', data: {} }], remove: [] }] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('deletes removed rows by resolving App IDs to record IDs', async () => {
    const existing: ZohoRecord[] = [
      { recordID: 'z-9', data: { __table: 'T-GRNS', 'f-app': 'GRN-OLD' } },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await commitChanges(zoho, admin, {
      empty: false,
      tables: [{ table: 'grns', upsert: [], remove: ['GRN-OLD'] }],
      counters: {},
    })
    expect(ops.deletes).toEqual([{ table: 'T-GRNS', recordId: 'z-9' }])
  })
})
```

(The fake's `__table` values must match the ids in the schema fixture you import — in the real file, import `T` from `./baseSchema` and use `T['GRNs'].id` etc. instead of literals `T-GRNS`.)

- [ ] **Step 2: Run** — `npm test` → FAIL.

- [ ] **Step 3: Implement** — `api/_lib/commit.ts`:

```ts
/**
 * StateChanges → idempotent Zoho writes.
 *
 * Every write is an upsert keyed by the row's own business key (App ID, Series,
 * Setting), which is what makes a commit safe to retry after a partial failure: the
 * second attempt re-writes the same rows rather than duplicating ledger lines. The
 * revision row is bumped last so a reader either sees the old plant whole or the new
 * plant whole. Admin-only tables are refused for operators here — this is the RLS of
 * the fork, and the client maps the 403 to the same 'forbidden' message it always had.
 */
import type { ZohoClient } from './zoho'
import { ZohoLockedError } from './zoho'
import { T, TABLE_FOR } from './baseSchema'
import { columnsFor, ledgerColumns, auditColumns, buildLinkMaps } from './mappers'
import { COLLECTIONS } from '../../src/lib/tables'
import type { StateChanges } from '../../src/lib/sync'
import type { Caller } from './auth'

export class Forbidden extends Error {
  constructor(table: string) {
    super(`You do not have permission to change ${table.replace(/_/g, ' ')}.`)
  }
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

async function linkMaps(zoho: ZohoClient) {
  const grab = async (base: string) => zoho.fetchAll(T[base].id, [T[base].appId, ...(T[base].dataJson ? [T[base].dataJson] : [])])
  return buildLinkMaps(await grab('Vendors'), await grab('Purchase Products'), await grab('Storage Locations'), await grab('Items'), {
    vendors: T['Vendors'], purchaseProducts: T['Purchase Products'], storageLocations: T['Storage Locations'], items: T['Items'],
  })
}

export async function commitChanges(zoho: ZohoClient, caller: Caller, changes: StateChanges): Promise<number> {
  // 1. role gate — the RLS of this fork
  for (const change of changes.tables) {
    const spec = COLLECTIONS.find((c) => c.table === change.table)
    if (spec?.adminOnly && caller.role !== 'Admin') throw new Forbidden(change.table)
  }

  // 2. link maps for column enrichment (masters are small; four reads)
  const links = await linkMaps(zoho)

  // 3. collection rows — { id, data } upserts
  for (const change of changes.tables) {
    const base = TABLE_FOR[change.table]
    if (!base) throw new Error(`unknown table ${change.table}`)
    const table = T[base]
    // look the spec up by TABLE name (change.table is 'sticker_templates', the key is
    // 'stickerTemplates' — find-by-table is the one that is correct for both)
    const spec = COLLECTIONS.find((c) => c.table === change.table) ?? null

    for (const row of change.upsert) {
      const appId = String(row.id)
      let values: Record<string, unknown>
      if (change.table === 'ledger') {
        values = { [table.appId]: appId, ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}), ...ledgerColumns(row, links) }
      } else if (change.table === 'audits') {
        values = { [table.appId]: appId, ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}), ...auditColumns(row) }
      } else {
        const doc = (row as { data: Record<string, unknown> }).data
        values = {
          [table.appId]: appId,
          ...(table.dataJson ? { [table.dataJson]: JSON.stringify(doc) } : {}),
          ...columnsFor(spec!.key, doc, links),
        }
      }
      await zoho.upsertByKey(table.id, table.appId, appId, values)
    }

    if (change.remove.length) {
      const rows = await zoho.fetchAll(table.id, [table.appId])
      const byApp = new Map(rows.map((r) => [String(r.data[table.appId] ?? ''), r.recordID]))
      for (const id of change.remove) {
        const rid = byApp.get(String(id))
        if (rid) await zoho.deleteRecord(table.id, rid)
      }
    }
  }

  // 4. counters — upsert by Series (Next is a plain column)
  const counters = T['Counters']
  for (const [series, value] of Object.entries(changes.counters)) {
    await zoho.upsertByKey(counters.id, counters.fields['Series'], series, {
      [counters.fields['Series']]: series,
      [counters.fields['Next']]: String(value),
    })
  }

  // 5. config + counter periods
  const config = T['Config']
  if (changes.config) {
    await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_config', {
      [config.fields['Setting']]: 'app_config',
      [config.fields['Value']]: JSON.stringify(changes.config),
    })
  }

  // 6. revision, last
  const rows = await zoho.fetchAll(config.id, [config.fields['Setting'], config.fields['Value']])
  let current = 0
  for (const r of rows) {
    if (String(r.data[config.fields['Setting']]) === 'app_revision') current = Number(r.data[config.fields['Value']]) || 0
  }
  const next = current + 1
  await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_revision', {
    [config.fields['Setting']]: 'app_revision',
    [config.fields['Value']]: String(next),
  })
  return next
}

export { ZohoLockedError }
```

`api/commit.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ZohoClient, ZohoLockedError } from './_lib/zoho'
import { authenticate, AuthError } from './_lib/auth'
import { commitChanges, Forbidden } from './_lib/commit'
import { toWebRequest } from './_lib/vercel'
import type { StateChanges } from '../src/lib/sync'

module.exports = async function (req: VercelRequest, res: VercelResponse) {
  try {
    const caller = await authenticate(toWebRequest(req))
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { changes: StateChanges }
    if (!body?.changes?.tables) {
      res.status(400).json({ error: 'Malformed commit payload.' })
      return
    }
    const revision = await commitChanges(new ZohoClient(), caller, body.changes)
    res.status(200).json({ revision })
  } catch (e) {
    if (e instanceof AuthError) {
      res.status(401).json({ error: e.message })
      return
    }
    if (e instanceof Forbidden) {
      res.status(403).json({ error: e.message })
      return
    }
    if (e instanceof ZohoLockedError) {
      res.setHeader('Retry-After', String(e.retryAfterSec))
      res.status(503).json({ error: 'Zoho is rate-limited — the change is saved on this device and will retry.' })
      return
    }
    res.status(500).json({ error: (e as Error).message })
  }
}
```

- [ ] **Step 4: Tests + gates**

```bash
npm test && npx tsc -b && npm run lint
```

Expected: all green. (The commit test imports the generated `T` — if `upsertByKey` receives the table **name** instead of its id in the fake's ops, adjust the fake to map through `T`, not the implementation.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): idempotent commit endpoint with role gate and 503 backpressure"
```

---

### Task 11: Live end-to-end verification (scratch base)

**Files:**
- Create: `docs/zoho-fork-e2e-2026-09-21.md` (evidence log)

**Interfaces:** none — this is the milestone gate.

- [ ] **Step 1: Restart the stack clean**

```bash
vercel dev --listen 3000 &
sleep 8
curl -s http://localhost:3000/api/revision -H 'x-dev-role: Admin'
```

Expected: `{"revision":0}`.

- [ ] **Step 2: Headless browser pass (agent-browser CLI)**

Drive the app per the IAB automation rules (`dispatchEvent`, no blur-based logic; headless CLI):

1. Open `http://localhost:3000`, sign in via the dev picker as **Admin**.
2. Procurement → post a GRN: vendor, product, total/grades/rate — submit.
3. Assert: the register lists the new GRN; Inventory shows the lot with the accepted quantity; a ledger line exists (Ledger/trace view).
4. Assert `curl -s http://localhost:3000/api/revision -H 'x-dev-role: Admin'` now returns `{"revision":1}`.
5. Open a SECOND browser context (fresh profile → no localStorage), sign in, wait ≤25 s: the GRN appears without manual refresh (revision poll → snapshot).
6. Operator gate: sign in as **Operator** in a context, attempt a vendor edit on Settings → the app shows the admin-only message; `curl -X POST http://localhost:3000/api/commit -H 'content-type: application/json' -H 'x-dev-role: Operator' -d '{"changes":{"empty":false,"tables":[{"table":"vendors","upsert":[{"id":"V-1","data":{}}],"remove":[]}],"counters":{}}}'` → `403`.
7. Screenshot each pass into `gui-test-screenshots/zoho-fork/` (grn_posted.png, inventory_lot.png, second_session_sync.png, operator_forbidden.png).

- [ ] **Step 3: Write the evidence log** — `docs/zoho-fork-e2e-2026-09-21.md`: date, base id used (scratch), the seven checks with PASS/FAIL, and the screenshot names.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(e2e): GRN vertical slice live on scratch base"
```

**Gate:** any FAIL here blocks Task 12 and needs a fix + re-run, not a workaround.

---

### Task 12: Production base top-up and cutover  ⚠️ USER-GATED

**Files:**
- Modify: `.env` (`ZOHO_BASE_ID` → production)
- Regenerate: `api/_lib/baseSchema.ts` (production ids)

**Do not start this task without the user's explicit go** — it writes to the base other tools (Analytics, the Creator track) read.

- [ ] **Step 1: Ask the user.** Say exactly what will run (`node scripts/zoho/topup.mjs gerc53fe9f1e44e5f4a13809d9bd47367ba9d` — ~60 additive field creates + one new table + two Config rows, no data changes) and wait for confirmation.

- [ ] **Step 2: Top up the production base, regenerate schema, re-verify**

```bash
node scripts/zoho/topup.mjs gerc53fe9f1e44e5f4a13809d9bd47367ba9d
export ZOHO_BASE_ID=gerc53fe9f1e44e5f4a13809d9bd47367ba9d
node scripts/zoho/gen-base-schema.mjs
npm test
# set ZOHO_BASE_ID=gerc53fe9f1e44e5f4a13809d9bd47367ba9d in .env, restart vercel dev, re-run Task 11 Steps 1–2 quickly (smoke: revision + one GRN + second-session sync)
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore(zoho): production base top-up + schema cutover"
```

---

## Plan 2 (next, out of scope here)

1. Column enrichment for the remaining collections (the `columnsFor` switch grows: batches, packingRuns, orders + Order Lines child handling, qcs, dispatches, stockIssues, labReports, testParameters, stickerTemplates/prints, staff, shifts, attendance, productionPlans) — reads already work for all of them via Data JSON; only Analytics columns are missing.
2. Snapshot caching + delta reads (`Time >= last sync` on Ledger/Audit) as the ledger grows.
3. Kinde production tenant setup, `ALLOW_DEV_SESSION` off, Vercel project envs, deploy behind the user's go.
4. One-time Supabase data migration (blueprint §8 — DataPrep/manual CSV into the production base).

## Self-review notes (already applied)

- Spec §1–§6 each map to tasks: §1→T1/T9, §2→T7/T8, §3→T5/T6/T9, §4→T2/T10, §5→T3/T4, §6→T11/T12.
- One deliberate refinement over the spec, justified in T9: reads use only App ID + Data JSON (byte-identical to the old `(id, data)` contract); real columns are write-side enrichment. This preserves the spec's §3 intent (queryable columns exist for Analytics/links) while making round-trips lossless by construction.
- Rate-limit reality folded in from the probe docs: Create/Delete/Update 20/min, Fetch 30/min per API name — budgets in `zoho.ts` sit under them, and Task 9's snapshot does ~28 reads once per cold isolate (documented), not per request.
