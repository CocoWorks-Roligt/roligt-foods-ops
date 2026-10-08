/**
 * Cloudflare D1 over its REST query endpoint — the hand-rolled client, the
 * ZohoClient ethos: plain fetch, no SDK, no budget (D1 has no API read budget
 * at this scale), no paging pools. One shared instance per process, built by
 * shared.ts when D1_DATABASE_ID names the engine.
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/<acct>/d1/database/<db>/query
 *   { sql, params }            — one statement
 *   { batch: [{sql, params}] } — a batch (atomicity pinned by scripts/d1/probe.mjs)
 *
 * Error mapping mirrors ZohoLockedError's contract so the routes' one catch
 * (LockedError) keeps answering 503 + Retry-After: HTTP 429 ⇒ LockedError(60);
 * 5xx or a network fault ⇒ ONE silent retry for reads, never for writes, then
 * LockedError(30). A `success:false` body (a refused statement — the assert
 * table's CHECK, a constraint, a bad statement) is a D1ApiError carrying the
 * provider's own message; the commit engine recognizes the assert-table trip
 * by that message and answers the client's 409.
 *
 * query() is the read path (retryable); every write goes through batch() —
 * the engine never issues a write through query(), so a retry can never
 * double-apply anything.
 */
import { LockedError } from './store.js'

const MAX_PARAM_BYTES = 1_500_000 // the row cap is 2 MB; refuse close to it, loudly
const API_BASE = process.env.D1_API_BASE || 'https://api.cloudflare.com'

export class D1ApiError extends Error {
  readonly code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

interface QueryResult<T> {
  results?: T[]
  success: boolean
  meta?: { changes?: number; rows_read?: number; rows_written?: number }
}

interface D1Response<T = unknown> {
  success: boolean
  errors?: { code?: number; message?: string }[]
  result?: QueryResult<T>[]
}

export class D1Client {
  readonly databaseId: string
  private readonly accountId: string
  private readonly token: string

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.accountId = String(env.D1_ACCOUNT_ID ?? '')
    this.databaseId = String(env.D1_DATABASE_ID ?? '')
    this.token = String(env.D1_API_TOKEN ?? '')
    if (!this.accountId || !this.databaseId || !this.token) {
      throw new Error('D1_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN are not configured.')
    }
  }

  private url(): string {
    return `${API_BASE}/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`
  }

  /** One statement. Reads only (a 5xx is retried once — never send a write here). */
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const first = await this.post<T>({ sql, params }, true)
    if (first !== null) return this.resultsOf<T>(first, 0)
    const retry = await this.post<T>({ sql, params }, false)
    if (retry !== null) return this.resultsOf<T>(retry, 0)
    throw new LockedError(30)
  }

  /**
   * A batch of statements — the engine's every write, and the snapshot's whole
   * read, in one round trip. Never retried: a write batch that already landed
   * must surface its outcome, not silently repeat.
   */
  async batch<T = unknown>(
    stmts: { sql: string; params?: unknown[] }[],
  ): Promise<{ results: T[]; meta: { changes: number } }[]> {
    if (stmts.length === 0) return []
    const json = await this.post<T>(
      { batch: stmts.map((s) => ({ sql: s.sql, params: s.params ?? [] })) },
      false,
    )
    if (json === null) throw new LockedError(30)
    return (json.result ?? []).map((r) => ({ results: r.results ?? [], meta: { changes: r.meta?.changes ?? 0 } }))
  }

  /** Returns null when the call should be retried/becomes LockedError; throws D1ApiError on refusals. */
  private async post<T>(body: unknown, retriable: boolean): Promise<D1Response<T> | null> {
    this.guardParams(body)
    let res: Response
    try {
      res = await fetch(this.url(), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (retriable) return null // one retry, then LockedError
      throw new LockedError(30, `The store could not be reached: ${(e as Error).message}`)
    }
    if (res.status === 429) throw new LockedError(60)
    if (res.status >= 500) {
      if (retriable) return null
      throw new LockedError(30)
    }
    const json = (await res.json().catch(() => null)) as D1Response<T> | null
    if (!json) {
      if (retriable) return null
      throw new LockedError(30)
    }
    if (!json.success) {
      const err = json.errors?.[0]
      throw new D1ApiError(err?.message ?? 'The store refused the statement.', err?.code)
    }
    return json
  }

  private resultsOf<T>(json: D1Response<T>, index: number): T[] {
    return json.result?.[index]?.results ?? []
  }

  /** The 2 MB row cap, refused loudly before anything travels. */
  private guardParams(body: unknown): void {
    const stmts =
      (body as { batch?: { params?: unknown[] }[] }).batch ??
      ([body as { params?: unknown[] }] as { params?: unknown[] }[])
    for (const stmt of stmts) {
      for (const p of stmt.params ?? []) {
        if (typeof p === 'string' && p.length > MAX_PARAM_BYTES) {
          throw new D1ApiError('A value exceeded the store\'s row-size limit (1.5 MB).')
        }
      }
    }
  }
}
