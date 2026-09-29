/**
 * The audit trail behind /api/admin/* actions.
 *
 * The WorkOS admin API keeps its own logs, but the plant's single trail is the
 * one the Audit page shows and the one an auditor reads — so every mutating
 * admin action files one row here too, then bumps the revision exactly the way
 * commitChanges does, so every client's poll picks the entry up. Rows are
 * written in the flat shape auditToRow emits (the Audits table stores that
 * shape, not AuditEntry) with a fresh unique id — insert-only by construction.
 *
 * The whole filing is TWO WRITES on the write budget (17/min, rarely contended)
 * and no reads: the revision the bump starts from is the one this process
 * already holds in its snapshot cache, fetched by criteria only when the cache
 * is cold. It used to sweep the whole Config table per action — a read on the
 * 26/min budget that polls and snapshot sweeps are always spending, which is
 * how an admin action came to sleep out a rate-limit window mid-request.
 */
import type { ZohoClient } from './zoho.js'
import { T } from './baseSchema.js'
import { auditColumns } from './mappers.js'
import { bumpRevisionTo, columnsByFieldId } from './commit.js'
import { cachedRevision, invalidateSnapshotCache, readRevision } from './snapshot.js'
import type { Caller } from './auth.js'

function auditId(): string {
  return `AUD-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The revision number a bump should start from — the cached one when this
 *  process has one, else one criteria read of the app_revision row alone
 *  (readRevision, which also notes it: the token this audit then writes rides
 *  forward on a baseId the module now knows). */
async function currentRevisionNumber(zoho: ZohoClient): Promise<number> {
  const cached = cachedRevision(zoho.baseId)
  if (cached !== null) return parseInt(cached, 10) || 0
  return parseInt(await readRevision(zoho), 10) || 0
}

/**
 * Files one audit row for an admin action and bumps the revision.
 * Mirrors commitChanges' steps for audits and the revision bump (there) without
 * touching any other table.
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
  // Read (if needed) BEFORE the writes: the audit row itself moves no revision,
  // and the cache this reads from is invalidated right after the bump anyway.
  const current = await currentRevisionNumber(zoho)
  await zoho.upsertByKey(table.id, table.appId, row.id, {
    [table.appId]: row.id,
    ...(table.dataJson ? { [table.dataJson]: JSON.stringify(row) } : {}),
    ...columnsByFieldId(table, auditColumns(row)),
  })
  const token = await bumpRevisionTo(zoho, current)
  // The bump is this process's own knowledge of the plant at its newest — keep
  // the snapshot cache's revision current with it instead of dropping to cold.
  invalidateSnapshotCache(token)
}
