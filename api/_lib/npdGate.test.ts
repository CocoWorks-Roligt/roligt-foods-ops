/**
 * The NPD role's reach on the server: a caller holding only page.npd may post a use
 * record (a stock_issues row with its ledger lines, audit row and counter), and nothing
 * outside it — not a bare stock move, which is the Storage page's, and not a GRN.
 */
import { describe, expect, it } from 'vitest'
import { Forbidden, gateTablePermissions } from './commitGates.js'
import type { StateChanges } from '../../src/lib/sync.js'

const npd = { email: 'npd@roligt.local', permissions: ['page.npd'] }

const changes = (tables: StateChanges['tables'], counters: StateChanges['counters'] = {}): StateChanges => ({
  tables,
  counters,
  empty: false,
})

const ledger = { table: 'ledger', upsert: [{ id: 'LED-1' }], remove: [] }
const audit = { table: 'audits', upsert: [{ id: 'AUD-1' }], remove: [] }

describe('the NPD page holder', () => {
  it('posts a use record with its ledger lines, trail and number', () => {
    const use = changes([{ table: 'stock_issues', upsert: [{ id: 'ISS-0001' }], remove: [] }, ledger, audit], { issue: 2 })
    expect(() => gateTablePermissions(npd, use)).not.toThrow()
  })

  it('cannot move stock on its own — sending to NPD is production’s', () => {
    expect(() => gateTablePermissions(npd, changes([ledger, audit]))).toThrow(Forbidden)
  })

  it('cannot write another page’s documents', () => {
    expect(() => gateTablePermissions(npd, changes([{ table: 'grns', upsert: [{ id: 'GRN-1' }], remove: [] }]))).toThrow(
      Forbidden,
    )
  })
})
