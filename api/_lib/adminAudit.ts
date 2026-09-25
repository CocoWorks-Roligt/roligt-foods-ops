/**
 * The audit trail behind /api/admin/* actions.
 *
 * The WorkOS admin API keeps its own logs, but the plant's single trail is the
 * one the Audit page shows and the one an auditor reads — so every mutating
 * admin action files one row here too, then bumps the revision exactly the way
 * commitChanges does, so every client's poll picks the entry up. Rows are
 * written in the flat shape auditToRow emits (the Audits table stores that
 * shape, not AuditEntry) with a fresh unique id — insert-only by construction.
 */
import type { ZohoClient } from './zoho.ts'
import { T } from './baseSchema.ts'
import { auditColumns } from './mappers.ts'
import { columnsByFieldId } from './commit.ts'
import { invalidateSnapshotCache } from './snapshot.ts'
import type { Caller } from './auth.ts'

function auditId(): string {
  return `AUD-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Files one audit row for an admin action and bumps the revision.
 * Mirrors commitChanges' steps for audits and app_revision (steps 3 and 6 there)
 * without touching any other table.
 */
export async function writeAdminAudit(
  zoho: ZohoClient,
  caller: Caller,
  action: string,
  doc: string,
  details: string,
): Promise<void> {
  const table = T['Audit Log']
  const row = { id: auditId(), at: new Date().toISOString(), actor: caller.email, action, doc, details }
  await zoho.upsertByKey(table.id, table.appId, row.id, {
    [table.appId]: row.id,
    ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}),
    ...columnsByFieldId(table, auditColumns(row)),
  })

  const config = T['Config']
  const rows = await zoho.fetchAll(config.id)
  let current = 0
  for (const r of rows) {
    if (String(r.data[config.fields['Setting']]) === 'app_revision') {
      current = Number(r.data[config.fields['Value']]) || 0
    }
  }
  await zoho.upsertByKey(config.id, config.fields['Setting'], 'app_revision', {
    [config.fields['Setting']]: 'app_revision',
    [config.fields['Value']]: String(current + 1),
  })
  invalidateSnapshotCache()
}
