/**
 * Switching a bulk to "skips QC" after batches of it were posted. Those batches sat
 * Awaiting QC forever on the preview (carrot, apple, pineapple, lemon) — the switch
 * only decided future batches. releaseExemptPending clears exactly the untested ones.
 */
import { describe, expect, it } from 'vitest'
import { migrateState } from './migrate'
import { releaseExemptPending } from './qcExempt'
import { stockRows } from './stock'
import type { AppState, Batch, LedgerEntry, QcRecord } from '../types'

const qc = (id: string, batchId: string, item: string, over: Partial<QcRecord> = {}): QcRecord => ({
  id,
  batchId,
  item,
  micro: 'Pending',
  pesticides: 'Pending',
  heavyMetals: 'Pending',
  physico: 'Pending',
  disposition: 'Pending',
  reviewedBy: '',
  reviewedAt: '',
  ...over,
})

const out = (lot: string, item: string, qty: number, status = 'Quarantine', itemType = 'Semi Finished'): LedgerEntry => ({
  id: `LED-${lot}-${item}-${status}`,
  type: 'Production Output',
  doc: lot,
  item,
  itemType,
  lot,
  location: 'BULK',
  status,
  qtyIn: qty,
  qtyOut: 0,
  uom: 'Litre',
  unitCost: 10,
  time: '2026-10-08T10:00:00.000Z',
})

const batch = (id: string, item: string, qcIds: string[]): Batch =>
  ({
    id,
    kind: 'Extraction',
    date: '2026-10-08',
    status: 'Awaiting QC',
    qcId: qcIds[0] || '',
    qcIds,
    outputLines: [{ item, qty: 10, uom: 'Litre', costShare: 100 }],
  }) as unknown as Batch

function plant(): AppState {
  return migrateState({
    items: [
      { id: 'SF-CARROT', name: 'Carrot Juice', type: 'Semi Finished', uom: 'Litre', lotControlled: true, reorder: 0, costMethod: 'Batch Actual', qcExempt: true },
    ],
    batches: [batch('BAT-1', 'SF-CARROT', ['QC-1']), batch('BAT-2', 'SF-CARROT', ['QC-2']), batch('BAT-3', 'SF-CARROT', ['QC-3'])],
    qcs: [
      qc('QC-1', 'BAT-1', 'SF-CARROT'),
      // the lab has started this one — it is theirs to close
      qc('QC-2', 'BAT-2', 'SF-CARROT', { micro: 'Pass' }),
      // a verdict already given stands
      qc('QC-3', 'BAT-3', 'SF-CARROT', { disposition: 'Released' }),
    ],
    ledger: [out('BAT-1', 'SF-CARROT', 10), out('BAT-2', 'SF-CARROT', 10), out('BAT-3', 'SF-CARROT', 10, 'Released')],
  })
}

describe('releaseExemptPending', () => {
  it('withdraws the untested record, marks the output exempt and releases the lot through paired lines', () => {
    const draft = plant()
    const before = draft.ledger.length
    const r = releaseExemptPending(draft, 'SF-CARROT')
    expect(r).toEqual({ released: ['BAT-1'], started: ['QC-2'], setAside: [] })

    expect(draft.qcs.map((q) => q.id)).toEqual(['QC-2', 'QC-3'])
    const b1 = draft.batches.find((b) => b.id === 'BAT-1')!
    expect(b1.status).toBe('Released')
    expect(b1.qcIds).toEqual([])
    expect(b1.outputLines?.[0].qcExempt).toBe(true)

    // appended, never rewritten: one line out of Quarantine, one into Released
    const added = draft.ledger.slice(before)
    expect(added.map((l) => [l.type, l.doc, l.status, l.qtyIn, l.qtyOut])).toEqual([
      ['QC Status Transfer', 'BAT-1', 'Quarantine', 0, 10],
      ['QC Status Transfer', 'BAT-1', 'Released', 10, 0],
    ])
    const rows = stockRows(draft).filter((x) => x.lot === 'BAT-1')
    expect(rows.map((x) => [x.status, x.qty])).toEqual([['Released', 10]])

    // the started record and the given verdict are untouched
    expect(draft.batches.find((b) => b.id === 'BAT-2')!.status).toBe('Awaiting QC')
    expect(stockRows(draft).find((x) => x.lot === 'BAT-2')?.status).toBe('Quarantine')
  })

  it('is idempotent — a second save finds nothing left to release', () => {
    const draft = plant()
    releaseExemptPending(draft, 'SF-CARROT')
    const lines = draft.ledger.length
    expect(releaseExemptPending(draft, 'SF-CARROT').released).toEqual([])
    expect(draft.ledger.length).toBe(lines)
  })
})
