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
  readonly retryAfterSec: number
  constructor(retryAfterSec = 300) {
    super('Zoho Tables rate-limit lock engaged — retry shortly')
    this.retryAfterSec = retryAfterSec
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Budget {
  private hits: number[] = []
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }
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
      const flat: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) flat[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
      }
      // The live probe (scripts/zoho/probe.mjs) pinned the transports: query params 414
      // somewhere between ~4 KB and ~8 KB of encoded value, a JSON body is a 400, and the
      // same params as an x-www-form-urlencoded body are accepted (8 KB verified). So big
      // non-GET requests travel in the body; reads and small writes stay on the query
      // string — both exactly the shapes the probe exercised.
      const encoded = new URLSearchParams(flat).toString()
      const useBody = method !== 'GET' && encoded.length > 2_000
      if (!useBody) {
        for (const [k, v] of Object.entries(flat)) url.searchParams.set(k, v)
      }
      const headers: Record<string, string> = {
        Authorization: 'Zoho-oauthtoken ' + (await this.accessToken()),
      }
      if (useBody) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const res = await this.f(url.toString(), {
        method,
        headers,
        ...(useBody ? { body: encoded } : {}),
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        /* non-JSON body — treat as opaque text */
      }
      // A lock is either the explicit 429 or an error payload complaining about limits.
      // Never scan healthy data for the words — a 200 whose records mention "limit" is fine.
      if (res.status === 429) throw new ZohoLockedError()
      const err = errorOf(body)
      if (err !== null && /limit|lock/i.test(err)) throw new ZohoLockedError()
      if (res.status >= 400 || err !== null) {
        throw new ZohoApiError(`${method} ${path}`, res.status, text)
      }
      return body
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  /**
   * Full rows, paged by cursor. No field selection: the live Task 9 check pinned that
   * `field_ids` is refused with 400 BAD REQUEST in every shape tried (JSON array
   * string and comma list, 2026-09-22 against the scratch base) while the same call
   * without it returns 200 — so callers pick their fields out of `data` by field id.
   */
  async fetchAll(tableId: string): Promise<ZohoRecord[]> {
    const out: ZohoRecord[] = []
    let cursor: string | undefined
    for (;;) {
      const j = (await this.call('read', 'POST', '/fetchRecordsWithCriteria', {
        base_id: this.baseId,
        table_id: tableId,
        count: this.page,
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
    // A quote or backslash inside keyValue would break the criteria string below — the
    // match silently fails and is_upsert_needed then CREATES a duplicate row instead of
    // erroring. No escape syntax is documented, so refuse loudly before any network call.
    if (/["\\]/.test(keyValue)) {
      throw new ZohoApiError('upsertByKey', 0, `key value must not contain quotes or backslashes: ${keyValue.slice(0, 60)}`)
    }
    const data: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue
      data[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    await this.call('write', 'PUT', '/records', {
      base_id: this.baseId,
      table_id: tableId,
      data: JSON.stringify(data),
      // The live probe pinned this: Zoho answers 500 to the JSON-array criteria and
      // accepts this string form built from the FIELD ID while is_ids_used_in_params
      // stays true (check names: criteria-array-shape, criteria-fieldid-string).
      // Business keys must not contain double quotes.
      criteria: `"${keyFieldId}" = "${keyValue}"`,
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
