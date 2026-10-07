import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunkChanges, saveDb } from './dbApi.ts'
import type { StateChanges } from './sync.ts'
import type { AppState } from '../types.ts'

/**
 * The ride-along guarantees, client side (the 2026-10-07 lone-audit wedge):
 * the BFF refuses a commit whose only content is a ride — an audit row, a
 * counter, the config — and one refused chunk re-sends with every later save
 * from that device. chunkChanges must never emit such a chunk, and saveDb
 * must not even try when an edit changed nothing but its audit row.
 */
const rows = (table: string, n: number) => ({
  table,
  upsert: Array.from({ length: n }, (_, i) => ({ id: `${table}-${i + 1}`, data: { id: `${table}-${i + 1}`, name: `row ${i + 1}` } })),
  remove: [],
})
const auditRows = (n: number) => ({
  table: 'audits',
  upsert: Array.from({ length: n }, (_, i) => ({ id: `AUD-T${i + 1}`, at: '2026-10-07T09:00:00.000Z', actor: 't@roligt.local', action: 'Edited item', doc: 'PP-0001', details: 'test' })),
  remove: [],
})

/** A chunk is accompanied when it carries at least one non-ride row. */
const accompanied = (c: StateChanges) =>
  c.tables.some((t) => t.table !== 'audits' && (t.upsert.length || t.remove.length))

describe('chunkChanges — rides never travel alone', () => {
  it('seats audits beside rows on a masters save, never in a chunk of their own', () => {
    const changes: StateChanges = {
      empty: false,
      tables: [rows('purchase_products', 12), rows('items', 1), auditRows(1)],
      counters: { purchaseProduct: 13 },
      config: undefined,
    }
    const chunks = chunkChanges(changes)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(accompanied(c)).toBe(true)
    // the minted counter rides a chunk that carries rows
    expect(chunks.some((c) => Object.keys(c.counters).length > 0 && accompanied(c))).toBe(true)
  })

  it('keeps counters and config company when rows land exactly on the boundary', () => {
    const changes: StateChanges = {
      empty: false,
      tables: [rows('purchase_products', 12)],
      counters: { purchaseProduct: 12 },
      config: { tolerances: { lab: 5 } } as StateChanges['config'],
    }
    const chunks = chunkChanges(changes)
    for (const c of chunks) expect(accompanied(c)).toBe(true)
    expect(chunks.some((c) => !!c.config && accompanied(c))).toBe(true)
    expect(chunks.some((c) => Object.keys(c.counters).length > 0 && accompanied(c))).toBe(true)
  })

  it('spills a long audit tail into earlier chunks rather than stranding it, inside the BFF caps', () => {
    const changes: StateChanges = {
      empty: false,
      tables: [rows('purchase_products', 12), rows('items', 2), auditRows(6)],
      counters: {},
      config: undefined,
    }
    const chunks = chunkChanges(changes)
    for (const c of chunks) expect(accompanied(c)).toBe(true)
    const auditCount = chunks.reduce((a, c) => a + (c.tables.find((t) => t.table === 'audits')?.upsert.length ?? 0), 0)
    expect(auditCount).toBe(6)
    for (const c of chunks) {
      const rowCount = c.tables.reduce((a, t) => a + t.upsert.length + t.remove.length, 0)
      expect(rowCount).toBeLessThanOrEqual(16)
      expect(c.tables.length).toBeLessThanOrEqual(12)
    }
  })
})

describe('saveDb — an edit that changed nothing files no lone audit', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('treats an audits-only diff as a no-op and never POSTs a commit', async () => {
    const fetchMock = vi.fn(async (_path: unknown) =>
      new Response(JSON.stringify({ revision: '42:noop' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const empty = {
      counters: {}, config: {}, vendorTypes: [], vendors: [], customers: [], purchaseProducts: [],
      storageLocations: [], items: [], products: [], melanges: [], grns: [], batches: [], packingRuns: [],
      orders: [], qcs: [], dispatches: [], ledger: [], audits: [], testParameters: [], labReports: [],
      stickerTemplates: [],
    } as unknown as AppState
    const next = {
      ...empty,
      audits: [{ id: 'AUD-NOOP', at: '2026-10-07T09:00:00.000Z', actor: 't@roligt.local', action: 'Edited item', doc: 'PP-0001', details: 'test' }],
    } as unknown as AppState
    const result = await saveDb(next, empty)
    expect(result.ok).toBe(true)
    const calls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls).toContain('/api/revision')
    expect(calls).not.toContain('/api/commit')
  })
})
