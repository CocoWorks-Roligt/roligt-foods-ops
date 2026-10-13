/**
 * The palette reading: full-key context beats substring guesses, the
 * movement family is never mistaken for a verdict, and master-data states
 * stay legacy (no glyph, no palette word).
 */
import { describe, expect, it } from 'vitest'
import { readStatus } from './statusPalette.ts'

describe('readStatus', () => {
  it('reads QC hold keys as On Hold (awaiting QC)', () => {
    expect(readStatus('Pending')).toEqual({
      label: 'On Hold (awaiting QC)',
      tone: 'warning',
      icon: 'pause',
    })
    expect(readStatus('Quarantine')?.tone).toBe('warning')
    expect(readStatus('Awaiting QC')?.label).toBe('On Hold (awaiting QC)')
  })

  it('reads the movement family in teal, distinct from verdicts', () => {
    expect(readStatus('Dispatched')).toMatchObject({ tone: 'brand', icon: 'truckOut' })
    expect(readStatus('In Transit')).toMatchObject({ tone: 'brand', icon: 'truck' })
    expect(readStatus('Out for Delivery')?.label).toBe('Out for Delivery')
  })

  it('keeps partial states honest with their own words', () => {
    expect(readStatus('Partially Dispatched')?.label).toBe('Partially Dispatched')
    expect(readStatus('Partially Delivered')?.label).toBe('Partially Delivered')
  })

  it('reads verdicts and returns', () => {
    expect(readStatus('Released')).toMatchObject({ tone: 'success', icon: 'checkCircle' })
    expect(readStatus('Retest')).toMatchObject({ tone: 'warning', icon: 'rotate' })
    expect(readStatus('Rejected')?.icon).toBe('x')
    expect(readStatus('Returned')).toMatchObject({ tone: 'neutral', icon: 'undo' })
    expect(readStatus('Cancelled')).toMatchObject({ tone: 'neutral', icon: 'slash' })
  })

  it('reads lowercase purchase-order and run keys', () => {
    expect(readStatus('sent')?.label).toBe('Pending')
    expect(readStatus('received')?.label).toBe('Received')
    expect(readStatus('awaiting qc')?.label).toBe('On Hold (awaiting QC)')
    expect(readStatus('closed')?.label).toBe('Closed')
  })

  it('leaves master-data and stock states to the legacy rendering', () => {
    expect(readStatus('Available')).toBeUndefined()
    expect(readStatus('Inactive')).toBeUndefined()
    expect(readStatus('Active')).toBeUndefined()
    expect(readStatus('Suspended')).toBeUndefined()
  })

  it('falls through by family for unknown future keys, longest first', () => {
    expect(readStatus('Out For Delivery (stop 2)')?.icon).toBe('truck')
    expect(readStatus('Partially Delivered — see return')?.label).toBe('Partially Delivered')
    expect(readStatus('Line rejected at gate')?.icon).toBe('x')
    expect(readStatus('Something else')).toBeUndefined()
  })
})
