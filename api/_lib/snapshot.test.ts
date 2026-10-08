import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assembleState,
  cachedLedgerWatermark,
  cachedRevision,
  invalidateSnapshotCache,
  noteCommitApplied,
  noteRevision,
  parseZohoRows,
  projectSnapshot,
  readRevisionMemoized,
  readSnapshotCached,
  withheldForCaller,
  type SnapshotRows,
} from './snapshot.js'
import { TABLE_FOR, T as LIVE_T } from './baseSchema.js'
import { PAGE_CATALOG } from '../../src/lib/pages.js'
import type { ZohoClient, ZohoRecord } from './zoho.js'

const T = {
  GRNs: { name: 'GRNs', id: 't-grn', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Vendors: { name: 'Vendors', id: 't-ven', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Customers: { name: 'Customers', id: 't-cus', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Ledger: { name: 'Ledger', id: 't-led', appId: 'f-app', dataJson: 'f-data', fields: {} },
  'Audit Log': { name: 'Audit Log', id: 't-aud', appId: 'f-app', dataJson: 'f-data', fields: {} },
  Counters: { name: 'Counters', id: 't-cnt', appId: 'f-app', fields: { Series: 'f-series', Next: 'f-next' }, dataJson: undefined },
  Config: { name: 'Config', id: 't-cfg', appId: 'f-app', fields: { Setting: 'f-set', Value: 'f-val' }, dataJson: undefined },
} as const

const rec = (appId: string, json: unknown, extra: Record<string, unknown> = {}): ZohoRecord => ({
  recordID: 'z-' + appId,
  data: { 'f-app': appId, ...(json === undefined ? {} : { 'f-data': JSON.stringify(json) }), ...extra },
})

// The engine seam split assembleState into the Zoho-row parse and the pure
// assembly; this composition is the one the sweep itself uses.
const assemble = (rows: SnapshotRows) => assembleState(parseZohoRows(T as never, rows))

describe('assembleState', () => {
  it('maps collections, ledger, audits, counters and config back into the app shape', () => {
    const state = assemble({
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
    expect(state.revision).toBe('7')
    expect(state.everWritten).toBe(true)
  })

  it('returns null state when nothing was ever posted', () => {
    const state = assemble({
      grns: [], vendors: [], ledger: [], audits: [], counters: [], config: [],
    })
    expect(state.state).toBeNull()
    expect(state.everWritten).toBe(false)
  })

  it('omits a collection whose rows exist but carry no Data JSON — the rowToDoc null-filter path', () => {
    // The scratch base's seed rows have App IDs but empty Data JSON. Such a row is not
    // a document, so the key must stay absent — `migrateState` seeds a collection
    // only when it is missing, and an empty array would read as "deliberately empty".
    const state = assemble({
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
    const state = assemble({
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
    const state = assemble({
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
    const state = assemble({
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
   *  other table — a full sweep against this fake is a fetchAll per mapped table,
   *  and the revision gate is one criteria read of the app_revision row. */
  const fakeZoho = (rev: () => number) => {
    const config = LIVE_T['Config']
    const revisionRow = (): ZohoRecord => ({
      recordID: 'k1',
      data: {
        [config.fields['Setting']]: 'app_revision',
        [config.fields['Value']]: String(rev()),
      },
    })
    const fetchAll = vi.fn(async (tableId: string): Promise<ZohoRecord[]> =>
      tableId === config.id ? [revisionRow()] : [],
    )
    const fetchByKeyIn = vi.fn(async (tableId: string, _keyFieldId: string, values: readonly string[]) =>
      tableId === config.id && values.includes('app_revision') ? [revisionRow()] : [],
    )
    return {
      // canBurstSweep false = the sweep window is busy: every warm serve here
      // takes the paced criteria-gate path of today's contract
      zoho: { baseId: 'base-test', fetchAll, fetchByKeyIn, canBurstSweep: () => false } as unknown as ZohoClient,
      fetchAll,
      fetchByKeyIn,
    }
  }

  beforeEach(() => invalidateSnapshotCache())

  it('serves the cached snapshot while the revision stands — one criteria read per ask, not a 26-read sweep', async () => {
    let rev = 7
    const { zoho, fetchAll, fetchByKeyIn } = fakeZoho(() => rev)
    const config = LIVE_T['Config']
    const first = await readSnapshotCached(zoho)
    expect(first.revision).toBe('7')
    // the cold sweep's whole shape: exactly 26 reads — one per mapped table,
    // Counters, and ONE Config read that leads the sweep as the gate. No
    // criteria gate read at all: 26 + 1 is one read over the global window's
    // minute, the read that used to park ~60s on every cold start.
    expect(fetchAll.mock.calls.length).toBe(26)
    expect(fetchAll.mock.calls.filter((c) => c[0] === config.id)).toHaveLength(1)
    expect(fetchAll.mock.calls[0]![0]).toBe(config.id) // Config read FIRST — it is the gate
    expect(fetchByKeyIn.mock.calls.length).toBe(0) // no criteria gate on a cold call
    const afterSweep = fetchAll.mock.calls.length
    const second = await readSnapshotCached(zoho)
    expect(second).toBe(first)
    expect(fetchAll.mock.calls.length).toBe(afterSweep) // no table was re-swept
    // the warm serve's one criteria read — a warm sweep gates on a token read
    // up front (fix 8's torn-cache rule); the cold sweep gates on its own
    // leading Config read instead
    expect(fetchByKeyIn.mock.calls.length).toBe(1)
    expect(fetchByKeyIn.mock.calls[0]![2]).toEqual(['app_revision'])
  })

  it('sweeps again once the revision moves', async () => {
    let rev = 7
    const { zoho, fetchAll } = fakeZoho(() => rev)
    const first = await readSnapshotCached(zoho)
    rev = 8
    const second = await readSnapshotCached(zoho)
    expect(second.revision).toBe('8')
    expect(second).not.toBe(first)
    expect(fetchAll.mock.calls.length).toBeGreaterThan(2) // a real re-sweep happened
  })

  it('drops the cache when a commit invalidates it', async () => {
    const { zoho } = fakeZoho(() => 7)
    const first = await readSnapshotCached(zoho)
    invalidateSnapshotCache()
    const second = await readSnapshotCached(zoho)
    expect(second).not.toBe(first)
    expect(second.revision).toBe('7')
  })
})

describe('delta sweep — the substrate cache deltas off the watermarks', () => {
  const LED = LIVE_T['Ledger']
  const AUD = LIVE_T['Audit Log']
  const CFG = LIVE_T['Config']

  const ledRow = (id: string, at: string, qtyIn = 10): ZohoRecord => ({
    recordID: 'z-' + id,
    data: { [LED.appId]: id, [LED.dataJson!]: JSON.stringify({ id, at, type: 'GRN', qty_in: qtyIn, unit: 'kg' }) },
  })
  const audRow = (id: string, at: string): ZohoRecord => ({
    recordID: 'z-' + id,
    data: { [AUD.appId]: id, [AUD.dataJson!]: JSON.stringify({ id, at, action: 'posted', actor: 'a@b.c', doc: 'D-1', details: '' }) },
  })
  const VEND = LIVE_T['Vendors']
  const venRow = (id: string, name: string): ZohoRecord => ({
    recordID: 'z-' + id,
    data: { [VEND.appId]: id, [VEND.dataJson!]: JSON.stringify({ id, name }) },
  })

  /**
   * A fake holding live-schema rows in a mutable store: fetchAll reads the whole
   * table, fetchSince answers the rows whose Data JSON `at` sits at or past the
   * watermark (the semantics the hour-bucket delta delivers — boundary row
   * included), and the Config criteria read answers the revision closure. Every
   * call is counted per table id; `failSince` makes fetchSince refuse the way a
   * wrapped INTERNAL SERVER ERROR does; `onFetchAll` fires before a table's rows
   * return, so a test can move the base mid-sweep.
   */
  const fakeDelta = (opts: {
    rev: () => string | number
    ledger?: ZohoRecord[]
    audits?: ZohoRecord[]
    onFetchAll?: (tableId: string) => void
    /** True = the sweep window reads empty (a minute without sweep reads): warm
     *  serves take the burst gate — full-Config gate, seeded sweep. The fake is
     *  a stub; the window semantics themselves are pinned in zoho.test.ts. */
    burst?: boolean
  }) => {
    const store: Record<string, ZohoRecord[]> = {
      [LED.id]: opts.ledger ? [...opts.ledger] : [],
      [AUD.id]: opts.audits ? [...opts.audits] : [],
      [CFG.id]: [],
    }
    const calls = { fetchAll: {} as Record<string, number>, fetchSince: {} as Record<string, number> }
    const bump = (m: Record<string, number>, id: string) => (m[id] = (m[id] ?? 0) + 1)
    const failSince = { on: false }
    const revRow = (): ZohoRecord => ({
      recordID: 'k1',
      data: { [CFG.fields['Setting']]: 'app_revision', [CFG.fields['Value']]: String(opts.rev()) },
    })
    const atOf = (r: ZohoRecord, jsonField: string): string | null => {
      try {
        const at = (JSON.parse(String(r.data[jsonField])) as { at?: unknown }).at
        return typeof at === 'string' ? at : null
      } catch {
        return null
      }
    }
    const fetchAll = vi.fn(async (tableId: string): Promise<ZohoRecord[]> => {
      bump(calls.fetchAll, tableId)
      opts.onFetchAll?.(tableId)
      if (tableId === CFG.id) return [revRow()]
      return [...(store[tableId] ?? [])]
    })
    const fetchSince = vi.fn(
      async (tableId: string, jsonFieldId: string, sinceISO: string): Promise<ZohoRecord[]> => {
        bump(calls.fetchSince, tableId)
        if (failSince.on) throw new Error('fetchSince → HTTP 200: {"error":{"code":500}}')
        return (store[tableId] ?? []).filter((r) => {
          const at = atOf(r, jsonFieldId)
          return at !== null && at >= sinceISO
        })
      },
    )
    const fetchByKeyIn = vi.fn(async (tableId: string, _keyFieldId: string, values: readonly string[]) =>
      tableId === CFG.id && values.includes('app_revision') ? [revRow()] : [],
    )
    return {
      zoho: {
        baseId: 'base-test',
        fetchAll,
        fetchSince,
        fetchByKeyIn,
        canBurstSweep: () => !!opts.burst,
      } as unknown as ZohoClient,
      store,
      calls,
      failSince,
      fetchByKeyIn,
    }
  }

  beforeEach(() => invalidateSnapshotCache())

  it('a cold sweep full-reads; a moved revision then costs one fetchSince per delta table', async () => {
    let rev = 7
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      audits: [audRow('A1', '2026-09-30T08:00:00.000Z')],
    })
    const s1 = await readSnapshotCached(f.zoho)
    expect(s1.revision).toBe('7')
    expect(s1.state?.ledger?.length).toBe(1)
    const ledFull = f.calls.fetchAll[LED.id] ?? 0
    expect(ledFull).toBeGreaterThan(0)
    expect(f.calls.fetchSince[LED.id] ?? 0).toBe(0) // cold: nothing to delta off
    rev = 8
    f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:20:00.000Z', 7))
    f.store[AUD.id]!.push(audRow('A2', '2026-09-30T08:20:00.000Z'))
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.revision).toBe('8')
    expect(s2.state?.ledger?.length).toBe(2)
    expect(s2.state?.audits?.length).toBe(2)
    // one delta read per append-only table — not one per thousand lines
    expect(f.calls.fetchSince[LED.id]).toBe(1)
    expect(f.calls.fetchSince[AUD.id]).toBe(1)
    // and no full re-read of either
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull)
  })

  it('re-delivered rows merge by App ID — the watermark boundary row comes back every delta and must not double', async () => {
    let rev = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    await readSnapshotCached(f.zoho)
    rev = 8
    // L1 sits AT the watermark: the bucket re-reads its whole hour, so the delta
    // hands it back alongside the genuinely new row — merge, never append
    f.store[LED.id] = [ledRow('L1', '2026-09-30T08:00:00.000Z'), ledRow('L2', '2026-09-30T08:30:00.000Z', 7)]
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchSince[LED.id]).toBe(1)
  })

  it('a commit that removed rows files a remove hint — the deletion is visible at the next sweep, not five minutes later', async () => {
    let rev = 7
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z'), ledRow('L2', '2026-09-30T08:10:00.000Z', 7)],
    })
    await readSnapshotCached(f.zoho)
    noteCommitApplied('base-test', '1:own', { removedTables: ['ledger'], backdatedLedger: false, touchedTables: [] })
    invalidateSnapshotCache('1:own') // the route's own-token invalidate: cache no-op, hint stands
    rev = 8
    f.store[LED.id] = [ledRow('L1', '2026-09-30T08:00:00.000Z')] // L2 deleted by the commit
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.state?.ledger?.length).toBe(1)
    expect(f.calls.fetchSince[LED.id] ?? 0).toBe(0) // hinted: no delta attempted
    expect(f.calls.fetchAll[LED.id]).toBe(2) // the full read saw the deletion
  })

  it('a backdated ledger write files a backdate hint — the full read catches rows the bucket delta would miss', async () => {
    let rev = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    await readSnapshotCached(f.zoho)
    noteCommitApplied('base-test', '1:own', { removedTables: [], backdatedLedger: true, touchedTables: [] })
    invalidateSnapshotCache('1:own')
    rev = 8
    // a PM receipt written at 07:00, under the 08:00 watermark — `contains` on the
    // 08 bucket can never find it
    f.store[LED.id] = [ledRow('L1', '2026-09-30T08:00:00.000Z'), ledRow('LB', '2026-09-30T07:00:00.000Z', 3)]
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchSince[LED.id] ?? 0).toBe(0)
    expect(f.calls.fetchAll[LED.id]).toBe(2)
  })

  it('a fetchSince refusal falls to the full read in the same sweep, and the rebuilt watermark deltas again after', async () => {
    let rev = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    await readSnapshotCached(f.zoho)
    rev = 8
    f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:40:00.000Z', 7))
    f.failSince.on = true
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.state?.ledger?.length).toBe(2) // the fallback found the row
    expect(f.calls.fetchSince[LED.id]).toBe(1) // tried once
    expect(f.calls.fetchAll[LED.id]).toBe(2) // and full-read, same sweep
    f.failSince.on = false
    rev = 9
    f.store[LED.id]!.push(ledRow('L3', '2026-09-30T08:50:00.000Z', 5))
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3.state?.ledger?.length).toBe(3)
    expect(f.calls.fetchSince[LED.id]).toBe(2) // the full read rebuilt the watermark
  })

  it('a future-dated stored row never advances the watermark — the delta keeps serving new rows', async () => {
    // the poisoned-watermark chain this pins shut: a row whose `at` sits in the
    // future used to become the lexicographic max, every later bucket landed
    // past "now", and the delta answered [] forever while looking healthy.
    // maxAt now skips rows beyond the grace (the commit gate refuses to write
    // one; a hand edit in the Zoho UI still can), so the watermark stays at the
    // honest max and the next sweep's delta finds the genuinely new row.
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const fresh = new Date(Date.now() - 60_000).toISOString()
    let rev = 7
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z'), ledRow('LF', future)],
    })
    const s1 = await readSnapshotCached(f.zoho)
    expect(s1.state?.ledger?.length).toBe(2) // the row itself is data and is served
    const ledFull = f.calls.fetchAll[LED.id] ?? 0
    rev = 8
    f.store[LED.id]!.push(ledRow('L2', fresh, 7))
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.state?.ledger?.length).toBe(3) // the new row arrived — via the delta
    expect(f.calls.fetchSince[LED.id]).toBe(1) // the delta served this sweep…
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull) // …not a full re-read
  })

  it('a watermark older than five minutes is re-read whole — foreign deletions cannot outlive the clock', async () => {
    vi.useFakeTimers()
    try {
      let rev = 7
      const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
      await readSnapshotCached(f.zoho)
      rev = 8
      vi.setSystemTime(Date.now() + 6 * 60_000) // past FULL_REREAD_MS
      const s2 = await readSnapshotCached(f.zoho)
      expect(s2.revision).toBe('8')
      expect(f.calls.fetchAll[LED.id]).toBe(2) // the reconciliation clock fired
      expect(f.calls.fetchSince[LED.id] ?? 0).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a commit landing mid-WARM-sweep is returned but cached nowhere — the next call re-sweeps, the one after serves', async () => {
    let rev = 7
    const flip = { on: false }
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      onFetchAll: (tableId) => {
        // the "commit" lands inside the sweep's vendors read — collections
        // full-read on every sweep, so this always fires mid-batch (ledger
        // deltas on a warm sweep and would never pass through here)
        if (tableId === VEND.id && flip.on) rev = 9
      },
    })
    await readSnapshotCached(f.zoho) // the cold sweep installs under 7
    rev = 8 // someone commits before the next call — its gate reads 8…
    flip.on = true
    const s1 = await readSnapshotCached(f.zoho) // gated on 8, read the config at 9
    expect(s1.revision).toBe('9') // the caller still gets the freshest plant
    const ledFull = f.calls.fetchAll[LED.id]
    const deltas = f.calls.fetchSince[LED.id] ?? 0
    const s2 = await readSnapshotCached(f.zoho) // nothing was installed — re-sweep
    expect(s2.revision).toBe('9')
    expect(s2.state?.ledger?.length).toBe(1)
    expect(f.calls.fetchSince[LED.id]).toBe(deltas + 1) // a real sweep ran again
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).toBe(s2) // now it serves
    expect(f.calls.fetchSince[LED.id]).toBe(deltas + 1) // zero reads — served whole
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull) // and ledger never full-read again
  })

  it('a commit landing mid-COLD-sweep installs under the stale token — the very next gate re-sweeps and the plant corrects', async () => {
    // The cold trade, pinned: the burst has no 27th read to catch a commit that
    // lands inside its few seconds, so the substrate installs under the
    // pre-commit token its leading Config read observed. That token is stale,
    // and the NEXT gate read — a client's 20s poll at the latest — sees the
    // revision has moved and re-sweeps. One bounded stale serve, once per
    // process, instead of every cold start parking a minute for the window.
    let rev: string | number = 7
    const flip = { on: false }
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      onFetchAll: (tableId) => {
        // the "commit" lands inside the vendors read — ahead of ledger in
        // TABLE_FOR, so ledger genuinely reads after it and sees its row
        if (tableId === VEND.id && flip.on) {
          rev = '8:late'
          f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:40:00.000Z', 7))
        }
      },
    })
    expect(Object.keys(TABLE_FOR).indexOf('vendors')).toBeLessThan(Object.keys(TABLE_FOR).indexOf('ledger'))
    flip.on = true
    const s1 = await readSnapshotCached(f.zoho) // cold: gate = the leading Config read, still 7
    expect(s1.revision).toBe('7') // installed under the pre-commit token
    expect(s1.state?.ledger?.length).toBe(2) // the mid-sweep commit's row IS visible
    const ledFull = f.calls.fetchAll[LED.id] ?? 0
    const s2 = await readSnapshotCached(f.zoho) // the gate reads 8:late ≠ 7 — re-sweep
    expect(s2.revision).toBe('8:late')
    expect(s2.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchAll[VEND.id]).toBe(2) // a real re-sweep: collections full-read
    expect(f.calls.fetchSince[LED.id] ?? 0).toBe(1) // ledger delta'd off the fresh watermark
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull) // no full re-read needed
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).toBe(s2) // corrected and serving
  })

  it('a QUIET warm re-sweep bursts: the full-Config gate seeds the sweep — no criteria read, no trailing Config, 26 reads total', async () => {
    // The production report this pins: the first snapshot after clearing cookies
    // on a warm instance took ~2 minutes (63.6s on the quiet dev log) because a
    // re-sweep is 27 reads — criteria gate plus 26 sweep reads — one over the
    // global window, the read that parked a minute. When the sweep window is
    // empty the gate IS the Config fetch and its rows seed the sweep: 25
    // burst-scope reads plus the gate is exactly 26, all instant.
    let rev: string | number = 7
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      burst: true,
    })
    const s1 = await readSnapshotCached(f.zoho) // cold sweep — canBurstSweep is not consulted
    expect(s1.revision).toBe('7')
    const cfgReadsAfterCold = f.calls.fetchAll[CFG.id] ?? 0 // 1: the cold leading gate
    rev = '8:moved'
    f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:45:00.000Z', 7))
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.revision).toBe('8:moved')
    expect(s2.state?.ledger?.length).toBe(2)
    // no criteria gate at all on the quiet path…
    expect(f.fetchByKeyIn.mock.calls.length).toBe(0)
    // …and Config was touched exactly once more — the gate fetch that SEEDED the
    // sweep. No trailing re-read inside it: gate + sweep = 26 reads, the window.
    expect(f.calls.fetchAll[CFG.id]).toBe(cfgReadsAfterCold + 1)
    // a real re-sweep happened: collections full-read, the delta table delta'd
    expect(f.calls.fetchAll[VEND.id]).toBe(2)
    expect(f.calls.fetchSince[LED.id]).toBe(1)
    // and the next serve is the gate-only cost: one Config fetch, revision
    // stands, the burst's install serves whole
    const ledFull = f.calls.fetchAll[LED.id] ?? 0
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).toBe(s2)
    expect(f.calls.fetchAll[CFG.id]).toBe(cfgReadsAfterCold + 2)
    expect(f.calls.fetchAll[VEND.id]).toBe(2)
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull)
  })

  it('a commit landing inside a QUIET re-sweep installs under the stale gate token — the next gate re-sweeps and corrects', async () => {
    // The warm twin of the cold trade above: the seeded Config IS the gate, so
    // the install's revision equals it by construction and a mid-sweep commit
    // is not detected — the substrate caches under the pre-commit token and the
    // NEXT gate (a client's 20s poll at the latest) sees the move and re-sweeps.
    let rev: string | number = 7
    const flip = { on: false }
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      burst: true,
      onFetchAll: (tableId) => {
        // the "commit" lands inside the sweep's vendors read — ahead of ledger
        // in TABLE_FOR, so ledger's delta genuinely reads after it
        if (tableId === VEND.id && flip.on) {
          rev = '9:late'
          f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:40:00.000Z', 7))
        }
      },
    })
    await readSnapshotCached(f.zoho) // the cold sweep installs under 7
    rev = 8
    flip.on = true
    const s1 = await readSnapshotCached(f.zoho) // gate read 8; the commit lands mid-batch
    expect(s1.revision).toBe('8') // single observation: installed under the now-stale gate
    expect(s1.state?.ledger?.length).toBe(2) // the mid-sweep row IS visible to the caller
    flip.on = false
    const s2 = await readSnapshotCached(f.zoho) // the gate reads 9:late ≠ 8 — re-sweep
    expect(s2.revision).toBe('9:late')
    expect(s2.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchAll[VEND.id]).toBe(3) // cold + burst + the corrective re-sweep
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).toBe(s2) // corrected and serving
  })

  it('the own-commit fast path under a QUIET gate refuses the seed — its trailing Config read stays the second observation', async () => {
    // The fast sweep is a handful of reads, so the 27-read arithmetic that
    // forces the seed on a FULL re-sweep does not apply to it: it re-reads
    // Config as its own trailing observation exactly as it always did, and only
    // its gate changed shape (a full fetch instead of a criteria row).
    let rev: string | number = 7
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      audits: [audRow('A1', '2026-09-30T08:00:00.000Z')],
      burst: true,
    })
    f.store[VEND.id] = [venRow('V1', 'Sriram')]
    await readSnapshotCached(f.zoho) // cold: 1 Config read
    noteRevision('base-test', '8:own')
    noteCommitApplied('base-test', '8:own', { removedTables: [], backdatedLedger: false, touchedTables: ['ledger', 'audits'] })
    invalidateSnapshotCache('8:own')
    rev = '8:own'
    f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:30:00.000Z', 7))
    f.store[AUD.id]!.push(audRow('A2', '2026-09-30T08:30:00.000Z'))
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.revision).toBe('8:own')
    expect(s2.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchSince[LED.id]).toBe(1) // the touched delta table still delta'd
    expect(f.calls.fetchAll[VEND.id]).toBe(1) // untouched: served from the substrate
    // cold leading read + the burst gate + the fast sweep's trailing read
    expect(f.calls.fetchAll[CFG.id]).toBe(3)
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).toBe(s2) // the fast install serves the next caller outright
  })

  it('invalidate semantics: own token keeps the substrate deltaing, foreign never serves the stale snap, bare forgets', async () => {
    let rev = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    const s1 = await readSnapshotCached(f.zoho)
    // own commit: the route invalidates with the commit's own token — no-op for
    // the cache, and the next sweep still DELTAS
    noteCommitApplied('base-test', '1:own', { removedTables: [], backdatedLedger: false, touchedTables: ['ledger'] })
    invalidateSnapshotCache('1:own')
    rev = 8
    f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:30:00.000Z', 7))
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchSince[LED.id]).toBe(1)
    // foreign token (an admin audit's own bump): the revision has NOT moved, but
    // the assembled state must never serve again and neither watermark is trusted
    invalidateSnapshotCache('2:foreign')
    const ledFull = f.calls.fetchAll[LED.id] ?? 0
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).not.toBe(s2) // snap was null — it re-assembled instead of serving
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull + 1) // forced full, no delta
    expect(f.calls.fetchSince[LED.id]).toBe(1)
    expect(s3.state?.ledger?.length).toBe(2) // same plant, rebuilt
    // bare: the process knows nothing — a cold full sweep
    invalidateSnapshotCache()
    const s4 = await readSnapshotCached(f.zoho)
    expect(s4.state?.ledger?.length).toBe(2)
    expect(f.calls.fetchAll[LED.id]).toBe(ledFull + 2)
    expect(f.calls.fetchSince[LED.id]).toBe(1)
    expect(s1.revision).toBe('7')
  })

  it('an older own token still reads as own after a newer commit — the mutex serializes writes, not the routes around them', async () => {
    let rev = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    await readSnapshotCached(f.zoho)
    // two commits land back-to-back; request A's route-level invalidate(T1) then
    // runs AFTER request B's commit minted T2 — T1 must not be mistaken for a
    // foreign token (which would roll lastKnownRevision back and force-full both
    // delta tables for nothing)
    noteRevision('base-test', '8:aaa') // commitChanges notes its bump before filing hints
    noteCommitApplied('base-test', '8:aaa', { removedTables: [], backdatedLedger: false, touchedTables: [] })
    noteRevision('base-test', '9:bbb')
    noteCommitApplied('base-test', '9:bbb', { removedTables: [], backdatedLedger: false, touchedTables: [] })
    expect(cachedRevision('base-test')).toBe('9:bbb') // the newer token, never the stale entry's 7
    invalidateSnapshotCache('8:aaa') // the late invalidate from request A
    expect(cachedRevision('base-test')).toBe('9:bbb') // no rollback to 8
    const ledFull = f.calls.fetchAll[LED.id] ?? 0
    const snap = await readSnapshotCached(f.zoho) // revision never moved (7)
    expect(snap.revision).toBe('7')
    expect(f.calls.fetchAll[LED.id] ?? 0).toBe(ledFull) // served the intact snap — no forced full
    expect(f.calls.fetchSince[LED.id] ?? 0).toBe(0)
  })

  it('the own-commit fast path reads only what the commit touched — the untouched substrate serves the rest', async () => {
    let rev: string | number = 7
    const f = fakeDelta({
      rev: () => rev,
      ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')],
      audits: [audRow('A1', '2026-09-30T08:00:00.000Z')],
    })
    f.store[VEND.id] = [venRow('V1', 'Sriram')]
    const s1 = await readSnapshotCached(f.zoho)
    expect(s1.state?.vendors?.length).toBe(1)
    // this process commits the moveStock shape — ledger lines and an audit row,
    // no collection behind them; vendors and every other master stand untouched
    noteRevision('base-test', '8:own') // commitChanges notes its bump first
    noteCommitApplied('base-test', '8:own', { removedTables: [], backdatedLedger: false, touchedTables: ['ledger', 'audits'] })
    invalidateSnapshotCache('8:own') // the route's invalidate: no-op, the marker survives
    rev = '8:own'
    f.store[LED.id]!.push(ledRow('L2', '2026-09-30T08:30:00.000Z', 7))
    f.store[AUD.id]!.push(audRow('A2', '2026-09-30T08:30:00.000Z'))
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.revision).toBe('8:own')
    expect(s2.state?.ledger?.length).toBe(2) // the touched delta table still delta'd
    expect(s2.state?.audits?.length).toBe(2)
    expect(s2.state?.vendors?.[0]?.name).toBe('Sriram') // the untouched collection served from the substrate
    expect(f.calls.fetchSince[LED.id]).toBe(1)
    expect(f.calls.fetchSince[AUD.id]).toBe(1)
    expect(f.calls.fetchAll[LED.id]).toBe(1) // never full-read again
    expect(f.calls.fetchAll[VEND.id]).toBe(1) // and vendors was not read at all
    const s3 = await readSnapshotCached(f.zoho)
    expect(s3).toBe(s2) // the fast install serves the next caller outright
  })

  it('two own commits since the substrate break the proof — the sweep full-reads instead', async () => {
    let rev: string | number = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    f.store[VEND.id] = [venRow('V1', 'Sriram')]
    await readSnapshotCached(f.zoho)
    noteRevision('base-test', '8:a')
    noteCommitApplied('base-test', '8:a', { removedTables: [], backdatedLedger: false, touchedTables: ['ledger'] })
    noteRevision('base-test', '9:b')
    noteCommitApplied('base-test', '9:b', { removedTables: [], backdatedLedger: false, touchedTables: ['ledger'] })
    invalidateSnapshotCache('9:b')
    rev = '9:b'
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.revision).toBe('9:b')
    // gate 9 = substrate 7 + 2: the touched set names one commit's tables, not
    // the union of two — the middle commit's writes are not proven covered
    expect(f.calls.fetchAll[VEND.id]).toBe(2)
  })

  it('a foreign bump between the substrate and our own commit disqualifies the fast path — the arithmetic catches it', async () => {
    let rev: string | number = 7
    const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    f.store[VEND.id] = [venRow('V1', 'Sriram')]
    await readSnapshotCached(f.zoho)
    // a colleague's instance committed (8), then ours read THEIR revision and
    // bumped to 9 — the gate is our own token, but the base moved twice since
    // the substrate and only one of those moves is ours
    noteRevision('base-test', '9:own')
    noteCommitApplied('base-test', '9:own', { removedTables: [], backdatedLedger: false, touchedTables: ['ledger'] })
    invalidateSnapshotCache('9:own')
    rev = '9:own'
    const s2 = await readSnapshotCached(f.zoho)
    expect(s2.revision).toBe('9:own')
    expect(f.calls.fetchAll[VEND.id]).toBe(2) // full sweep — the colleague's vendor edit is read
  })

  it('the reconciliation clock gates the fast path — verifiedAt survives fast installs, so hand edits cannot outlive five minutes', async () => {
    vi.useFakeTimers()
    try {
      let rev: string | number = 7
      const f = fakeDelta({ rev: () => rev, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
      f.store[VEND.id] = [venRow('V1', 'Sriram')]
      await readSnapshotCached(f.zoho) // the full sweep — verifiedAt = now
      const own = (token: string) => {
        noteRevision('base-test', token)
        noteCommitApplied('base-test', token, { removedTables: [], backdatedLedger: false, touchedTables: ['ledger'] })
        rev = token
      }
      own('8:one')
      await readSnapshotCached(f.zoho) // fast — verifiedAt PRESERVED through the install
      vi.setSystemTime(Date.now() + 4 * 60_000)
      own('9:two')
      await readSnapshotCached(f.zoho) // 4min since the last FULL sweep: fast again
      expect(f.calls.fetchAll[VEND.id]).toBe(1) // still never re-read
      vi.setSystemTime(Date.now() + 2 * 60_000) // 6min past the last FULL sweep
      own('10:three')
      const s = await readSnapshotCached(f.zoho)
      expect(s.revision).toBe('10:three')
      expect(f.calls.fetchAll[VEND.id]).toBe(2) // the clock refused the fast path
    } finally {
      vi.useRealTimers()
    }
  })

  it('cachedLedgerWatermark: null cold, the watermark once installed, null for another base', async () => {
    expect(cachedLedgerWatermark('base-test')).toBeNull()
    const f = fakeDelta({ rev: () => 7, ledger: [ledRow('L1', '2026-09-30T08:00:00.000Z')] })
    await readSnapshotCached(f.zoho)
    expect(cachedLedgerWatermark('base-test')).toBe('2026-09-30T08:00:00.000Z')
    expect(cachedLedgerWatermark('base-other')).toBeNull()
  })
})

describe('readRevisionMemoized', () => {
  /** The one-row criteria read the poll route makes, counted. */
  const fakeZoho = (rev: () => number) => {
    const config = LIVE_T['Config']
    const fetchByKeyIn = vi.fn(async (_tableId: string, _keyFieldId: string, values: readonly string[]) =>
      values.includes('app_revision')
        ? [{ recordID: 'k1', data: { [config.fields['Setting']]: 'app_revision', [config.fields['Value']]: String(rev()) } }]
        : [],
    )
    return { zoho: { baseId: 'base-test', fetchByKeyIn } as unknown as ZohoClient, fetchByKeyIn }
  }

  beforeEach(() => invalidateSnapshotCache())

  it('shares one read between concurrent pollers — the 20-second poll is the commonest call in the plant', async () => {
    const { zoho, fetchByKeyIn } = fakeZoho(() => 7)
    const [a, b, c] = await Promise.all([
      readRevisionMemoized(zoho),
      readRevisionMemoized(zoho),
      readRevisionMemoized(zoho),
    ])
    expect(a).toBe('7')
    expect(b).toBe('7')
    expect(c).toBe('7')
    expect(fetchByKeyIn.mock.calls.length).toBe(1) // single-flighted, not one per poller
  })

  it('serves the memo within its TTL and reads again once it expires', async () => {
    let rev = 7
    const { zoho, fetchByKeyIn } = fakeZoho(() => rev)
    expect(await readRevisionMemoized(zoho)).toBe('7')
    expect(await readRevisionMemoized(zoho)).toBe('7')
    expect(fetchByKeyIn.mock.calls.length).toBe(1) // the TTL held
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 5_000) // past the 4s TTL
      rev = 8
      expect(await readRevisionMemoized(zoho)).toBe('8')
      expect(fetchByKeyIn.mock.calls.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves a just-written token at once after an invalidate — the committing process knows the newest revision', async () => {
    const { zoho, fetchByKeyIn } = fakeZoho(() => 7)
    await readRevisionMemoized(zoho) // baseId is now known to the module
    invalidateSnapshotCache('9:abcdef')
    expect(await readRevisionMemoized(zoho)).toBe('9:abcdef')
    expect(fetchByKeyIn.mock.calls.length).toBe(1) // the memo served it, no read
  })
})

describe('projectSnapshot — one substrate, each caller their own view', () => {
  /**
   * Read-side authorization (the audit's S2-6). The substrate is assembled once
   * per revision and shared by EVERY caller, so a caller's page scope can only
   * be applied as a per-request projection: drop the tables they may not read,
   * name them in `withheld` for the client to bridge back (sync.ts
   * restoreWithheld). What must never happen is as interesting as what must —
   * the shared state object is never narrowed, and the withheld list is a
   * function of the permission set alone, never of which tables hold rows.
   */
  const SUPPLIERS_CLERK = ['page.vendors']
  const LAB_TESTER = ['page.quality', 'page.control-samples', 'page.reports', 'page.test-parameters']
  const EVERY_PAGE = PAGE_CATALOG.map((p) => p.slug)

  const fullSnap = () =>
    assemble({
      grns: [rec('GRN-1', { id: 'GRN-1', lot: 'LOT-1' })],
      vendors: [rec('V-1', { id: 'V-1', name: 'Sriram', phone: '98450 00001', email: 'sriram@farm.example' })],
      customers: [rec('C-1', { id: 'C-1', name: 'Hotel Aroma', gst: '29ABCDE1234F1Z5', phone: '99000 00002', contactPerson: 'Ravi' })],
      ledger: [rec('L-1', { id: 'L-1', type: 'GRN', qty_in: 100 })],
      audits: [rec('A-1', { id: 'A-1', action: 'posted' })],
      counters: [{ recordID: 'c1', data: { 'f-series': 'grn', 'f-next': '5' } }],
      config: [
        { recordID: 'k1', data: { 'f-set': 'app_config', 'f-val': JSON.stringify({ company: 'Roligt' }) } },
      ],
    })

  it('withholds exactly the pages a scoped caller does not hold — nothing more', () => {
    // the operator (no page slugs) and a full administrator read the whole plant
    expect(withheldForCaller([])).toEqual([])
    expect(withheldForCaller(EVERY_PAGE)).toEqual([])
    // a suppliers clerk: the day's work they do not hold, and the audit trail —
    // but never the masters they hold, or the ledger and counters their own
    // page's postings need
    const clerk = withheldForCaller(SUPPLIERS_CLERK)
    expect(clerk).toContain('grns')
    expect(clerk).toContain('audits')
    expect(clerk).not.toContain('vendors')
    expect(clerk).not.toContain('ledger')
    expect(clerk).not.toContain('counters')
    // a lab tester holds quality, control-samples and reports: their verdicts,
    // runs and lab reports stay readable; procurement's receipts do not
    const lab = withheldForCaller(LAB_TESTER)
    expect(lab).not.toContain('qcs')
    expect(lab).not.toContain('packingRuns')
    expect(lab).not.toContain('labReports')
    expect(lab).toContain('grns')
  })

  it('projects the state per caller — dropped keys named in withheld, the rest served', () => {
    const snap = fullSnap()
    const view = projectSnapshot(snap, SUPPLIERS_CLERK)
    expect(view.revision).toBe(snap.revision)
    expect(view.state && 'grns' in view.state).toBe(false)
    expect(view.state && 'audits' in view.state).toBe(false)
    expect(view.state?.vendors?.[0]?.name).toBe('Sriram')
    expect(view.state?.ledger?.[0]?.qtyIn).toBe(100)
    expect(view.withheld).toEqual(withheldForCaller(SUPPLIERS_CLERK))
  })

  it('never narrows the shared substrate — the next caller still gets the whole plant', () => {
    const snap = fullSnap()
    const scoped = projectSnapshot(snap, SUPPLIERS_CLERK)
    expect(scoped.state && 'grns' in scoped.state).toBe(false)
    // the substrate's own state object is untouched by the projection above…
    expect(snap.state?.grns?.length).toBe(1)
    expect(snap.state?.vendors?.[0]?.phone).toBe('98450 00001')
    // …so the very next caller holding every page is served the SAME object,
    // whole — masters contacts included
    const whole = projectSnapshot(snap, EVERY_PAGE)
    expect(whole.state).toBe(snap.state)
    expect(whole.withheld).toEqual([])
  })

  it('masks masters contacts for callers without the master\'s own page (Phase 4)', () => {
    // the open tier keeps every master's identity — names resolve everywhere —
    // but a phone book is not reference data: vendors' phone/email and
    // customers' GSTIN/phone/contact person travel only with their pages
    const snap = fullSnap()
    const operator = projectSnapshot(snap, [])
    expect(operator.state?.vendors?.[0]?.name).toBe('Sriram')
    expect('phone' in (operator.state?.vendors?.[0] ?? {})).toBe(false)
    expect('email' in (operator.state?.vendors?.[0] ?? {})).toBe(false)
    expect(operator.state?.customers?.[0]?.name).toBe('Hotel Aroma')
    expect('gst' in (operator.state?.customers?.[0] ?? {})).toBe(false)
    expect('contactPerson' in (operator.state?.customers?.[0] ?? {})).toBe(false)
    // a lab tester holds neither masters page — masked the same way, on top of
    // the day's work their scope already withholds
    const lab = projectSnapshot(snap, LAB_TESTER)
    expect('phone' in (lab.state?.vendors?.[0] ?? {})).toBe(false)
    // masked fields are not withheld keys — the client must not bridge them
    // back from a stale mirror, and only whole TABLES ride that list
    expect(operator.withheld).toEqual([])
    // the page holder sees everything: the Suppliers page IS the phone book
    const clerk = projectSnapshot(snap, SUPPLIERS_CLERK)
    expect(clerk.state?.vendors?.[0]?.phone).toBe('98450 00001')
    expect(clerk.state?.vendors?.[0]?.email).toBe('sriram@farm.example')
    // their customers stay masked — the Suppliers tick is not the Customers page
    expect('gst' in (clerk.state?.customers?.[0] ?? {})).toBe(false)
  })

  it('answers the same withheld list for an empty plant and a full one — no data-presence leak', () => {
    const empty = assemble({
      grns: [], vendors: [], ledger: [], audits: [], counters: [], config: [],
    })
    expect(empty.state).toBeNull()
    // a caller must not learn WHICH tables hold rows from the shape of the
    // refusal — the list depends on their permissions and nothing else
    expect(projectSnapshot(empty, SUPPLIERS_CLERK).withheld).toEqual(
      projectSnapshot(fullSnap(), SUPPLIERS_CLERK).withheld,
    )
    expect(projectSnapshot(empty, SUPPLIERS_CLERK).state).toBeNull()
  })
})
