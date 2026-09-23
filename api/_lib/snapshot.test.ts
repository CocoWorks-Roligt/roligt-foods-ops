import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assembleState, invalidateSnapshotCache, readSnapshotCached } from './snapshot.ts'
import { T as LIVE_T } from './baseSchema.ts'
import type { ZohoClient, ZohoRecord } from './zoho.ts'

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
      ledger: [rec('L-1', { id: 'L-1', type: 'GRN', qty_in: 100 })],
      audits: [rec('A-1', { id: 'A-1', action: 'posted' })],
      counters: [
        { recordID: 'c1', data: { 'f-series': 'grn', 'f-next': '5' } },
      ],
      config: [
        { recordID: 'k1', data: { 'f-set': 'app_config', 'f-val': JSON.stringify({ company: 'Roligt' }) } },
        { recordID: 'k2', data: { 'f-set': 'app_revision', 'f-val': '7' } },
        { recordID: 'k3', data: { 'f-set': 'period:lot', 'f-val': '20260909' } },
      ],
    })
    expect(state.state?.grns?.[0]?.lot).toBe('LOT-1')
    expect(state.state?.vendors?.[0]?.name).toBe('Sriram')
    expect(state.state?.ledger?.[0]?.qtyIn).toBe(100)
    expect(state.state?.audits?.[0]?.action).toBe('posted')
    expect((state.state?.counters as unknown as Record<string, number>)?.grn).toBe(5)
    expect(state.state?.counterPeriods?.lot).toBe('20260909')
    expect((state.state?.config as unknown as Record<string, unknown>)?.company).toBe('Roligt')
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

  it('omits a collection whose rows exist but carry no Data JSON — the rowToDoc null-filter path', () => {
    // The scratch base's seed rows have App IDs but empty Data JSON. Such a row is not
    // a document, so the key must stay absent — `migrateState` seeds a collection
    // only when it is missing, and an empty array would read as "deliberately empty".
    const state = assembleState(T as never, {
      grns: [rec('GRN-1', undefined), rec('GRN-2', { id: 'GRN-2', lot: 'LOT-2' })],
      vendors: [rec('V-1', undefined)],
      ledger: [], audits: [], counters: [], config: [],
    })
    expect(state.state && 'vendors' in state.state).toBe(false)
    expect(state.state?.grns?.length).toBe(1)
    expect(state.everWritten).toBe(true)
  })

  it('decodes ledger and audit rows from the FLAT shape the commit writes', () => {
    // commitChanges stores ledger Data JSON via ledgerToRow and audits via auditToRow —
    // snake_case flat rows (qty_in, item_type, actor, at), NOT the app's entry shapes.
    // Reading them back with the generic doc decoder left qtyIn/itemType undefined, the
    // stock fold turned into NaN and a posted receipt never showed as stock. Pinned by
    // the live gate against the scratch base, 2026-09-22.
    const state = assembleState(T as never, {
      ledger: [
        rec('L-9', {
          id: 'L-9', type: 'Receipt', doc: 'RFTC20260001', item: 'RM-TCW-COCO', item_type: 'Raw Material',
          lot: 'LOT-1', location: 'RM Store', status: 'Available', qty_in: 490, qty_out: 0,
          uom: 'Piece', unit_cost: 38.24, at: '2026-09-22T16:10:00Z',
        }),
      ],
      audits: [
        rec('A-9', { id: 'A-9', at: '2026-09-22T16:10:00Z', actor: 'dev@roligt.local', action: 'Posted receipt', doc: 'RFTC20260001', details: 'ok' }),
      ],
      grns: [], vendors: [], counters: [], config: [],
    })
    expect(state.state?.ledger?.[0]?.qtyIn).toBe(490)
    expect(state.state?.ledger?.[0]?.itemType).toBe('Raw Material')
    expect(state.state?.ledger?.[0]?.time).toBe('2026-09-22T16:10:00Z')
    expect(state.state?.audits?.[0]?.role).toBe('dev@roligt.local')
    expect(state.state?.audits?.[0]?.time).toBe('2026-09-22T16:10:00Z')
  })

  it('reads periods from Config only — a period row in Counters is corruption, not truth', () => {
    // Periods live in Config (Setting/Value are text). A period:* row in Counters can
    // only be a remnant of the bug that wrote them there: its Next is a number field
    // that drops the string, so it reads back EMPTY, and nextId's period-change
    // detector would reset the running number on every boot. Such a row must be
    // ignored even when Config has nothing to say about the period. Pinned live
    // 2026-09-22.
    const state = assembleState(T as never, {
      grns: [rec('GRN-1', { id: 'GRN-1', lot: 'LOT-1' })],
      vendors: [], ledger: [], audits: [],
      counters: [{ recordID: 'c1', data: { 'f-series': 'period:grn', 'f-next': '' } }],
      config: [{ recordID: 'k1', data: { 'f-set': 'period:lot', 'f-val': 'YYYYMMDD:20260922' } }],
    })
    expect(state.state?.counterPeriods?.grn).toBeUndefined()
    expect(state.state?.counterPeriods?.lot).toBe('YYYYMMDD:20260922')
  })

  it("tells a wiped collection (zero rows → []) from a staged one (no Data JSON → key absent)", () => {
    // Zero rows read back means an admin emptied the table on purpose — the state
    // must say "deliberately empty" ([]), which migrateState will NOT reseed. Rows
    // that exist without Data JSON mean the table was staged but never written to;
    // the key stays absent so first-boot seeding still happens.
    const state = assembleState(T as never, {
      grns: [rec('GRN-1', { id: 'GRN-1', lot: 'LOT-1' })], // someone has written something
      vendors: [], // wiped
      ledger: [rec('L-1', undefined)], // staged without Data JSON
      audits: [],
      counters: [],
      config: [],
    })
    expect(state.state?.vendors).toEqual([])
    expect(state.state && 'ledger' in state.state).toBe(false)
    expect(state.state?.audits).toEqual([])
    expect(state.everWritten).toBe(true)
  })
})

describe('readSnapshotCached', () => {
  /** Answers the live schema's Config table with the given revision, [] for every
   *  other table — a full sweep against this fake is a fetchAll per mapped table. */
  const fakeZoho = (rev: () => number) => {
    const config = LIVE_T['Config']
    const fetchAll = vi.fn(async (tableId: string): Promise<ZohoRecord[]> =>
      tableId === config.id
        ? [
            {
              recordID: 'k1',
              data: {
                [config.fields['Setting']]: 'app_revision',
                [config.fields['Value']]: String(rev()),
              },
            },
          ]
        : [],
    )
    return { zoho: { baseId: 'base-test', fetchAll } as unknown as ZohoClient, fetchAll }
  }

  beforeEach(() => invalidateSnapshotCache())

  it('serves the cached snapshot while the revision stands — one read, not a 26-read sweep', async () => {
    let rev = 7
    const { zoho, fetchAll } = fakeZoho(() => rev)
    const first = await readSnapshotCached(zoho)
    expect(first.revision).toBe(7)
    const afterSweep = fetchAll.mock.calls.length
    const second = await readSnapshotCached(zoho)
    expect(second).toBe(first)
    expect(fetchAll.mock.calls.length).toBe(afterSweep + 1) // the revision read alone
  })

  it('sweeps again once the revision moves', async () => {
    let rev = 7
    const { zoho, fetchAll } = fakeZoho(() => rev)
    const first = await readSnapshotCached(zoho)
    rev = 8
    const second = await readSnapshotCached(zoho)
    expect(second.revision).toBe(8)
    expect(second).not.toBe(first)
    expect(fetchAll.mock.calls.length).toBeGreaterThan(2) // a real re-sweep happened
  })

  it('drops the cache when a commit invalidates it', async () => {
    const { zoho } = fakeZoho(() => 7)
    const first = await readSnapshotCached(zoho)
    invalidateSnapshotCache()
    const second = await readSnapshotCached(zoho)
    expect(second).not.toBe(first)
    expect(second.revision).toBe(7)
  })
})
