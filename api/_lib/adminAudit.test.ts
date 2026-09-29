import { beforeEach, describe, expect, it } from 'vitest'
import { writeAdminAudit } from './adminAudit.js'
import { cachedRevision, invalidateSnapshotCache, noteRevision } from './snapshot.js'
import { T } from './baseSchema.js'
import type { ZohoClient } from './zoho.js'

/**
 * The admin audit's cost contract: two writes (one Audit Log row, one revision
 * bump) and — when the process already holds a revision — NO reads at all. The
 * cold path spends exactly one criteria read of the app_revision row. This is
 * what keeps an admin action off the contended 26-reads-a-minute budget, which
 * is where its 30-second sleeps were coming from.
 */
function fakeZoho(stored: Record<string, Record<string, unknown>> = {}) {
  const calls: {
    kind: 'read' | 'write'
    tableId: string
    keys?: string[]
    key?: string
    values?: Record<string, unknown>
  }[] = []
  const zoho = {
    baseId: 'base-test',
    async fetchByKeyIn(tableId: string, keyFieldId: string, values: readonly string[]) {
      calls.push({ kind: 'read', tableId, keys: [...values] })
      const row = stored[tableId]
      return row && values.includes(String(row[keyFieldId])) ? [{ recordID: 'k1', data: row }] : []
    },
    async upsertByKey(tableId: string, _keyFieldId: string, keyValue: string, values: Record<string, unknown>) {
      calls.push({ kind: 'write', tableId, key: keyValue, values })
    },
  } as unknown as ZohoClient
  return { zoho, calls }
}

const caller = { email: 'who@roligt.local', permissions: ['page.admin-users'] }
const CONFIG = T['Config']
const revisionValue = (call: { values?: Record<string, unknown> }) =>
  String(call.values?.[CONFIG.fields['Value']] ?? '')

beforeEach(() => invalidateSnapshotCache())

describe('writeAdminAudit', () => {
  it('costs two writes and zero reads when the process holds a revision — the warm path', async () => {
    noteRevision('base-test', '9:abc')
    const { zoho, calls } = fakeZoho()
    await writeAdminAudit(zoho, caller, 'user created', 'new@roligt.local', 'roles: operator')
    expect(calls.filter((c) => c.kind === 'read')).toEqual([]) // nothing read at all
    const writes = calls.filter((c) => c.kind === 'write')
    expect(writes).toHaveLength(2) // the audit row, then the revision bump
    expect(writes[0]!.tableId).toBe(T['Audit Log'].id)
    expect(writes[1]!.tableId).toBe(CONFIG.id)
    expect(writes[1]!.key).toBe('app_revision')
    // the bump counts up from the cached revision — parsed, not Number()'d (a
    // token NaNs Number and quietly reset the count to 1 on every bump)
    expect(revisionValue(writes[1]!)).toMatch(/^10:/)
    // the process remembers the token it just wrote — the next audit is warm too
    expect(cachedRevision('base-test')).toMatch(/^10:/)
  })

  it('spends exactly one criteria read of app_revision when cold', async () => {
    const { zoho, calls } = fakeZoho({
      [CONFIG.id]: { [CONFIG.fields['Setting']]: 'app_revision', [CONFIG.fields['Value']]: '41:zz' },
    })
    await writeAdminAudit(zoho, caller, 'role created', 'shift-lead', 'Shift Lead')
    const reads = calls.filter((c) => c.kind === 'read')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.tableId).toBe(CONFIG.id)
    expect(reads[0]!.keys).toEqual(['app_revision'])
    const bump = calls.filter((c) => c.kind === 'write')[1]!
    expect(revisionValue(bump)).toMatch(/^42:/)
    // the one read made the base known, so the token it wrote rides forward —
    // the very next audit on this process is warm, not cold again
    expect(cachedRevision('base-test')).toMatch(/^42:/)
  })
})
