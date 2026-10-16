import { describe, expect, it } from 'vitest'
import { assembleState, projectSnapshot, withheldForCaller } from './snapshot.js'
import { auditFromRow, ledgerFromRow } from '../../src/lib/tables.js'
import { PAGE_CATALOG } from '../../src/lib/pages.js'

/**
 * The shared halves of the read path: assembleState (a ParsedSnapshot → the
 * app's snapshot shape) and projectSnapshot (the per-caller authorization).
 * The D1 adapter that builds the ParsedSnapshot is pinned where it lives
 * (d1Engine.test.ts).
 */
type Rows = {
  /** Raw documents per STATE key, already decoded (the adapter's job). */
  docs?: Record<string, Record<string, unknown>[]>
  /** Ledger/audit rows in the FLAT shape the commit arm writes (qty_in, actor…) —
   *  the same fromRow mappers the adapter applies, so the decode stays pinned. */
  ledger?: Record<string, unknown>[]
  audits?: Record<string, unknown>[]
  counters?: Record<string, number>
  config?: Record<string, string>
}

const assemble = (rows: Rows): ReturnType<typeof assembleState> =>
  assembleState({
    docs: {
      ...rows.docs,
      ...(rows.ledger ? { ledger: rows.ledger.map(ledgerFromRow) as unknown as Record<string, unknown>[] } : {}),
      ...(rows.audits ? { audits: rows.audits.map(auditFromRow) as unknown as Record<string, unknown>[] } : {}),
    },
    counters: rows.counters ?? {},
    config: rows.config ?? {},
  })

describe('assembleState', () => {
  it('maps collections, ledger, audits, counters and config back into the app shape', () => {
    const state = assemble({
      docs: {
        grns: [{ id: 'GRN-1', lot: 'LOT-1', total: 100 }],
        vendors: [{ id: 'V-1', name: 'Sriram' }],
      },
      ledger: [{ id: 'L-1', type: 'GRN', qty_in: 100 }],
      audits: [{ id: 'A-1', action: 'posted' }],
      counters: { grn: 5 },
      config: {
        app_config: JSON.stringify({ company: 'Roligt' }),
        app_revision: '7',
        'period:lot': '20260909',
      },
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
    const state = assemble({})
    expect(state.state).toBeNull()
    expect(state.everWritten).toBe(false)
  })

  it('decodes ledger and audit rows from the FLAT shape the commit writes', () => {
    // The commit arm stores ledger and audit documents as snake_case flat rows
    // (qty_in, item_type, actor, at), NOT the app's entry shapes. Reading them
    // back without the fromRow mappers leaves qtyIn/itemType undefined, the
    // stock fold turns into NaN and a posted receipt never shows as stock.
    const state = assemble({
      ledger: [
        {
          id: 'L-9', type: 'Receipt', doc: 'RFTC20260001', item: 'RM-TCW-COCO', item_type: 'Raw Material',
          lot: 'LOT-1', location: 'RM Store', status: 'Available', qty_in: 490, qty_out: 0,
          uom: 'Piece', unit_cost: 38.24, at: '2026-09-22T16:10:00Z',
        },
      ],
      audits: [
        { id: 'A-9', at: '2026-09-22T16:10:00Z', actor: 'dev@roligt.local', action: 'Posted receipt', doc: 'RFTC20260001', details: 'ok' },
      ],
    })
    expect(state.state?.ledger?.[0]?.qtyIn).toBe(490)
    expect(state.state?.ledger?.[0]?.itemType).toBe('Raw Material')
    expect(state.state?.ledger?.[0]?.time).toBe('2026-09-22T16:10:00Z')
    expect(state.state?.audits?.[0]?.role).toBe('dev@roligt.local')
    expect(state.state?.audits?.[0]?.time).toBe('2026-09-22T16:10:00Z')
  })

  it('reads periods from Config only', () => {
    // Periods live in Config (Setting/Value are text): period:* settings become
    // counterPeriods, and nothing a Counters map could say about a period
    // reaches the state.
    const state = assemble({
      docs: { grns: [{ id: 'GRN-1', lot: 'LOT-1' }] },
      config: { 'period:lot': 'YYYYMMDD:20260922' },
    })
    expect(state.state?.counterPeriods?.grn).toBeUndefined()
    expect(state.state?.counterPeriods?.lot).toBe('YYYYMMDD:20260922')
  })

  it('tells a wiped collection (zero rows → []) from one the parse never produced (key absent)', () => {
    // A key that arrives as [] was deliberately emptied — migrateState will NOT
    // reseed it. A key the parse never emitted stays absent from the state, so
    // first-boot seeding still happens.
    const state = assemble({
      docs: {
        grns: [{ id: 'GRN-1', lot: 'LOT-1' }], // someone has written something
        vendors: [], // wiped
        audits: [], // wiped
      },
    })
    expect(state.state?.vendors).toEqual([])
    expect(state.state?.audits).toEqual([])
    expect(state.state && 'ledger' in state.state).toBe(false) // never written
    expect(state.everWritten).toBe(true)
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
      docs: {
        grns: [{ id: 'GRN-1', lot: 'LOT-1' }],
        vendors: [{ id: 'V-1', name: 'Sriram', phone: '98450 00001', email: 'sriram@farm.example' }],
        customers: [{ id: 'C-1', name: 'Hotel Aroma', gst: '29ABCDE1234F1Z5', phone: '99000 00002', contactPerson: 'Ravi' }],
      },
      ledger: [{ id: 'L-1', type: 'GRN', qty_in: 100 }],
      audits: [{ id: 'A-1', action: 'posted' }],
      config: { app_config: JSON.stringify({ company: 'Roligt' }) },
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

  it('the delivery agent allowlist — an external caller receives NO plant data (RBAC §d)', () => {
    const snap = fullSnap()
    // even a mis-ticked role cannot widen the projection: the agent test is
    // slug-based, exactly like the server's other agent gates
    const view = projectSnapshot(snap, ['page.my-deliveries', 'page.orders'])
    expect(view.state).toEqual({})
    expect(view.revision).toBe(snap.revision)
    // every state key the substrate can hold is named — masters and the
    // ledger included, which the page-based withhold list alone would leak
    expect(view.withheld).toEqual(
      expect.arrayContaining(['grns', 'vendors', 'customers', 'items', 'ledger', 'config']),
    )
    // and the substrate itself is untouched — the next caller reads the plant
    const next = projectSnapshot(snap, [])
    expect(next.state?.grns?.length).toBe(1)
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
    const empty = assemble({})
    expect(empty.state).toBeNull()
    // a caller must not learn WHICH tables hold rows from the shape of the
    // refusal — the list depends on their permissions and nothing else
    expect(projectSnapshot(empty, SUPPLIERS_CLERK).withheld).toEqual(
      projectSnapshot(fullSnap(), SUPPLIERS_CLERK).withheld,
    )
    expect(projectSnapshot(empty, SUPPLIERS_CLERK).state).toBeNull()
  })
})
