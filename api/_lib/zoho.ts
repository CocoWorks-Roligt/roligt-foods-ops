/**
 * Zoho Tables v1 client for the BFF.
 *
 * Two things this file is deliberately paranoid about:
 *  1. Rate limits are global per API key and a breach locks the API for five minutes —
 *     the plant stops. So every call goes through the budget (26 reads, 17 writes per
 *     minute, under the published 30/20 — never raised) and a lock response becomes
 *     ZohoLockedError, which the commit endpoint surfaces as 503 + Retry-After.
 *     Reads are split into interactive and sweep pools (see ReadScope): the same
 *     global 26/min, with sweep reads self-capped at 18/min so the revision poll
 *     and commit pre-flights always have slots of their own.
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

/**
 * Which pool a read draws on. `interactive` is everything a person or a poll
 * waits on — the revision poll, commit pre-flights, admin reads — and it keeps
 * today's contract exactly (global 26/min, fail fast past maxWaitMs). `sweep` is
 * the snapshot's full-table reads: they also count against the global 26, but a
 * sweep read additionally admits into a self-restraint window capped at 18/min,
 * so interactive traffic is guaranteed at least 8 slots of every rolling minute
 * no matter how long a sweep runs. A sweep may wait up to 75s for its turn —
 * long enough that pacing alone (waiting for its own window to slide) never
 * throws, short enough to answer 503 + Retry-After when interactive traffic
 * genuinely starves it.
 *
 * `cold` is burst admission: a sweep read the 18/min self-cap will not refuse.
 * It still counts against the global 26 and still records into the sweep window,
 * so the next sweep paces itself — pace was bought, never headroom. The name is
 * the first sweep of a process (no substrate to delta off, no interactive
 * traffic of this process's own to protect), but any sweep may burst when its
 * sweep window is EMPTY (see canBurstSweep) — a re-sweep after a minute without
 * sweep reads rides the same admission, and the window the burst fills IS the
 * cooldown: back-to-back sweeps pace themselves exactly as before. A sweep is 26
 * reads; admitted at sweep pace that is 18 instant reads plus eight more spaced
 * out over the following minute — the ~60s GET /api/snapshot pinned on the dev
 * log, 2026-10-06, for cold starts and post-commit re-sweeps alike (the warm
 * re-sweep measured 63.6s the same day). Burst, the same 26 reads land in a few
 * seconds. An interactive call landing in that one minute waits for the window
 * to slide exactly as it waits behind any other sweep — or, when even that wait
 * would outlive maxWaitMs (the shared client's 45s), fails fast into
 * 503 + Retry-After, the answer the poll swallows and the save queue already
 * retries on. The burst's back edge is at most ~15s of refused reads, once per
 * burst; the minute of Loading it replaces was everyone's, every time.
 */
export type ReadScope = 'interactive' | 'sweep' | 'cold'

/**
 * How far past this clock a timestamp may sit and still be honest — the slack
 * any phone's skewed clock is allowed. It is the one grace three `at` gates
 * share, so they can never disagree: the commit shape gate refuses a ledger or
 * audit row dated beyond it (a future `at` parks the snapshot watermark where
 * no delta bucket ever reaches, and the sweep serves empty forever), the
 * watermark computation skips such rows when one is already stored (a hand edit
 * in the Zoho UI can still write one), and fetchSince refuses a watermark
 * beyond it outright, handing the sweep to its full read.
 */
export const FUTURE_AT_GRACE_MS = 5 * 60_000

class Budget {
  private hits: number[] = []
  private readonly max: number
  /** Waiting past this is somebody else's next request, not this one's turn. */
  private readonly maxWaitMs: number
  /** Sweep self-restraint: null on a budget that is not split (the writes
   * budget), set on the reads budget. See ReadScope. */
  private readonly sweepMax: number | null
  private sweepHits: number[] = []
  private readonly sweepMaxWaitMs: number
  constructor(max: number, maxWaitMs = 60_000, sweep: { max: number; maxWaitMs: number } | null = null) {
    this.max = max
    this.maxWaitMs = maxWaitMs
    this.sweepMax = sweep?.max ?? null
    this.sweepMaxWaitMs = sweep?.maxWaitMs ?? maxWaitMs
  }
  async take(scope: ReadScope = 'interactive'): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.hits = this.hits.filter((t) => now - t < 60_000)
      // sweep and cold both draw on the sweep window — only their admission differs
      const sweepScoped = scope !== 'interactive' && this.sweepMax !== null
      if (sweepScoped) {
        this.sweepHits = this.sweepHits.filter((t) => now - t < 60_000)
      }
      const globalFull = this.hits.length >= this.max
      const sweepFull = scope === 'sweep' && this.sweepMax !== null && this.sweepHits.length >= this.sweepMax
      if (!globalFull && !sweepFull) {
        this.hits.push(now)
        if (sweepScoped) this.sweepHits.push(now)
        return
      }
      // the earliest each full window frees a slot (25ms grace past the slide)
      const waitMs = Math.max(
        globalFull ? this.hits[0]! + 60_000 - now + 25 : 0,
        sweepFull ? this.sweepHits[0]! + 60_000 - now + 25 : 0,
      )
      // Sleeping to the front of the next minute is only honest inside a caller
      // that will still be alive when the wait ends. A serverless function with
      // a platform timeout would be killed mid-sleep, half-applied, with the
      // client none the wiser — better to hand the caller a retryable "busy"
      // (ZohoLockedError already maps to 503 + Retry-After) than a silent death.
      const patience = scope === 'interactive' ? this.maxWaitMs : this.sweepMaxWaitMs
      if (waitMs > patience) {
        throw new ZohoLockedError(Math.ceil(waitMs / 1000) + 5)
      }
      await sleep(waitMs)
    }
  }

  /** Whether a sweep starting now may burst (ReadScope 'cold'): the sweep
   *  window holds no hit from the last minute. The window a burst fills is the
   *  cooldown, so consecutive sweeps pace themselves — only interactive reads
   *  never cool it down. */
  canBurst(): boolean {
    if (this.sweepMax === null) return false
    const now = Date.now()
    this.sweepHits = this.sweepHits.filter((t) => now - t < 60_000)
    return this.sweepHits.length === 0
  }
}

interface ClientOpts {
  fetchImpl?: FetchLike
  baseId?: string
  env?: Record<string, string | undefined>
  /** Page size for fetchAll; default 1000 (the documented maximum). */
  page?: number
  /** Longest a call may sit waiting for budget before failing retryably. */
  maxWaitMs?: number
  /** HTTP calls allowed in flight at once; default 6. Caps the burst the pool
   *  can put on the wire — the per-minute budgets stay 26/17 whatever this is. */
  maxInflight?: number
  /** Sweep reads per minute inside the global read budget; default 18 (so
   *  interactive traffic is guaranteed the remaining ≥8 of 26). Test override —
   *  the production cap is a settled number, never raised past 26. */
  sweepReadsPerMin?: number
  /** Global reads per minute; default 26. Test override — the production cap is
   *  Zoho's own shared window and is never raised past 26 in production. */
  readsPerMin?: number
  /** Longest a sweep read may wait for budget; default 75s — past the 60s
   *  window slide, so pacing alone never throws, but bounded for 503s. */
  sweepMaxWaitMs?: number
}

export class ZohoClient {
  private readonly f: FetchLike
  /** Readable so the snapshot cache can tell one base's state from another's. */
  readonly baseId: string
  private readonly env: Record<string, string | undefined>
  private readonly page: number
  private readonly reads: Budget
  private readonly writes: Budget
  private token: { value: string; expiresAt: number } | null = null
  /** Single-flight refresh — without it, concurrent calls mint concurrent tokens. */
  private refreshing: Promise<string> | null = null
  /** Concurrency gate state — see call(). */
  private inflight = 0
  private readonly waiters: (() => void)[] = []
  private readonly maxInflight: number

  constructor(opts: ClientOpts = {}) {
    this.f = opts.fetchImpl ?? fetch
    this.env = opts.env ?? process.env
    this.baseId = opts.baseId ?? this.env.ZOHO_BASE_ID ?? ''
    this.page = opts.page ?? 1000
    this.reads = new Budget(opts.readsPerMin ?? 26, opts.maxWaitMs ?? 60_000, {
      max: opts.sweepReadsPerMin ?? 18,
      maxWaitMs: opts.sweepMaxWaitMs ?? 75_000,
    })
    this.writes = new Budget(17, opts.maxWaitMs ?? 60_000)
    this.maxInflight = opts.maxInflight ?? 6
  }

  /** True when a sweep starting now may burst — a minute with no sweep-scope
   *  reads (the process's first sweep, or a re-sweep after a quiet minute). The
   *  snapshot cache asks this to pick its gate shape; the burst it allows is
   *  still capped by the global 26 exactly as any sweep is. */
  canBurstSweep(): boolean {
    return this.reads.canBurst()
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 120_000) return this.token.value
    if (!this.refreshing) {
      const mint = async () => {
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
      this.refreshing = mint().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  /**
   * Concurrency gate: at most `maxInflight` HTTP calls in flight at once. A released
   * slot is handed straight to the longest-waiting caller (inflight stays counted
   * through the handoff), so the bound holds without re-checking.
   */
  private async acquire(): Promise<void> {
    if (this.inflight >= this.maxInflight) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      return // release() transferred its slot to us — inflight already counts this call
    }
    this.inflight++
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return // slot transferred, inflight unchanged
    }
    this.inflight--
  }

  /**
   * One raw call. `kind` picks the budget; admission is a concurrency pool, not a
   * queue: Budget.take()'s check-and-record is synchronous (no await between
   * testing the window and claiming a hit), so parallel callers cannot overspend
   * it — but they also no longer wait out each other's HTTP transit. The old
   * everything-through-one-chain serialization is what made a 26-call snapshot
   * sweep occupy the client for its whole ~30s duration: any small request
   * landing mid-sweep (an admin audit, a commit pre-flight) queued behind all of
   * it. Budget is taken BEFORE the slot so a call sleeping out a rate-limit
   * window holds no concurrency while it waits.
   */
  private async call(
    kind: 'read' | 'write',
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    scope: ReadScope = 'interactive',
  ): Promise<unknown> {
    const run = async () => {
      await (kind === 'read' ? this.reads.take(scope) : this.writes.take())
      await this.acquire()
      try {
        return await this.transact(method, path, params)
      } finally {
        this.release()
      }
    }
    return run()
  }

  private async transact(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown> {
    {
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
  }

  /**
   * Full rows, paged by cursor. No field selection: the live Task 9 check pinned that
   * `field_ids` is refused with 400 BAD REQUEST in every shape tried (JSON array
   * string and comma list, 2026-09-22 against the scratch base) while the same call
   * without it returns 200 — so callers pick their fields out of `data` by field id.
   * `scope` decides which read pool the pages draw on — a snapshot sweep passes
   * 'sweep' so its bulk reads cannot starve the poll and the pre-flights.
   */
  async fetchAll(tableId: string, opts: { scope?: ReadScope } = {}): Promise<ZohoRecord[]> {
    const out: ZohoRecord[] = []
    let cursor: string | undefined
    for (;;) {
      const j = (await this.call(
        'read',
        'POST',
        '/fetchRecordsWithCriteria',
        {
          base_id: this.baseId,
          table_id: tableId,
          count: this.page,
          ...(cursor ? { reference_record_id: cursor } : {}),
        },
        opts.scope,
      )) as Record<string, any>
      const page = recordsFrom(j)
      out.push(...page)
      if (page.length < this.page) return out
      cursor = page[page.length - 1]!.recordID
    }
  }

  /**
   * The rows whose Data JSON mentions a timestamp at or past a watermark — the delta
   * read behind the snapshot sweep, so a 100,000-line ledger costs one read instead
   * of a hundred.
   *
   * The criteria grammar is `=` and `contains` on TEXT columns, nothing else — pinned
   * live against the scratch base 2026-09-30 (scripts/zoho/probe-since.mjs —
   * result papers since removed, git history): `>=`, `>`, `starts_with`, `like` all answer
   * HTTP 200 wrapping INTERNAL SERVER ERROR, and EVERY operator on a date-typed
   * column is refused, `=` included. So the delta is a `contains` over the Data JSON
   * column (text) keyed by hour buckets taken from the watermark: one read per hour
   * of gap, criteria `"jRNMfg" contains "2026-09-30T07"`. A bucket re-reads the whole
   * hour, so the boundary row at the watermark re-merges — the merge is idempotent
   * by App ID, and a false-positive superset (some other JSON value mentioning the
   * hour) merges away too. A gap wider than maxBuckets (default 6 hours) throws
   * ZohoApiError; the caller falls back to a full fetchAll — the same handling as a
   * wrapped-error refusal, one path.
   *
   * The watermark is the max `at` already held, and it must be UTC: the bucket
   * strings come from the JSON's ISO-8601 Zulu timestamps (nowISO()), which sort and
   * slice chronographically. The Time COLUMN is useless as a watermark source — it
   * normalizes on read-back (`2026-09-30T07:00:00.000Z` becomes "2026/09/30 07:00:00").
   */
  async fetchSince(
    tableId: string,
    jsonFieldId: string,
    sinceISO: string,
    opts: { scope?: ReadScope; maxBuckets?: number } = {},
  ): Promise<ZohoRecord[]> {
    // same guard as upsertByKey: a quote or backslash in the watermark would break
    // the criteria silently — matching nothing, or worse, everything
    if (/["\\]/.test(sinceISO)) {
      throw new ZohoApiError('fetchSince', 0, `watermark must not contain quotes or backslashes: ${sinceISO.slice(0, 60)}`)
    }
    const since = Date.parse(sinceISO)
    if (Number.isNaN(since)) {
      throw new ZohoApiError('fetchSince', 0, `watermark is not a date: ${sinceISO.slice(0, 60)}`)
    }
    // A watermark dated in the future (a crafted row's `at`, before the gates
    // learned it) puts every hour bucket PAST endHour: the loop below would run
    // zero times and answer [] — a delta that looks healthy while it serves
    // empty forever. Refusing costs the sweep its full read, which recomputes
    // the watermark from rows the grace actually admits.
    if (since - Date.now() > FUTURE_AT_GRACE_MS) {
      throw new ZohoApiError('fetchSince', 0, `watermark is in the future: ${sinceISO.slice(0, 60)} — full read instead`)
    }
    // hour buckets from the watermark's hour through the current one, inclusive:
    // flooring the start keeps the watermark's partial hour re-readable, so a row
    // landing later inside it is caught by the next delta sweep
    const HOUR = 3_600_000
    const startHour = Math.floor(since / HOUR) * HOUR
    const endHour = Math.floor(Date.now() / HOUR) * HOUR
    const maxBuckets = opts.maxBuckets ?? 6
    const count = endHour / HOUR - startHour / HOUR + 1
    if (count > maxBuckets) {
      throw new ZohoApiError('fetchSince', 0, `delta gap too wide (${count} hour buckets > ${maxBuckets}) — full read instead`)
    }
    const buckets: string[] = []
    for (let t = startHour; t <= endHour; t += HOUR) {
      buckets.push(new Date(t).toISOString().slice(0, 13)) // '2026-09-30T07'
    }
    const seen = new Set<string>()
    const out: ZohoRecord[] = []
    for (const bucket of buckets) {
      let cursor: string | undefined
      for (;;) {
        const j = (await this.call(
          'read',
          'POST',
          '/fetchRecordsWithCriteria',
          {
            base_id: this.baseId,
            table_id: tableId,
            count: this.page,
            criteria: `"${jsonFieldId}" contains "${bucket}"`,
            is_ids_used_in_params: true,
            ...(cursor ? { reference_record_id: cursor } : {}),
          },
          opts.scope,
        )) as Record<string, any>
        const page = recordsFrom(j)
        for (const r of page) {
          if (!seen.has(r.recordID)) {
            seen.add(r.recordID)
            out.push(r)
          }
        }
        if (page.length < this.page) break
        cursor = page[page.length - 1]!.recordID
      }
    }
    return out
  }

  /**
   * The rows for a handful of keys — the commit path's pre-flight read.
   *
   * Fetching "does this row exist, and is it still what the caller based their
   * edit on?" used to mean fetching the whole table, which is one read while the
   * table is small and one read per thousand rows forever after — the ledger and
   * the audit trail grow without limit, so the commit path's cost grew with them
   * until no commit could fit its budget. Reading by criteria spends one read
   * per key instead, whatever the table weighs.
   *
   * The criteria form is the single-condition string the live probe pinned
   * (check name fetch-by-criteria) — but that check used a field NAME, and a
   * field-ID criteria without `is_ids_used_in_params: true` makes the live
   * endpoint answer HTTP 200 wrapping `INTERNAL SERVER ERROR` (pinned against
   * the scratch base 2026-09-28: same criteria, flag on → the row comes back).
   * The flag is the same one upsertByKey has always sent for its criteria. A
   * multi-value OR was never probed, so the read stays ONE CRITERIA CALL PER KEY
   * at any batch size (the audit's S2-5 fix): the old >10-key fallback was one
   * paged sweep of the whole table — an unbounded read whose cost grew with the
   * table forever, and both an honest shape (a 16-row ledger commit is a real
   * big packing run) and a crafted one's lever against the shared budget. The
   * commit shape gate caps a pre-flight at 16 rows, so the per-key spend is
   * bounded at exactly the touched rows.
   */
  async fetchByKeyIn(tableId: string, keyFieldId: string, values: string[]): Promise<ZohoRecord[]> {
    const keys = [...new Set(values.map((v) => String(v)).filter(Boolean))]
    for (const v of keys) {
      // same guard as upsertByKey: a quote would break the criteria silently
      if (/["\\]/.test(v)) {
        throw new ZohoApiError('fetchByKeyIn', 0, `key value must not contain quotes or backslashes: ${v.slice(0, 60)}`)
      }
    }
    if (!keys.length) return []
    const out: ZohoRecord[] = []
    for (const v of keys) {
      const j = (await this.call('read', 'POST', '/fetchRecordsWithCriteria', {
        base_id: this.baseId,
        table_id: tableId,
        count: this.page,
        criteria: `"${keyFieldId}" = "${v}"`,
        is_ids_used_in_params: true,
      })) as Record<string, any>
      out.push(...recordsFrom(j))
    }
    return out
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
