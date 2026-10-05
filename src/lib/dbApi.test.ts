import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkChanges, fetchRevision, saveDb, UnauthorizedError, ThrottledError } from './dbApi'
import type { StateChanges } from './sync'
import type { AppState } from '../types'
import { setUnauthorizedHandler } from './authEvents'

// These tests pin the dev-fallback contract, which holds only while WorkOS is
// unconfigured — a developer's .env.local (VITE_WORKOS_CLIENT_ID set for
// localhost testing) must not decide which mode the suite exercises.
vi.mock('./authMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authMode')>()),
  WORKOS_CONFIGURED: false,
}))

/**
 * Pins the cookie-session contract dbApi implements: the request carries no
 * Authorization header ever (the httpOnly cookie is the credential, refreshed
 * server-side), a single 401 is final — UnauthorizedError plus the auth event,
 * no retry — and a 503 with Retry-After is throttling. Unconfigured (no
 * VITE_WORKOS_CLIENT_ID), every request also carries the dev picker's role.
 */

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

let unauthorizedNotified = false
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  unauthorizedNotified = false
  setUnauthorizedHandler(() => {
    unauthorizedNotified = true
  })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  // getDevRole reads localStorage, which the node test environment lacks.
  vi.stubGlobal('localStorage', { getItem: () => 'Operator', setItem: vi.fn() })
})

afterEach(() => {
  setUnauthorizedHandler(null)
  vi.unstubAllGlobals()
})

describe('api request shape', () => {
  it('sends the cookie credential and the dev role header — never an Authorization header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { revision: '7:abc123' }))
    await expect(fetchRevision()).resolves.toBe('7:abc123')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/revision')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('authorization')).toBeNull()
    expect(new Headers(init.headers).get('x-dev-role')).toBe('Operator') // the picker's choice
  })
})

describe('api session handling', () => {
  it('reports UnauthorizedError and notifies auth on a single 401 — no retry exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Sign in first.' }))
    await expect(fetchRevision()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(unauthorizedNotified).toBe(true)
  })

  it('maps a 503 with Retry-After to ThrottledError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'busy' }, { 'retry-after': '120' }))
    const err: unknown = await fetchRevision().catch((e) => e)
    expect(err).toBeInstanceOf(ThrottledError)
    expect((err as ThrottledError).retryAfterSec).toBe(120)
    expect(unauthorizedNotified).toBe(false)
  })
})

describe('saveDb unauthorized mapping', () => {
  it('maps a dead session to the unauthorized result, not an exception', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Sign in first.' }))
    const result = await saveDb({ vendors: [] } as unknown as AppState, null)
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'Your session expired — sign in again.',
    })
  })
})

describe('saveDb conflict mapping', () => {
  it('maps a 409 to the conflict result with the rows the server named', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: 'Another device saved GRN-2026-0001 first.',
        conflicts: [{ table: 'grns', id: 'GRN-2026-0001', kind: 'changed' }],
      }),
    )
    const result = await saveDb(
      { grns: [{ id: 'GRN-2026-0001', status: 'Posted' }] } as unknown as AppState,
      null,
    )
    expect(result).toEqual({
      ok: false,
      reason: 'conflict',
      message: 'Another device saved GRN-2026-0001 first.',
      conflicts: [{ table: 'grns', id: 'GRN-2026-0001', kind: 'changed' }],
    })
  })
})

describe('saveDb chunking', () => {
  it('splits a large push into commits of at most 12 row-writes, counters riding the last', async () => {
    // a fresh Response per call — one body can only be read once
    fetchMock.mockImplementation(async () => jsonResponse(200, { revision: '9:x' }))
    const vendors = Array.from({ length: 30 }, (_, i) => ({ id: `V-${i + 1}`, name: `Vendor ${i + 1}` }))
    const result = await saveDb({ vendors, counters: { grn: 1 } } as unknown as AppState, null)
    expect(result).toEqual({ ok: true, revision: '9:x' })
    const commits = fetchMock.mock.calls.filter(([url]) => url === '/api/commit')
    // masters rows carry no page, so nothing can vouch for a spread tail — the
    // queue stays single-file: 12 + 12 rows, then 6 rows + the counter
    expect(commits).toHaveLength(3)
    const bodies = commits.map(([, init]) => JSON.parse(String(init!.body)).changes)
    for (const chunk of bodies) {
      const rows = chunk.tables.reduce((a: number, t: { upsert: unknown[]; remove: unknown[] }) => a + t.upsert.length + t.remove.length, 0)
      expect(rows).toBeLessThanOrEqual(12)
    }
    // counters always travel after every row they number
    expect(bodies[0]!.counters).toEqual({})
    expect(bodies[2]!.counters).toEqual({ grn: 1 })
  })
})

describe('chunkChanges', () => {
  const writeCost = (c: StateChanges) =>
    c.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0) +
    Object.keys(c.counters).length +
    (c.config ? 1 : 0)
  const rowsIn = (c: StateChanges, table: string) => {
    const t = c.tables.find((x) => x.table === table)
    return (t?.upsert.length ?? 0) + (t?.remove.length ?? 0)
  }
  const grnRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `G-${i + 1}`, data: { code: `GRN-${i + 1}` } }))
  const ledgerRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `L-${i + 1}`, qty: 1 }))

  it('returns a small diff whole — rows plus tail within one commit', () => {
    const changes: StateChanges = {
      tables: [{ table: 'grns', upsert: grnRows(3), remove: [] }],
      counters: { grn: 4, lot: 2 },
      empty: false,
    }
    expect(chunkChanges(changes)).toEqual([changes])
  })

  it('counts counters and config against the same budget — the catch-up shape', () => {
    // the 2026-10-05 phone queue: 12 rows whose minted numbers make the commit
    // ~21 writes, more than one budget minute as a single POST
    const changes: StateChanges = {
      tables: [
        {
          table: 'grns',
          upsert: grnRows(12),
          remove: [],
          expect: { 'G-5': { id: 'G-5', data: { code: 'GRN-old' } } },
        },
      ],
      counters: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i + 1])),
      config: { testCategories: [] },
      empty: false,
    }
    const chunks = chunkChanges(changes)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(writeCost(chunk)).toBeLessThanOrEqual(12)
    // rows first, the numbered tail after them, config in the very last chunk
    expect(rowsIn(chunks[0]!, 'grns')).toBe(11)
    expect(Object.keys(chunks[chunks.length - 2]!.counters)).toHaveLength(0)
    expect(Object.keys(chunks[chunks.length - 1]!.counters)).toHaveLength(8)
    expect(chunks[chunks.length - 1]!.config).toEqual({ testCategories: [] })
    // each row's conflict precondition travels with the row, not the tail
    expect(chunks[0]!.tables[0]!.expect?.['G-5']).toEqual({ id: 'G-5', data: { code: 'GRN-old' } })
    expect(chunks[1]!.tables[0]!.expect).toBeUndefined()
  })

  it('opens every ride-along chunk with a collection row — the gate a scoped caller faces', () => {
    const changes: StateChanges = {
      tables: [
        { table: 'grns', upsert: grnRows(2), remove: [] },
        { table: 'ledger', upsert: ledgerRows(20), remove: [] },
      ],
      counters: { grn: 3, lot: 5 },
      empty: false,
    }
    const chunks = chunkChanges(changes)
    for (const chunk of chunks) {
      expect(writeCost(chunk)).toBeLessThanOrEqual(12)
      // the BFF refuses ledger lines or counters from a chunk with no
      // collection row in it — every chunk that carries one carries both
      if (rowsIn(chunk, 'ledger') > 0 || Object.keys(chunk.counters).length > 0)
        expect(rowsIn(chunk, 'grns')).toBeGreaterThan(0)
    }
    // nothing was dropped or duplicated
    const rows = chunks.reduce((a, c) => a + rowsIn(c, 'grns') + rowsIn(c, 'ledger'), 0)
    expect(rows).toBe(22)
    expect(chunks.reduce((a, c) => a + Object.keys(c.counters).length, 0)).toBe(2)
  })

  it('re-sends a landed voucher row when the tail needs more chunks than it has collection rows', () => {
    // one collection row, 21 tail writes — the ordinary shape of a single
    // document whose ledger outgrew it (a packing run, a many-line dispatch).
    // The tail needs two chunks but only one distinct voucher exists, so the
    // same GRN opens both: its second send is an idempotent no-op server-side
    // (the row landed with chunk 1), so nothing is written twice and a scoped
    // caller's chunk 2 is not the ledger-only commit the BFF would 403.
    const changes: StateChanges = {
      tables: [
        { table: 'grns', upsert: grnRows(1), remove: [] },
        { table: 'ledger', upsert: ledgerRows(20), remove: [] },
      ],
      counters: { grn: 2 },
      empty: false,
    }
    const chunks = chunkChanges(changes)
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) {
      expect(writeCost(chunk)).toBeLessThanOrEqual(12)
      expect(rowsIn(chunk, 'grns')).toBe(1) // the voucher opens every chunk
    }
    expect(chunks.reduce((a, c) => a + rowsIn(c, 'ledger'), 0)).toBe(20)
    // counters travel after every row they number
    expect(Object.keys(chunks[chunks.length - 1]!.counters)).toEqual(['grn'])
  })

  it('never drops the counters when rows land on an exact chunk boundary', () => {
    // the fallback shape (no collection row can vouch): 12 rows is exactly one
    // chunk, and the counters used to be assigned to the fresh remainder chunk
    // the final flush refused to push (used === 0) — every minted number
    // silently dropped while saveDb reported ok
    const changes: StateChanges = {
      tables: [{ table: 'ledger', upsert: ledgerRows(12), remove: [] }],
      counters: { grn: 2, 'period:grn': 'YYYY:2026' },
      empty: false,
    }
    const chunks = chunkChanges(changes)
    for (const chunk of chunks) expect(writeCost(chunk)).toBeLessThanOrEqual(12)
    expect(chunks.reduce((a, c) => a + Object.keys(c.counters).length, 0)).toBe(2)
    expect(chunks[chunks.length - 1]!.counters).toEqual({ grn: 2, 'period:grn': 'YYYY:2026' })
  })

  it('never drops a config change on an exact boundary either — it rides its own final chunk', () => {
    const changes: StateChanges = {
      tables: [{ table: 'ledger', upsert: ledgerRows(24), remove: [] }],
      counters: {},
      config: { testCategories: [] },
      empty: false,
    }
    const chunks = chunkChanges(changes)
    expect(chunks.map(writeCost)).toEqual([12, 12, 1])
    expect(chunks[2]!.config).toEqual({ testCategories: [] })
  })
})
