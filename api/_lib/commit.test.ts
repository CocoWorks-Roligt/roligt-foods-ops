import { describe, expect, it } from 'vitest'
import { commitChanges, Forbidden } from './commit.ts'
import { T } from './baseSchema.ts'
import type { ZohoClient, ZohoRecord } from './zoho.ts'
import type { Caller } from './auth.ts'
import { PERMISSIONS } from '../../src/lib/permissions.ts'

type Upsert = { table: string; key: string; values: Record<string, string> }

function fakeZoho(existing: ZohoRecord[] = []) {
  const ops: { upserts: Upsert[]; deletes: { table: string; recordId: string }[] } = { upserts: [], deletes: [] }
  const zoho = {
    fetchAll: async (tableId: string) => existing.filter((r) => r.data.__table === tableId),
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
  return { zoho, ops }
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
    const rev = await commitChanges(zoho, admin, CHANGES)
    expect(rev).toBe(1)
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
    // the tick carries its page's master writes
    const rev = await commitChanges(zoho, suppliersClerk, {
      ...CHANGES,
      tables: [{ table: 'vendors', upsert: [{ id: 'V-1', data: {} }], remove: [] }],
    })
    expect(rev).toBeTypeOf('number')
    // …but not another page's masters table, nor the staff register (the Roster page's)
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [{ table: 'items', upsert: [{ id: 'IT-1', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('items'))
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [{ table: 'staff', upsert: [{ id: 'S-1', data: {} }], remove: [] }] }),
    ).rejects.toMatchObject(new Forbidden('staff'))
    await expect(
      commitChanges(zoho, suppliersClerk, { ...CHANGES, tables: [], config: { tolerances: { lab: 5 } } }),
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
    await expect(commitChanges(zoho, labTester, { ...CHANGES, tables: params })).resolves.toBeTypeOf('number')
    await expect(commitChanges(zoho, operator, { ...CHANGES, tables: params })).rejects.toBeInstanceOf(Forbidden)
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [{ table: 'vendors', upsert: [{ id: 'V-9', data: {} }], remove: [] }] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('lets the lab tester change only the testCategories key of config', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    // whole-object payload, as sync sends it: tolerances identical, types edited
    const rev = await commitChanges(zoho, labTester, {
      ...CHANGES,
      tables: [],
      config: { ...STORED_CONFIG, testCategories: [{ key: 'sensory', title: 'Sensory Evaluation' }] },
    })
    expect(rev).toBeTypeOf('number')
    expect(ops.upserts.some((u) => u.key === 'app_config')).toBe(true)
  })

  it('refuses the lab tester any other config key — and a payload that would drop one', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    // a tolerance change riding along in the same whole-object payload
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], config: { ...STORED_CONFIG, tolerances: { lab: 9 } } }),
    ).rejects.toMatchObject(new Forbidden('app_config tolerances'))
    // the storage page's own config key is not the lab's
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], config: { ...STORED_CONFIG, defaultAreas: { produce: 'A1' } } }),
    ).rejects.toMatchObject(new Forbidden('app_config defaultAreas'))
    // a crafted partial payload: the write replaces the whole row, so the keys it
    // omits count as changes, not as "leave those alone"
    await expect(
      commitChanges(zoho, labTester, { ...CHANGES, tables: [], config: { testCategories: STORED_CONFIG.testCategories } }),
    ).rejects.toMatchObject(new Forbidden('app_config tolerances'))
    await expect(commitChanges(zoho, labTester, { ...CHANGES, tables: [], config: {} })).rejects.toMatchObject(
      new Forbidden('app_config tolerances'),
    )
    expect(ops.upserts).toEqual([]) // nothing landed from any of the refused commits
  })

  it('narrows a page-scoped caller: the procurement clerk writes GRNs, nothing else', async () => {
    const { zoho, ops } = fakeZoho()
    // the whole day's-work shape — doc, ledger line, audit, counter — rides through
    const rev = await commitChanges(zoho, procurementClerk, CHANGES)
    expect(rev).toBeTypeOf('number')
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
    await expect(commitChanges(zoho, { email: 'pack@roligt.local', permissions: ['page.packing'] }, { ...CHANGES, tables: [runs] })).resolves.toBeTypeOf('number')
    // the control samples ARE fields on the run — the lab tester writes it too
    await expect(commitChanges(zoho, labTester, { ...CHANGES, tables: [runs] })).resolves.toBeTypeOf('number')
    await expect(
      commitChanges(zoho, procurementClerk, { ...CHANGES, tables: [runs] }),
    ).rejects.toBeInstanceOf(Forbidden)
  })

  it('never applies the page gate to an unscoped caller — the day\'s work stays open', async () => {
    const { zoho } = fakeZoho()
    // the operator (no ticks at all) writes the whole day's work freely
    await expect(commitChanges(zoho, operator, CHANGES)).resolves.toBeTypeOf('number')
    await expect(
      commitChanges(zoho, operator, { ...CHANGES, tables: [{ table: 'qcs', upsert: [{ id: 'QC-2', data: {} }], remove: [] }] }),
    ).resolves.toBeTypeOf('number')
  })

  it('a page.storage caller edits the areas and their defaults; an operator cannot', async () => {
    const { zoho, ops } = fakeZoho([configRow(STORED_CONFIG)])
    const storekeeper = { email: 'store@roligt.local', permissions: ['page.storage'] } as Caller
    const rev = await commitChanges(zoho, storekeeper, {
      ...CHANGES,
      tables: [{ table: 'storage_locations', upsert: [{ id: 'SL-1', data: {} }], remove: [] }],
      config: { ...STORED_CONFIG, defaultAreas: { produce: 'Cold Room' } },
    })
    expect(rev).toBeTypeOf('number')
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
    const rev = await commitChanges(zoho, admin, {
      empty: false,
      tables: [{ table: 'audits', upsert: [], remove: ['A1'] }],
      counters: {},
      config: { tolerances: { lab: 5 } },
    })
    expect(rev).toBeTypeOf('number') // no throw
    expect(ops.deletes).toEqual([{ table: T['Audit Log'].id, recordId: 'z-a1' }])
    expect(ops.upserts.some((u) => u.key === 'app_config')).toBe(true)
  })

  it('retries never duplicate and never error — the ledger re-upserts by key, existing audits are skipped', async () => {
    const { zoho, ops } = fakeZoho()
    await commitChanges(zoho, admin, CHANGES)
    ops.upserts.length = 0
    ops.deletes.length = 0
    await commitChanges(zoho, admin, CHANGES) // must not throw: a retry after a partial failure is the normal case
    expect(ops.deletes).toEqual([])
    expect(ops.upserts.filter((u) => u.key === 'L1')).toHaveLength(1) // one ledger line, not two — keyed re-upsert
    expect(ops.upserts.some((u) => u.key === 'A1')).toBe(false) // the audit row exists now → skipped, history stays as first written
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
    expect(audit.values[T['Audit Log'].fields['Actor']]).toBe('Admin')
    expect('Actor' in audit.values).toBe(false)
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
      counters: { grn: 2, 'period:grn': 'YYYY:2026' },
    })
    const counterRows = ops.upserts.filter((u) => u.table === T['Counters'].id)
    expect(counterRows.some((u) => u.key === 'grn')).toBe(true)
    expect(counterRows.some((u) => u.key.startsWith('period:'))).toBe(false)
    const configRows = ops.upserts.filter((u) => u.table === T['Config'].id)
    const period = configRows.find((u) => u.key === 'period:grn')
    expect(period).toBeDefined()
    expect(period!.values[T['Config'].fields['Value']]).toBe('YYYY:2026')
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
})
