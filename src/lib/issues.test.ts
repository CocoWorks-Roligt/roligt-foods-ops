/**
 * The stock-issue validator's line gate. A line the user touched but only
 * half-filled — stock picked with no quantity, or a quantity with no stock — used
 * to be filtered out silently, so the issue stored fewer lines than the form
 * showed. The validator refuses it with a reason now; these pins hold that, and
 * that a fully blank row is simply not counted.
 */
import { describe, expect, it } from 'vitest'
import { checkStockIssue } from './issues'
import type { IssueLineInput, StockIssueInput } from './issues'
import { migrateState } from './migrate'
import type { AppState, Item, LedgerEntry } from '../types'

const packed: Item = {
  id: 'FG-BOTTLE-500',
  name: 'Coconut Water 500 ml',
  type: 'Finished Goods',
  uom: 'Pack',
  lotControlled: true,
  reorder: 0,
  costMethod: 'Batch Actual',
}

function onHand(): LedgerEntry {
  return {
    id: 'LED-1',
    type: 'Receipt',
    doc: 'BATCH-0001',
    item: packed.id,
    itemType: 'Finished Goods',
    lot: 'BATCH-0001',
    location: 'Cold Room',
    status: 'Released',
    qtyIn: 50,
    qtyOut: 0,
    uom: 'Pack',
    unitCost: 30,
    time: '2026-10-01T00:00:00.000Z',
    expiry: '2026-11-01',
  }
}

const state = (): AppState =>
  migrateState({ items: [packed], ledger: [onHand()] })

const issue = (lines: StockIssueInput['lines']): StockIssueInput => ({
  date: '2026-10-09',
  reason: 'Lab / testing',
  lines,
})

/** A line the form builds when it is filled in all the way. */
const live: IssueLineInput = {
  item: packed.id,
  lot: 'BATCH-0001',
  location: 'Cold Room',
  status: 'Released',
  qty: 5,
  expiry: '2026-11-01',
}

describe('checkStockIssue line gate', () => {
  it('refuses a half-filled line with a reason instead of quietly storing fewer lines', () => {
    // stock picked but no quantity taken — the quiet-drop shape
    expect(checkStockIssue(state(), issue([{ ...live, qty: 0 }]))).toBe(
      'Every line needs its stock and a quantity — complete or remove the half-filled lines.',
    )
  })

  it('refuses a line that has a quantity but names no stock', () => {
    expect(
      checkStockIssue(state(), issue([{ item: '', lot: 'BATCH-0001', location: 'Cold Room', status: 'Released', qty: 5 }])),
    ).toBe('Every line needs its stock and a quantity — complete or remove the half-filled lines.')
  })

  it('does not count a fully blank row as a problem — it is simply not an issue line', () => {
    expect(
      checkStockIssue(state(), issue([live, { item: '', lot: '', location: '', status: '', qty: 0 }])),
    ).toBeNull()
  })

  it('still says which stock falls short, with the row named in full', () => {
    expect(checkStockIssue(state(), issue([{ ...live, qty: 60 }]))).toBe(
      'Coconut Water 500 ml BATCH-0001 in Cold Room has only 50 left, not 60.',
    )
  })
})
