import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitChanges, Conflict, Forbidden, validateChanges } from './commit.js'
import { invalidateSnapshotCache, readSnapshotCached } from './snapshot.js'
import { T } from './baseSchema.js'
import { ZohoApiError, ZohoLockedError } from './zoho.js'
import type { ZohoClient, ZohoRecord } from './zoho.js'
import type { Caller } from './auth.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'

type Upsert = { table: string; key: string; values: Record<string, string> }

function fakeZoho(existing: ZohoRecord[] = []) {
  const ops: { upserts: Upsert[]; deletes: { table: string; recordId: string }[] } = { upserts: [], deletes: [] }
  // per-table read counters — the commit-hint tests prove a hinted sweep FULL-reads
  // (and an unhinted one deltas) by counting which reader fired
  const calls = { fetchAll: {} as Record<string, number>, fetchSince: {} as Record<string, number> }
  const zoho = {
    baseId: 'base-test',
    fetchAll: async (tableId: string) => {
      calls.fetchAll[tableId] = (calls.fetchAll[tableId] ?? 0) + 1
      return existing.filter((r) => r.data.__table === tableId)
    },
    // the delta read, semantically: rows whose Data JSON `at` sits at or past the
    // watermark (boundary row included — what the hour-bucket delta delivers)
    fetchSince: async (tableId: string, jsonFieldId: string, sinceISO: string) => {
      calls.fetchSince[tableId] = (calls.fetchSince[tableId] ?? 0) + 1
      return existing.filter((r) => {
        if (r.data.__table !== tableId) return false
        try {
          const at = (JSON.parse(String(r.data[jsonFieldId])) as { at?: unknown }).at
          return typeof at === 'string' && at >= sinceISO
        } catch {
          return false
        }
      })
    },
    // criteria-scoped read — the pre-flight reads exactly the touched rows, not
    // the whole table, and must see what earlier commits in this test wrote
    fetchByKeyIn: async (tableId: string, keyFieldId: string, values: readonly unknown[]) =>
      existing.filter(
        (r) => r.data.__table === tableId && values.some((v) => String(r.data[keyFieldId]) === String(v)),
      ),
    // like the live API: a keyed upsert creates the row or replaces it in place, so a
    // later fetchAll sees what an earlier commit wrote — retries must observe that
    upsertByKey: async (tableId: string, keyFieldId: string, keyValue: string, values: Record<string, unknown>) => {
      ops.upserts.push({ table: tableId, key: keyValue, values: values as Record<string, string> })
      const row = existing.find((r) => r.data.__table === tableId && String(r.data[keyFieldId]) === keyValue)
      if (row) Object.assign(row.data, values)
      else existing.push({ recordID: `z-${existing.length + 1}`, data: { __table: tableId, ...values } })
    },
    deleteRecord: async (tableId: string, recordId: string) => {
      ops.deletes.push({ table: tableId, recordId })
      const i = existing.findIndex((r) => r.data.__table === tableId && r.recordID === recordId)
      if (i >= 0) existing.splice(i, 1)
    },
  } as unknown as ZohoClient
  return { zoho, ops, calls }
}

const admin: Caller = { email: 'boss@roligt.local', permissions: [...PERMISSIONS] }
const operator: Caller = { email: 'op@roligt.local', permissions: [] }
/**
 * A suppliers clerk — one masters page and nothing else. Their tick carries
 * that page's master writes; the day's work is NOT open to them, because any
 * page tick scopes the caller (the operator is the caller with no ticks).
 */
const suppliersClerk: Caller = { email: 'supplies@roligt.local', permissions: ['page.vendors'] }
/** The lab tester: every quality page, no manage permission at all. */
const labTester: Caller = {
  email: 'lab@roligt.local',
  permissions: ['page.quality', 'page.control-samples', 'page.reports', 'page.test-parameters'],
}
/** A procurement clerk — one page, the runtime-composed role this whole gate exists for. */
const procurementClerk: Caller = { email: 'buy@roligt.local', permissions: ['page.procurement'] }

/** The stored config row the per-key gate diffs against. */
const STORED_CONFIG = { tolerances: { lab: 5 }, testCategories: [{ key: 'sensory', title: 'Sensory' }] }
function configRow(stored: unknown): ZohoRecord {
  const config = T['Config']
  return {
    recordID: 'z-cfg',
    data: {
      __table: config.id,
      [config.fields['Setting']]: 'app_config',
      [config.fields['Value']]: JSON.stringify(stored),
    },
  }
}

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
    const { token: rev, wrote } = await commitChanges(zoho, admin, CHANGES)
    expect(rev).toMatch(/^1:/) // a token, unique per write — never a bare number again
    expect(wrote).toBe(true)
    const keys = ops.upserts.map((u) => u.key)
    expect(keys).toContain('GRN-2026-0001')
    expect(keys).toContain('L1')
    expect(keys).toContain('A1')
    expect(keys).toContain('grn') // counter, keyed by Series
    expect(keys.at(-1)).toBe('app_revision') // bumped last, so a reader never sees a torn plant
    expect(ops.deletes).toEqual([])
    // every upsert carries the row's own business key in its App ID field
    const grn = ops.upserts.find((u) => u.key === 'GRN-2026-0001')!
    expect(grn.table).toBe(T['GRNs'].id)
    expect(grn.values[T['GRNs'].appId]).toBe('GRN-2026-0001')
    expect(grn.values[T['GRNs'].dataJson!]).toContain('LOT-1')
    const ledger = ops.upserts.find((u) => u.key === 'L1')!
    expect(ledger.table).toBe(T['Ledger'].id)
    expect(ledger.values[T['Ledger'].dataJson!]).toContain('"qty_in":90')
    const counter = ops.upserts.find((u) => u.key === 'grn')!
    expect(counter.values[T['Counters'].fields['Next']]).toBe('1')
  })

  it('refuses operator writes to permission-gated tables', async () => {
    const { zoho } = fakeZoho()
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [{ table: 'vendors', upsert: [{ id: 'V-1', data: {} }], remove: [] }] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('a scoped masters clerk writes their page — nothing else, not even the day\'s work', async () => {
    const { zoho } = fakeZoho()
    // the tick carries its page's master writes (a masters save moves no counters —
    // the ride-along gate below refuses one that claims to)
    const { token: rev } = await commitChanges(zoho, suppliersClerk, {
      ...CHANGES,
      tables: [{ table: 'vendors', upsert: [{ id: 'V-1', data: {} }], remove: [] }],
      counters: {},
    })
    expect(rev).toBeTypeOf('string')
    // …but not another page's masters table, nor the staff register (the Roster page's)
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [{ table: 'items', upsert: [{ id: 'IT-1', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('items'))
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [{ table: 'staff', upsert: [{ id: 'S-1', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('staff'))
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [], counters: {}, config: { tolerances: { lab: 5 } } }),
    ).rejects.toMatchObject(new Forbidden('app_config tolerances'))
    // and the day's work is closed: any page tick scopes the caller
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [{ table: 'grns', upsert: [{ id: 'GRN-9', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('grns'))
  })

  it('refuses operator writes to config', async () => {
    const { zoho, ops } = fakeZoho()
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [], config: { tolerances: { lab: 5 } } }),
    ).rejects.toMatchObject(new Forbidden('app_config tolerances'))
    expect(ops.upserts).toEqual([]) // refused before a single write landed
  })

  it('lets the lab tester write test parameters — and only those masters tables', async () => {
    const { zoho } = fakeZoho()
    const params = [{ table: 'test_parameters', upsert: [{ id: 'TP-1', data: { name: 'pH' } }], remove: [] }]
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: params, counters: {} }),
    ).resolves.toMatchObject({ token: expect.any(String), wrote: true })
    await expect(commitChanges(zoho, operator, { ...CHANGES, tables: params })).rejects.toBeInstanceOf(Forbidden)
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [{ table: 'vendors', upsert: [{ id: 'V-9', data: {} }], remove: [] }] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('lets the lab tester change only the testCategories key of config', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    // whole-object payload, as sync sends it: tolerances identical, types edited
    const { token: rev } = await commitChanges(zoho, labTester, {
      ...CHANGES,
      tables: [],
      counters: {},
      config: { ...STORED_CONFIG, testCategories: [{ key: 'sensory', title: 'Sensory Evaluation' }] },
    })
    expect(rev).toBeTypeOf('string')
    expect(ops.upserts.some((u) => u.key === 'app_config')).toBe(true)
  })

  it('refuses the lab tester any other config key — and a payload that would drop one', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    // a tolerance change riding along in the same whole-object payload
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], counters: {}, config: { ...STORED_CONFIG, tolerances: { lab: 9 } } }),
    ).rejects.toMatchObject(new Forbidden('app_config tolerances'))
    // the storage page's own config key is not the lab's
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], counters: {}, config: { ...STORED_CONFIG, defaultAreas: { produce: 'A1' } } }),
    ).rejects.toMatchObject(new Forbidden('app_config defaultAreas'))
    // a crafted partial payload: the write replaces the whole row, so the keys it
    // omits count as changes, not as "leave those alone"
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], counters: {}, config: { testCategories: STORED_CONFIG.testCategories } }),
    ).rejects.toMatchObject(new Forbidden('app_config tolerances'))
    await expect(commitChanges(zoho, labTester, { ...CHANGES, tables: [], counters: {}, config: {} })).rejects.toMatchObject(
      new Forbidden('app_config tolerances'),
    )
    expect(ops.upserts).toEqual([]) // nothing landed from any of the refused commits
  })

  it('narrows a page-scoped caller: the procurement clerk writes GRNs, nothing else', async () => {
    const { zoho, ops } = fakeZoho()
    // the whole day's-work shape — doc, ledger line, audit, counter — rides through
    const { token: rev } = await commitChanges(zoho, procurementClerk, CHANGES)
    expect(rev).toBeTypeOf('string')
    expect(ops.upserts.some((u) => u.key === 'L1')).toBe(true) // the ledger line landed
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [{ table: 'qcs', upsert: [{ id: 'QC-1', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('qcs'))
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [{ table: 'lab_reports', upsert: [{ id: 'LR-1', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('lab_reports'))
  })

  it('either page of a two-page table is enough — packing runs and control samples share it', async () => {
    const { zoho } = fakeZoho()
    const runs = { table: 'packing_runs', upsert: [{ id: 'PR-1', data: {} }], remove: [] }
    await expect(commitChanges(zoho, { email: 'pack@roligt.local', permissions: ['page.packing'] }, { ...CHANGES, tables: [runs] })).resolves.toMatchObject({ token: expect.any(String), wrote: true })
    // the control samples ARE fields on the run — the lab tester writes it too.
    // This is the identical run the packer just posted, so the lab tester's
    // commit is admitted and lands nothing: wrote false, revision unmoved.
    await expect(commitChanges(zoho, labTester, { ...CHANGES, tables: [runs] })).resolves.toMatchObject({ wrote: false })
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [runs] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('never applies the page gate to an unscoped caller — the day\'s work stays open', async () => {
    const { zoho } = fakeZoho()
    // the operator (no ticks at all) writes the whole day's work freely
    await expect(commitChanges(zoho, operator, CHANGES)).resolves.toMatchObject({ token: expect.any(String), wrote: true })
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [{ table: 'qcs', upsert: [{ id: 'QC-2', data: {} }], remove: [] }] }),
    ).resolves.toMatchObject({ token: expect.any(String), wrote: true })
  })

  it('a page.storage caller edits the areas and their defaults; an operator cannot', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    const storekeeper = { email: 'store@roligt.local', permissions: ['page.storage'] } as Caller
    const { token: rev } = await commitChanges(zoho, storekeeper, {
      ...CHANGES,
      tables: [{ table: 'storage_locations', upsert: [{ id: 'SL-1', data: {} }], remove: [] }],
      counters: {},
      config: { ...STORED_CONFIG, defaultAreas: { produce: 'Cold Room' } },
    })
    expect(rev).toBeTypeOf('string')
    expect(ops.upserts.some((u) => u.key === 'app_config')).toBe(true)
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [{ table: 'storage_locations', upsert: [{ id: 'SL-2', data: {} }], remove: [] }] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('refuses operator removals from the audit trail', async () => {
    const { zoho, ops } = fakeZoho()
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [{ table: 'audits', upsert: [], remove: ['A1'] }] }),
    ).rejects.toMatchObject(new Forbidden('audits'))
    expect(ops.deletes).toEqual([]) // the trail is insert-only for operators
  })

  it('operator cannot delete audits via duplicate entries', async () => {
    const existing: ZohoRecord[] = [
      { recordID: 'z-a1', data: { __table: T['Audit Log'].id, [T['Audit Log'].appId]: 'A1' } },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await expect(
      commitChanges(zoho, operator, {
        ...CHANGES,
        tables: [
          { table: 'audits', upsert: [], remove: [] },
          { table: 'audits', upsert: [], remove: ['A1'] },
        ],
      }),
    ).rejects.toMatchObject(new Forbidden('audits'))
    expect(ops.deletes).toEqual([]) // the first empty audits block must not shield the second
  })

  it('allows an admin to change config and remove audit rows', async () => {
    const existing: ZohoRecord[] = [
      { recordID: 'z-a1', data: { __table: T['Audit Log'].id, [T['Audit Log'].appId]: 'A1' } },
    ]
    const { zoho, ops } = fakeZoho(existing)
    const { token: rev } = await commitChanges(zoho, admin, {
      empty: false,
      tables: [{ table: 'audits', upsert: [], remove: ['A1'] }],
      counters: {},
      config: { tolerances: { lab: 5 } },
    })
    expect(rev).toBeTypeOf('string') // no throw
    expect(ops.deletes).toEqual([{ table: T['Audit Log'].id, recordId: 'z-a1' }])
    expect(ops.upserts.some((u) => u.key === 'app_config')).toBe(true)
  })

  it('retries never duplicate and never error — landed rows are skipped outright, existing audits are skipped', async () => {
    const { zoho, ops } = fakeZoho()
    await commitChanges(zoho, admin, CHANGES)
    const firstLedgerWrites = ops.upserts.filter((u) => u.key === 'L1').length
    ops.upserts.length = 0
    ops.deletes.length = 0
    await commitChanges(zoho, admin, CHANGES) // must not throw: a retry after a partial failure is the normal case
    expect(firstLedgerWrites).toBe(1)
    expect(ops.deletes).toEqual([])
    // a row that landed identically is skipped, not re-written — and a row whose
    // write was lost does not exist, so it writes; either way exactly one line
    expect(ops.upserts.filter((u) => u.key === 'L1')).toHaveLength(0)
    expect(ops.upserts.some((u) => u.key === 'A1')).toBe(false) // the audit row exists now → skipped, history stays as first written
  })

  it('performs zero writes for an all-identical commit and returns the unchanged token', async () => {
    const { zoho, ops } = fakeZoho()
    const first = await commitChanges(zoho, admin, CHANGES)
    expect(first.wrote).toBe(true)
    ops.upserts.length = 0 // the log, not the store — the base still holds the first commit
    // The same commit again, unchanged in every row: every write the loop would
    // make is skipped (rows identical, audit row exists, counter already at 1),
    // so the revision must not move either — a bump would order every device in
    // the plant to re-sweep a base that never changed.
    const again = await commitChanges(zoho, admin, CHANGES)
    expect(again).toEqual({ token: first.token, wrote: false })
    expect(ops.upserts).toEqual([]) // not even app_revision
  })

  it('skips audit upserts whose App ID already exists — a crafted commit cannot rewrite the trail', async () => {
    const existing: ZohoRecord[] = [
      { recordID: 'z-a1', data: { __table: T['Audit Log'].id, [T['Audit Log'].appId]: 'A1' } },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await commitChanges(zoho, admin, CHANGES) // CHANGES re-posts audit A1 with edited details
    expect(ops.upserts.some((u) => u.key === 'A1')).toBe(false) // insert-only: the existing row is never touched
  })

  it('writes audit rows with new App IDs while skipping existing ones', async () => {
    const existing: ZohoRecord[] = [
      { recordID: 'z-a1', data: { __table: T['Audit Log'].id, [T['Audit Log'].appId]: 'A1' } },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await commitChanges(zoho, admin, {
      ...CHANGES,
      tables: [
        ...CHANGES.tables.filter((t) => t.table !== 'audits'),
        {
          table: 'audits',
          upsert: [
            { id: 'A1', at: '2026-09-21T08:00:00Z', actor: 'Mallory', action: 'tampered', doc: 'GRN-2026-0001', details: 'rewritten' },
            { id: 'A2', at: '2026-09-21T09:00:00Z', actor: 'Admin', action: 'posted', doc: 'GRN-2026-0001', details: 'second entry' },
          ],
          remove: [],
        },
      ],
    })
    expect(ops.upserts.filter((u) => u.table === T['Audit Log'].id).map((u) => u.key)).toEqual(['A2'])
  })

  it('translates mapper columns to field IDs — the wire speaks IDs, not names', async () => {
    const { zoho, ops } = fakeZoho()
    await commitChanges(zoho, admin, CHANGES)
    // upsertByKey sends is_ids_used_in_data: true, so every data key must be a field
    // ID. A field NAME in that map is read as a bogus ID and the live API answers
    // 500 INTERNAL SERVER ERROR — pinned against the scratch base 2026-09-22.
    const grn = ops.upserts.find((u) => u.key === 'GRN-2026-0001')!
    expect(grn.values[T['GRNs'].fields['Total']]).toBe('100')
    expect(grn.values[T['GRNs'].fields['Status']]).toBe('Posted')
    expect('Total' in grn.values).toBe(false)
    expect('Status' in grn.values).toBe(false)
    const ledger = ops.upserts.find((u) => u.key === 'L1')!
    expect(ledger.values[T['Ledger'].fields['Qty In']]).toBe('90')
    expect('Qty In' in ledger.values).toBe(false)
    const audit = ops.upserts.find((u) => u.key === 'A1')!
    // stamped from the authenticated caller, not from the payload's claim
    expect(audit.values[T['Audit Log'].fields['Actor']]).toBe('boss@roligt.local')
    expect('Actor' in audit.values).toBe(false)
  })

  it('links a carrier to a master written in the SAME commit — the same-commit fixup', async () => {
    const { zoho, ops } = fakeZoho()
    // the raw-material save's exact shape: the item and its purchase product land
    // together, and the link maps were read before either existed
    await commitChanges(zoho, admin, {
      empty: false,
      tables: [
        { table: 'items', upsert: [{ id: 'RM-PP-0001', data: { id: 'RM-PP-0001', name: 'Tender Coconut', type: 'Raw Material', uom: 'Nos', lotControlled: true, reorder: 0, costMethod: 'Lot Actual' } }], remove: [] },
        { table: 'purchase_products', upsert: [{ id: 'PP-0001', data: { id: 'PP-0001', name: 'Tender Coconut', category: 'Farm Produce', uom: 'Nos', description: '', vendorIds: [], itemId: 'RM-PP-0001', status: 'Active' } }], remove: [] },
        // a ledger line names its item BY NAME — the merge must key names too
        { table: 'ledger', upsert: [{ id: 'L1', type: 'in', doc: 'GRN-2026-0001', item: 'Tender Coconut', item_type: 'Raw Material', lot: 'LOT-1', status: 'In Stock', qty_in: 90, qty_out: 0, unit_cost: 35, at: '2026-10-06T08:00:00Z', uom: 'Nos' }], remove: [] },
      ],
      counters: {},
    })
    const itemsRow = (await zoho.fetchAll(T['Items'].id)).find((r) => String(r.data[T['Items'].appId]) === 'RM-PP-0001')!
    expect(itemsRow).toBeTruthy()
    // the purchase product is written twice: once without the Item link, once —
    // after the maps learned this commit's own rows — with it
    const ppTable = T['Purchase Products']
    const ppWrites = ops.upserts.filter((u) => u.table === ppTable.id && u.key === 'PP-0001')
    expect(ppWrites).toHaveLength(2)
    expect(ppWrites[0]!.values[ppTable.fields['Item']]).toBeUndefined()
    expect(ppWrites[1]!.values[ppTable.fields['Item']]).toBe(itemsRow.recordID)
    // the re-send carries the whole row, not just the link
    expect(ppWrites[1]!.values[ppTable.appId]).toBe('PP-0001')
    expect(String(ppWrites[1]!.values[ppTable.dataJson!])).toContain('Tender Coconut')
    // the ledger line gains its Item link off the NAME key
    const ledgerTable = T['Ledger']
    const lWrites = ops.upserts.filter((u) => u.table === ledgerTable.id && u.key === 'L1')
    expect(lWrites).toHaveLength(2)
    expect(lWrites[1]!.values[ledgerTable.fields['Item']]).toBe(itemsRow.recordID)
  })

  it('does not re-send rows whose links all resolved on the first write', async () => {
    // GRN naming an item that already exists — no fixup writes expected
    const existing = [(() => {
      const t = T['Items']
      return { recordID: 'z-item-1', data: { __table: t.id, [t.appId]: 'RM-PP-0001', [t.dataJson!]: JSON.stringify({ id: 'RM-PP-0001', name: 'Tender Coconut' }) } }
    })()]
    const { zoho: z2, ops: ops2 } = fakeZoho(existing)
    await commitChanges(z2, admin, {
      empty: false,
      tables: [
        { table: 'grns', upsert: [{ id: 'GRN-2026-0002', data: { id: 'GRN-2026-0002', lot: 'LOT-2', farmerId: 'V-1', purchaseProductId: 'PP-0001', itemId: 'RM-PP-0001', location: 'Cold Room A', total: 100, accepted: 90, status: 'Posted' } }], remove: [] },
      ],
      counters: { grn: 2 },
    })
    const grnTable = T['GRNs']
    const grnWrites = ops2.upserts.filter((u) => u.table === grnTable.id && u.key === 'GRN-2026-0002')
    expect(grnWrites).toHaveLength(1)
    // and no ledger/table rows were re-sent at all beyond the single writes
    const rowWrites = ops2.upserts.filter((u) => u.key !== 'grn' && u.key !== 'app_revision')
    expect(rowWrites).toHaveLength(1)
  })

  it('the first vendors commit seeds the fixed vendor types and links the column', async () => {
    const { zoho, ops } = fakeZoho()
    const commitVendors = () =>
      commitChanges(zoho, admin, {
        empty: false,
        tables: [
          { table: 'vendors', upsert: [{ id: 'VEN-00001', data: { id: 'VEN-00001', name: 'Mandya Green Farms', vendorTypeId: 'VT-FARMER', phone: '+91 98450 12345', area: 'Mandya', payment: '15 days', status: 'Active' } }], remove: [] },
        ],
        counters: {},
      })
    await commitVendors()
    const vt = T['Vendor Types']
    const seed = ops.upserts.filter((u) => u.table === vt.id)
    expect(seed).toHaveLength(1)
    expect(seed[0]!.key).toBe('VT-FARMER')
    expect(seed[0]!.values[vt.fields['Name']]).toBe('Farmer')
    expect(seed[0]!.values[vt.fields['Source Kind']]).toBe('Farmer')
    expect(seed[0]!.values[vt.fields['Description']]).toBe('Produce suppliers')
    expect(seed[0]!.values[vt.appId]).toBe('VT-FARMER')
    // the vendor's own write carries the Vendor Type link to the seeded row
    const vendors = T['Vendors']
    const vendorWrite = ops.upserts.find((u) => u.table === vendors.id && u.key === 'VEN-00001')!
    const seededRec = (await zoho.fetchAll(vt.id)).find((r) => String(r.data[vt.appId]) === 'VT-FARMER')!
    expect(vendorWrite.values[vendors.fields['Vendor Type']]).toBe(seededRec.recordID)
    // the second vendors commit does not seed again — the row is in the maps now
    await commitVendors()
    expect(ops.upserts.filter((u) => u.table === vt.id)).toHaveLength(1)
  })

  it('a vendor type id the app does not know as fixed is never seeded', async () => {
    const { zoho, ops } = fakeZoho()
    await commitChanges(zoho, admin, {
      empty: false,
      tables: [
        { table: 'vendors', upsert: [{ id: 'VEN-00002', data: { id: 'VEN-00002', name: 'Odd One', vendorTypeId: 'VT-WEIRD', status: 'Active' } }], remove: [] },
      ],
      counters: {},
    })
    const vt = T['Vendor Types']
    expect(ops.upserts.filter((u) => u.table === vt.id)).toHaveLength(0)
    const vendors = T['Vendors']
    const vendorWrite = ops.upserts.find((u) => u.table === vendors.id && u.key === 'VEN-00002')!
    expect(vendorWrite.values[vendors.fields['Vendor Type']]).toBeUndefined()
  })

  it('stores period:* counters in Config, not Counters — Next is a number field that drops strings', async () => {
    // A period value is a STRING ('YYYY:2026'). Written to the Counters table's Next
    // column (a number field), Zoho silently drops it; it reads back empty, nextId's
    // period-change detector sees '' !== 'YYYY:2026' and resets the running number to
    // zero, and the next document reuses the previous code — whose upsert then
    // OVERWRITES the earlier row. Pinned live against the scratch base, 2026-09-22.
    const { zoho, ops } = fakeZoho()
    await commitChanges(zoho, admin, {
      empty: false,
      tables: [{ table: 'grns', upsert: [{ id: 'GRN-2026-0002', data: { id: 'GRN-2026-0002' } }], remove: [] }],
      counters: { grn: 2, 'period:grn': `YYYY:${new Date().getFullYear()}` },
    })
    const counterRows = ops.upserts.filter((u) => u.table === T['Counters'].id)
    expect(counterRows.some((u) => u.key === 'grn')).toBe(true)
    expect(counterRows.some((u) => u.key.startsWith('period:'))).toBe(false)
    const configRows = ops.upserts.filter((u) => u.table === T['Config'].id)
    const period = configRows.find((u) => u.key === 'period:grn')
    expect(period).toBeDefined()
    expect(period!.values[T['Config'].fields['Value']]).toBe(`YYYY:${new Date().getFullYear()}`)
  })

  it('deletes removed rows by resolving App IDs to record IDs', async () => {
    const existing: ZohoRecord[] = [
      { recordID: 'z-9', data: { __table: T['GRNs'].id, [T['GRNs'].appId]: 'GRN-OLD' } },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await commitChanges(zoho, admin, {
      empty: false,
      tables: [{ table: 'grns', upsert: [], remove: ['GRN-OLD'] }],
      counters: {},
    })
    expect(ops.deletes).toEqual([{ table: T['GRNs'].id, recordId: 'z-9' }])
  })

  // ---- the concurrency protocol: pre-flight refusal, monotonic counters, tokens ----

  /** A stored GRN row the way the live base holds it: App ID + Data JSON. */
  function storedGrn(id: string, doc: Record<string, unknown>): ZohoRecord {
    const t = T['GRNs']
    return {
      recordID: `z-${id}`,
      data: { __table: t.id, [t.appId]: id, ...(t.dataJson ? { [t.dataJson]: JSON.stringify(doc) } : {}) },
    }
  }

  it('refuses the whole commit when a row moved under the caller — and nothing lands', async () => {
    const base = { id: 'GRN-1', lot: 'LOT-1', total: 100, status: 'Posted' }
    // the stored row says 90: a colleague saved between this caller's read and write
    const { zoho, ops } = fakeZoho([storedGrn('GRN-1', { ...base, total: 90 })])
    await expect(
      commitChanges(zoho, admin, {
        ...CHANGES,
        tables: [
          {
            table: 'grns',
            upsert: [{ id: 'GRN-1', data: { ...base, total: 80 } }],
            remove: [],
            expect: { 'GRN-1': { id: 'GRN-1', data: base } },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(Conflict)
    expect(ops.upserts).toEqual([]) // refused before a single write, ledger included
  })

  it('lets the write through when the stored row still matches the expect base', async () => {
    const base = { id: 'GRN-1', lot: 'LOT-1', total: 100, status: 'Posted' }
    const { zoho, ops } = fakeZoho([storedGrn('GRN-1', base)])
    await commitChanges(zoho, admin, {
      ...CHANGES,
      tables: [
        {
          table: 'grns',
          upsert: [{ id: 'GRN-1', data: { ...base, status: 'Edited' } }],
          remove: [],
          expect: { 'GRN-1': { id: 'GRN-1', data: base } },
        },
      ],
    })
    expect(ops.upserts.some((u) => u.key === 'GRN-1')).toBe(true)
  })

  it('key order alone is never a conflict — the client rebuilds docs in its own order', async () => {
    // the live 409 of 2026-10-06: a purchase product's stored Data JSON keeps
    // CREATION order (…, vendorIds, itemId, status), while migrate rebuilds the
    // client's copy with status mid-object — stringified equality read the
    // client's own base as changed by another device, and every edit 409'd
    const creation = { id: 'PP-0001', name: 'Tender Coconut', category: 'Farm Produce', uom: 'Kg', description: '', vendorIds: ['VEN-00001'], itemId: 'RM-PP-0001', status: 'Active' }
    const rebuilt = { id: 'PP-0001', name: 'Tender Coconut', category: 'Farm Produce', uom: 'Kg', description: '', status: 'Active', vendorIds: ['VEN-00001'], itemId: 'RM-PP-0001' }
    const t = T['Purchase Products']
    const { zoho, ops } = fakeZoho([
      { recordID: 'z-pp', data: { __table: t.id, [t.appId]: 'PP-0001', [t.dataJson!]: JSON.stringify(creation) } },
    ])
    // the edit: new content, expect = the rebuilt-order base — must be admitted
    await commitChanges(zoho, admin, {
      empty: false,
      tables: [{
        table: 'purchase_products',
        upsert: [{ id: 'PP-0001', data: { ...rebuilt, description: 'links verified' } }],
        remove: [],
        expect: { 'PP-0001': { data: rebuilt } },
      }],
      counters: {},
    })
    expect(ops.upserts.some((u) => u.key === 'PP-0001')).toBe(true)
    // and the same content back in creation order is an idempotent skip — a
    // reordering alone is not a difference worth a write or a revision bump
    ops.upserts.length = 0
    const again = await commitChanges(zoho, admin, {
      empty: false,
      tables: [{
        table: 'purchase_products',
        upsert: [{ id: 'PP-0001', data: { ...creation, description: 'links verified' } }],
        remove: [],
        expect: { 'PP-0001': { data: creation } },
      }],
      counters: {},
    })
    expect(again.wrote).toBe(false)
  })

  it("refuses an insert whose minted code already exists — two devices can't post one number", async () => {
    // device B minted GRN-2026-0001 from the same stale counter and saved first;
    // its row is up there now, with B's farmer on it
    const theirs = { id: 'GRN-2026-0001', lot: 'LOT-B', farmerId: 'V-B', total: 50, accepted: 50, status: 'Posted' }
    const { zoho, ops } = fakeZoho([storedGrn('GRN-2026-0001', theirs)])
    await expect(commitChanges(zoho, admin, CHANGES)).rejects.toMatchObject({
      conflicts: [{ table: 'grns', id: 'GRN-2026-0001', kind: 'exists' }],
    })
    expect(ops.upserts).toEqual([]) // B's receipt is not replaced while both ledger lines would survive
  })

  it('never writes a counter backwards — stale mirrors heal instead of re-issuing numbers', async () => {
    const existing: ZohoRecord[] = [
      {
        recordID: 'z-c1',
        data: {
          __table: T['Counters'].id,
          [T['Counters'].fields['Series']]: 'grn',
          [T['Counters'].fields['Next']]: 5,
        },
      },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 3 } })
    expect(ops.upserts.filter((u) => u.table === T['Counters'].id)).toEqual([])
    ops.upserts.length = 0
    await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 5 } }) // equal is not a write
    expect(ops.upserts.filter((u) => u.table === T['Counters'].id)).toEqual([])
    ops.upserts.length = 0
    await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 6 } }) // forward still lands
    expect(ops.upserts.some((u) => u.key === 'grn')).toBe(true)
  })

  it('lets a genuine period reset move the counter backwards', async () => {
    // clock-agnostic: the claim is whatever this year computes to, the stored
    // row the year before — a real rollover whenever the suite runs
    const thisYear = `YYYY:${new Date().getFullYear()}`
    const lastYear = `YYYY:${new Date().getFullYear() - 1}`
    const existing: ZohoRecord[] = [
      {
        recordID: 'z-c1',
        data: {
          __table: T['Counters'].id,
          [T['Counters'].fields['Series']]: 'challan',
          [T['Counters'].fields['Next']]: 87,
        },
      },
      // last year's period, still recorded
      {
        recordID: 'z-p1',
        data: {
          __table: T['Config'].id,
          [T['Config'].fields['Setting']]: 'period:challan',
          [T['Config'].fields['Value']]: lastYear,
        },
      },
    ]
    const { zoho, ops } = fakeZoho(existing)
    await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { challan: 1, 'period:challan': thisYear } })
    const counter = ops.upserts.find((u) => u.key === 'challan')!
    expect(counter).toBeDefined()
    expect(counter.values[T['Counters'].fields['Next']]).toBe('1')
    const period = ops.upserts.find((u) => u.key === 'period:challan')!
    expect(period.values[T['Config'].fields['Value']]).toBe(thisYear)
  })

  it('refuses to rewind a counter on a forged period value — the claim must be the real current period', async () => {
    // the kill chain this closes: counters {grn: 1, 'period:grn': 'x'} used to
    // pass the mere String-inequality reset rule, write the junk period row and
    // rewind Next to 1 — every device then re-issued numbers whose upserts
    // OVERWROTE the original documents while their ledger lines dangled
    const existing: ZohoRecord[] = [
      {
        recordID: 'z-c1',
        data: {
          __table: T['Counters'].id,
          [T['Counters'].fields['Series']]: 'grn',
          [T['Counters'].fields['Next']]: 5,
        },
      },
      {
        recordID: 'z-p1',
        data: {
          __table: T['Config'].id,
          [T['Config'].fields['Setting']]: 'period:grn',
          [T['Config'].fields['Value']]: `YYYY:${new Date().getFullYear()}`,
        },
      },
    ]
    const { zoho, ops } = fakeZoho(existing)
    // a forged value, a stale one and a future one all move nothing — the
    // commit is admitted (the rows are legal), the numbering is not touched
    for (const claim of ['x', `YYYY:${new Date().getFullYear() - 1}`, 'YYYY:9999', 'NOTS:1|ATOKEN:2']) {
      ops.upserts.length = 0
      await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 1, 'period:grn': claim } })
      expect(ops.upserts.filter((u) => u.key === 'grn' || u.key === 'period:grn')).toEqual([])
    }
  })

  it('gates period:* counter keys like any counter — a scoped caller needs the document behind them', async () => {
    const { zoho } = fakeZoho()
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], counters: { 'period:grn': `YYYY:${new Date().getFullYear()}` } }),
    ).rejects.toMatchObject(new Forbidden('ledger'))
  })

  it('fails closed on a table with no permission spec of its own', async () => {
    // vendor_types and order_lines sit in TABLE_FOR but outside COLLECTIONS:
    // both permission loops used to skip them silently, leaving two live base
    // tables writable by any signed-in caller
    const { zoho, ops } = fakeZoho()
    await expect(
      commitChanges(zoho, admin, {
        ...CHANGES,
        tables: [{ table: 'vendor_types', upsert: [{ id: 'VT-1', data: {} }], remove: [] }],
      }),
    ).rejects.toMatchObject(new Forbidden('vendor_types'))
    await expect(
      commitChanges(zoho, admin, {
        ...CHANGES,
        tables: [{ table: 'order_lines', upsert: [], remove: ['OL-1'] }],
      }),
    ).rejects.toMatchObject(new Forbidden('order_lines'))
    expect(ops.upserts).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('mints a distinct revision token on every commit — no two writes ever compare equal', async () => {
    const { zoho } = fakeZoho()
    // two real writes (a no-op commit answers the unchanged token by design now)
    const a = await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 1 } })
    const b = await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 2 } })
    expect(a.wrote).toBe(true)
    expect(b.wrote).toBe(true)
    expect(a.token).not.toBe(b.token)
  })

  it('serializes commits — the second commit\'s whole window waits behind the first\'s writes', async () => {
    // ledger and audits carry no `expect`, so the pre-flight cannot see two commits
    // racing to post movements; the queue is the only thing that stops them
    // interleaving. Gate the first commit's first write and watch what the second
    // is allowed to do meanwhile: nothing, not even its pre-flight read.
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let gated = false
    const zoho = {
      fetchAll: async () => [],
      fetchByKeyIn: async (_t: string, _k: string, values: readonly unknown[]) => {
        events.push(`read:${values.join(',')}`)
        return []
      },
      upsertByKey: async (_t: string, _k: string, key: string) => {
        events.push(`write:${key}`)
        if (!gated) {
          gated = true
          await gate
        }
      },
      deleteRecord: async () => {},
    } as unknown as ZohoClient
    const flush = () => new Promise((r) => setImmediate(r))
    const a = commitChanges(zoho, admin, {
      ...CHANGES, tables: [{ table: 'grns', upsert: [{ id: 'GRN-A', data: { id: 'GRN-A' } }], remove: [] }], counters: {},
    })
    await flush()
    await flush()
    expect(events).toEqual(['read:GRN-A', 'write:GRN-A']) // A is parked inside its write
    const b = commitChanges(zoho, admin, {
      ...CHANGES, tables: [{ table: 'qcs', upsert: [{ id: 'QC-B', data: { id: 'QC-B' } }], remove: [] }], counters: {},
    })
    await flush()
    await flush()
    // B has not read a row: its check-then-act window never opened inside A's
    expect(events).toEqual(['read:GRN-A', 'write:GRN-A'])
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toMatchObject({ token: expect.any(String), wrote: true })
    expect(rb).toMatchObject({ token: expect.any(String), wrote: true })
    expect(events).toEqual([
      'read:GRN-A', 'write:GRN-A', // A's window, whole
      'write:app_revision', // A's bump lands after its gated write
      'read:QC-B', 'write:QC-B', 'write:app_revision', // then B's window, whole
    ])
  })

  it('a remove whose row vanished after pre-flight completes the commit; a lock still throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { zoho } = fakeZoho([storedGrn('GRN-OLD', { id: 'GRN-OLD' })])
    const remove = {
      empty: false,
      tables: [{ table: 'grns', upsert: [], remove: ['GRN-OLD'] }],
      counters: {},
      config: undefined,
    }
    // the delete refuses: something outside this process removed the row inside
    // our window — the outcome asked for is already true, so the commit completes
    zoho.deleteRecord = async () => {
      throw new ZohoApiError('DELETE /records', 404, 'record not found')
    }
    const { token: rev } = await commitChanges(zoho, admin, remove)
    expect(rev).toBeTypeOf('string')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GRN-OLD'))
    // a lock is an honest failure — it still rejects, never swallowed
    zoho.deleteRecord = async () => {
      throw new ZohoLockedError()
    }
    await expect(commitChanges(zoho, admin, remove)).rejects.toBeInstanceOf(ZohoLockedError)
    warn.mockRestore()
  })

  it('refuses a page-scoped caller who moves stock or counters with no document of their own', async () => {
    const { zoho, ops } = fakeZoho()
    // ledger lines alone — no collection change they hold a page for
    await expect(
      commitChanges(zoho, procurementClerk, {
        ...CHANGES,
        tables: [{ table: 'ledger', upsert: CHANGES.tables[1].upsert, remove: [] }],
      }),
    ).rejects.toMatchObject(new Forbidden('ledger'))
    // counters alone
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [], counters: { grn: 2 } }),
    ).rejects.toMatchObject(new Forbidden('ledger'))
    // but the same writes riding a GRN they hold are exactly the day's work
    const { token: rev } = await commitChanges(zoho, procurementClerk, CHANGES)
    expect(rev).toBeTypeOf('string')
    expect(ops.upserts.some((u) => u.key === 'L1')).toBe(true)
  })

  it('lets a page.storage holder commit the moveStock shape — ledger lines and an audit row, no document', async () => {
    const { zoho, ops } = fakeZoho()
    const storekeeper = { email: 'store@roligt.local', permissions: ['page.storage'] } as Caller
    // exactly what a stock move sends: two ledger lines and an audit row ride along
    // with no collection row to hang them on — the Storage page stands in for one
    const { token: rev } = await commitChanges(zoho, storekeeper, {
      ...CHANGES,
      tables: [CHANGES.tables[1], CHANGES.tables[2]], // ledger + audits only
      counters: {},
    })
    expect(rev).toBeTypeOf('string')
    expect(ops.upserts.some((u) => u.key === 'L1')).toBe(true)
    expect(ops.upserts.some((u) => u.key === 'A1')).toBe(true)
    // the allowance is upserts only: a move never deletes history, so a ledger
    // removal without a document behind it is refused even for the storekeeper
    await expect(
      commitChanges(zoho, storekeeper, {
        ...CHANGES,
        tables: [{ table: 'ledger', upsert: [], remove: ['L1'] }, CHANGES.tables[2]],
        counters: {},
      }),
    ).rejects.toMatchObject(new Forbidden('ledger'))
    expect(ops.deletes.filter((d) => d.table === T['Ledger'].id)).toEqual([]) // the refused removal landed nothing
    // and the exception is the Storage page's alone — the procurement clerk's
    // ledger-only commit stays refused
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [CHANGES.tables[1]], counters: {} }),
    ).rejects.toMatchObject(new Forbidden('ledger'))
  })

  it('refuses a crafted audit-only commit — the trail is not a page anyone may write', async () => {
    const { zoho, ops } = fakeZoho()
    // audits inserts passed any signed-in caller before the gate learned them: no
    // collection spec carries audits, so nothing stood between a scoped caller
    // and a fabricated trail row
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [CHANGES.tables[2]], counters: {} }),
    ).rejects.toMatchObject(new Forbidden('audits'))
    // the lab tester — four pages of their own — is no closer to the trail
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [CHANGES.tables[2]], counters: {} }),
    ).rejects.toMatchObject(new Forbidden('audits'))
    expect(ops.upserts).toEqual([]) // refused before a single write landed
  })

  it('lets a config change carry its audit row — and refuses the echo that rides nothing', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    // the honest shape of setTestCategoryStatus: config.testCategories moves under
    // the lab's own key and files its audit row, with no collection change behind it
    const edited = { ...STORED_CONFIG, testCategories: [{ key: 'sensory', title: 'Sensory Evaluation' }] }
    const { token: rev } = await commitChanges(zoho, labTester, {
      ...CHANGES,
      tables: [{ table: 'audits', upsert: [{ id: 'A2', at: '2026-09-21T10:00:00Z', actor: 'lab@roligt.local', action: 'Reactivated report type', doc: 'Sensory', details: '' }], remove: [] }],
      counters: {},
      config: edited,
    })
    expect(rev).toBeTypeOf('string')
    expect(ops.upserts.some((u) => u.key === 'A2')).toBe(true)
    expect(ops.upserts.some((u) => u.key === 'app_config')).toBe(true)
    // the echo trick: the same config again — identical to what is now stored, so
    // no key moves — must not stand as the ride for a second fabricated row
    const landed = ops.upserts.length
    await expect(
      commitChanges(zoho, labTester, {
        ...CHANGES,
        tables: [{ table: 'audits', upsert: [{ id: 'A3', at: '2026-09-21T10:05:00Z', actor: 'lab@roligt.local', action: 'posted', doc: 'GRN-2026-0001', details: 'never happened' }], remove: [] }],
        counters: {},
        config: edited,
      }),
    ).rejects.toMatchObject(new Forbidden('audits'))
    expect(ops.upserts.length).toBe(landed) // the refused echo wrote nothing
  })

  it('exempts a full administrator from the ride-along gate — housekeeping is their page', async () => {
    const { zoho, ops } = fakeZoho()
    await commitChanges(zoho, admin, { ...CHANGES, tables: [], counters: { grn: 4 } })
    expect(ops.upserts.some((u) => u.key === 'grn')).toBe(true)
  })
})

describe('commit hints → the snapshot substrate', () => {
  const led = T['Ledger']
  const cfg = T['Config']

  /** A stored ledger row the substrate sweep can watermark, in final DB shape. */
  const ledSeed = (id: string, at: string): ZohoRecord => ({
    recordID: 'z-' + id,
    data: {
      __table: led.id,
      [led.appId]: id,
      [led.dataJson!]: JSON.stringify({ id, at, type: 'GRN', doc: 'GRN-2026-0000', item: 'Tender Coconut', item_type: 'Raw Material', lot: 'LOT-0', location: 'Cold Room', status: 'In Stock', qty_in: 5, qty_out: 0, uom: 'Piece', unit_cost: 30 }),
    },
  })
  const revRow = (v: string): ZohoRecord => ({
    recordID: 'z-rev',
    data: { __table: cfg.id, [cfg.fields['Setting']]: 'app_revision', [cfg.fields['Value']]: v },
  })
  /** A PM receipt written under the watermark — the backdate the hint exists for. */
  const BACKDATED = {
    empty: false,
    tables: [
      { table: 'ledger', upsert: [{ id: 'LB', type: 'PM Receipt', doc: 'PM-1', item: 'Box', item_type: 'Packing Material', lot: 'PML-1', location: 'Store', status: 'In Stock', qty_in: 10, qty_out: 0, uom: 'Piece', unit_cost: 12, at: '2026-09-21T07:00:00Z' }], remove: [] },
      { table: 'audits', upsert: [{ id: 'AB', at: '2026-09-21T09:00:00Z', actor: 'Admin', action: 'posted', doc: 'PM-1', details: 'backdated' }], remove: [] },
    ],
    counters: {},
    config: undefined,
  }
  const NORMAL = {
    empty: false,
    tables: [
      { table: 'ledger', upsert: [{ id: 'LN', type: 'GRN', doc: 'GRN-2026-0002', item: 'Tender Coconut', item_type: 'Raw Material', lot: 'LOT-2', location: 'Cold Room', status: 'In Stock', qty_in: 8, qty_out: 0, uom: 'Piece', unit_cost: 31, at: '2026-09-21T09:00:00Z' }], remove: [] },
      { table: 'audits', upsert: [{ id: 'AN', at: '2026-09-21T09:05:00Z', actor: 'Admin', action: 'posted', doc: 'GRN-2026-0002', details: '' }], remove: [] },
    ],
    counters: {},
    config: undefined,
  }

  // real snapshot module state leaks within this file — every test starts cold
  beforeEach(() => invalidateSnapshotCache())

  it('a backdated ledger write under the held watermark hints the next sweep to full-read', async () => {
    const { zoho, calls } = fakeZoho([revRow('7'), ledSeed('L0', '2026-09-21T08:00:00Z')])
    await readSnapshotCached(zoho) // the substrate: ledger watermark 08:00
    expect(calls.fetchAll[led.id]).toBe(1)
    expect((calls.fetchSince[led.id] ?? 0)).toBe(0)
    const { token } = await commitChanges(zoho, admin, BACKDATED) // LB at 07:00, under it
    expect(token).toMatch(/^8:/)
    const snap = await readSnapshotCached(zoho)
    expect(snap.state?.ledger?.length).toBe(2) // the backdated row is visible at once
    expect(calls.fetchSince[led.id] ?? 0).toBe(0) // the hint forbade the delta
    expect(calls.fetchAll[led.id]).toBe(2) // full read instead
  })

  it('a commit that removes ledger rows hints the next sweep to full-read — a delta cannot see deletions', async () => {
    const { zoho, calls } = fakeZoho([revRow('7'), ledSeed('L0', '2026-09-21T08:00:00Z')])
    await readSnapshotCached(zoho)
    const { token } = await commitChanges(zoho, admin, {
      empty: false,
      tables: [{ table: 'ledger', upsert: [], remove: ['L0'] }],
      counters: {},
      config: undefined,
    })
    expect(token).toMatch(/^8:/)
    const snap = await readSnapshotCached(zoho)
    expect(snap.state?.ledger?.length).toBe(0) // the deletion shows, not five minutes later
    expect(calls.fetchSince[led.id] ?? 0).toBe(0)
    expect(calls.fetchAll[led.id]).toBe(2)
  })

  it('with no substrate there is no watermark to be backdated under — the later sweep still deltas', async () => {
    const { zoho, calls } = fakeZoho([])
    // commit BEFORE any sweep: no watermark is held, so nothing flags, and the
    // first sweep's full read watermarks at the backdated row's own 07:00
    await commitChanges(zoho, admin, BACKDATED)
    await readSnapshotCached(zoho)
    expect(calls.fetchAll[led.id]).toBe(1) // cold — one full read
    // a normally-dated write (09:00 > the 07:00 watermark) flags nothing
    await commitChanges(zoho, admin, NORMAL)
    const snap = await readSnapshotCached(zoho)
    expect(snap.state?.ledger?.length).toBe(2)
    expect(calls.fetchSince[led.id]).toBe(1) // the delta served this sweep
    expect(calls.fetchAll[led.id]).toBe(1) // and no second full read happened
  })

  it('a real commit arms the fast path — the next sweep reads only the touched tables', async () => {
    const { zoho, calls } = fakeZoho([revRow('7'), ledSeed('L0', '2026-09-21T08:00:00Z')])
    await readSnapshotCached(zoho) // the cold full sweep
    expect(calls.fetchAll[led.id]).toBe(1)
    expect(calls.fetchAll[T['Vendors'].id]).toBe(1)
    // commitChanges mints the token, notes it, and files the touched tables —
    // the fake's keyed upsert lands the revision row too, so the next gate read
    // returns this process's own token
    await commitChanges(zoho, admin, NORMAL) // ledger + audits, normally dated
    // the commit's own link-map enrichment reads vendors once (linkMemo was
    // cold) — the count AFTER it is the baseline the sweep must not move
    const vendReads = calls.fetchAll[T['Vendors'].id] ?? 0
    const snap = await readSnapshotCached(zoho)
    expect(snap.revision).toMatch(/^8:/)
    expect(snap.state?.ledger?.length).toBe(2) // the fresh line is there
    expect(calls.fetchSince[led.id]).toBe(1) // the touched table delta'd
    expect(calls.fetchAll[led.id]).toBe(1) // never full-read again
    expect(calls.fetchAll[T['Vendors'].id]).toBe(vendReads) // the fast sweep read it not at all
  })
})

describe('validateChanges — the pure shape gate before any Zoho call', () => {
  // invalid shapes are the point here; the cast is the test's permission slip
  const v = (c: unknown) => validateChanges(c as Parameters<typeof validateChanges>[0])

  it('admits every honest shape, counters-only and period keys included', () => {
    expect(v(CHANGES)).toBeNull()
    expect(v({ empty: false, tables: [], counters: {} })).toBeNull()
    expect(v({ ...CHANGES, tables: [], counters: { grn: 2, 'period:grn': 'x-any-string-passes-shape' } })).toBeNull()
    expect(v({ ...CHANGES, tables: [], counters: {}, config: { tolerances: { lab: 5 } } })).toBeNull()
    // an expect map on a change is the sync client's own honest shape
    expect(v({ ...CHANGES, tables: [{ ...CHANGES.tables[0], expect: {} }] })).toBeNull()
  })

  it('refuses payloads that are not the honest shape at all', () => {
    expect(v({ nope: true })).toBe('changes.tables must be an array.')
    expect(v({ tables: 'nope', counters: {} })).toBe('changes.tables must be an array.')
    // a missing counters used to throw in step 5 — after the row writes landed
    expect(v({ tables: [], empty: false })).toBe('changes.counters must be an object.')
    expect(v({ tables: [], counters: [] })).toBe('changes.counters must be an object.')
  })

  it('refuses tables the app does not write, before any pre-flight read is spent', () => {
    // every TABLE_FOR name a crafted body could reach for, incl. the two live
    // ones the permission loops used to skip silently
    for (const table of ['vendor_types', 'order_lines', 'Counters', 'Config', 'nope_table']) {
      expect(v({ tables: [{ table, upsert: [], remove: [] }], counters: {} })).toContain('does not write')
    }
    expect(v({ tables: [{ table: 'grns', upsert: 'nope', remove: [] }], counters: {} })).toBe(
      'upsert and remove must be arrays.',
    )
  })

  it('caps the commit: 12 table changes, 16 rows — a body cannot name the whole base', () => {
    const filler = (table: string) => ({ table, upsert: [], remove: [] })
    expect(v({ tables: Array.from({ length: 12 }, () => filler('grns')), counters: {} })).toBeNull()
    expect(v({ tables: Array.from({ length: 13 }, () => filler('grns')), counters: {} })).toContain('12 table changes')
    const row = { id: 'X', data: {} }
    expect(v({ tables: [{ table: 'grns', upsert: Array.from({ length: 16 }, (_, i) => ({ ...row, id: `G${i}` })), remove: [] }], counters: {} })).toBeNull()
    expect(v({ tables: [{ table: 'grns', upsert: Array.from({ length: 17 }, (_, i) => ({ ...row, id: `G${i}` })), remove: [] }], counters: {} })).toContain('16 rows')
  })

  it('refuses garbage row ids — blank, undefined, duplicated — that would key garbage rows', () => {
    // a missing id stringifies to the literal key 'undefined' downstream
    expect(v({ tables: [{ table: 'grns', upsert: [{ data: {} }], remove: [] }], counters: {} })).toContain('non-empty string id')
    expect(v({ tables: [{ table: 'grns', upsert: [{ id: 'undefined', data: {} }], remove: [] }], counters: {} })).toContain('non-empty string id')
    expect(v({ tables: [{ table: 'grns', upsert: [{ id: '  ', data: {} }], remove: [] }], counters: {} })).toContain('non-empty string id')
    expect(v({ tables: [{ table: 'grns', upsert: [{ id: 'A', data: {} }, { id: 'A', data: {} }], remove: [] }], counters: {} })).toBe('Duplicate row id A in one commit.')
    // the same id under two tables is fine — different rows of different shapes
    expect(v({ tables: [{ table: 'grns', upsert: [{ id: 'A', data: {} }], remove: [] }, { table: 'ledger', upsert: [{ id: 'A', data: {} }], remove: [] }], counters: {} })).toBeNull()
    expect(v({ tables: [{ table: 'grns', upsert: [], remove: [''] }], counters: {} })).toContain('removes must be non-empty strings')
    expect(v({ tables: [{ table: 'grns', upsert: [], remove: [42] }], counters: {} })).toContain('removes must be non-empty strings')
    expect(v({ tables: [{ table: 'grns', upsert: [{ id: 'A', data: {} }], remove: [], expect: 'nope' }], counters: {} })).toBe('expect must be an object.')
  })

  it('checks counter keys and values — the numbering is not a dumping ground', () => {
    expect(v({ tables: [], counters: { 'bad key!': 1 } })).toContain('Bad counter key')
    expect(v({ tables: [], counters: { ['x'.repeat(65)]: 1 } })).toContain('Bad counter key')
    expect(v({ tables: [], counters: { grn: '2' } })).toContain('non-negative number')
    expect(v({ tables: [], counters: { grn: -1 } })).toContain('non-negative number')
    expect(v({ tables: [], counters: { grn: Number.NaN } })).toContain('non-negative number')
    expect(v({ tables: [], counters: { grn: 1e10 } })).toContain('non-negative number')
    expect(v({ tables: [], counters: { 'period:grn': 2026 } })).toContain('short string')
    expect(v({ tables: [], counters: { 'period:grn': 'x'.repeat(65) } })).toContain('short string')
    const many: Record<string, number> = {}
    for (let i = 0; i < 17; i++) many[`k${i}`] = i
    expect(v({ tables: [], counters: many })).toContain('Too many counter keys')
  })

  it('refuses a config that is not a plain object', () => {
    expect(v({ tables: [], counters: {}, config: 'nope' })).toBe('changes.config must be an object.')
    expect(v({ tables: [], counters: {}, config: [] })).toBe('changes.config must be an object.')
    expect(v({ tables: [], counters: {}, config: null })).toBe('changes.config must be an object.')
  })
})
