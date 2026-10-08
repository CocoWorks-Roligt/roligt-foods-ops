/**
 * The engine facade — the one module the routes import for every store-shaped
 * call. d1Enabled() (store.ts: the D1_* env is set) selects the D1 arm,
 * otherwise the Zoho engine answers; a route never learns which store served
 * it, and the two arms share their verdicts (commitGates.ts) and their token
 * grammars (versionTokenOf, the SQL bump) so they cannot drift.
 *
 * The facade takes the store as an argument and dispatches on the environment
 * switch — it never imports shared.ts, so tests keep injecting their own
 * clients through the routes' imports exactly as they always have. The error
 * classes and the cache/revision plumbing re-export from their one home
 * (commitGates.ts, snapshot.ts), so every `instanceof` in a route catch stays
 * the same class object the engines throw.
 */
import { d1Enabled, type Store } from './store.js'
import type { ZohoClient } from './zoho.js'
import type { D1Client } from './d1.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import {
  readSnapshotCached as readSnapshotCachedZoho,
  readRevisionMemoized as readRevisionMemoizedZoho,
  invalidateSnapshotCache as invalidateSnapshotCacheZoho,
  type Assembled,
} from './snapshot.js'
import { commitChanges as commitChangesZoho, type CommitResult } from './commit.js'
import { writeAdminAudit as writeAdminAuditZoho, writeAdminAuditD1 } from './adminAudit.js'
import { readSnapshotD1, readRevisionD1 } from './d1Snapshot.js'
import { commitChangesD1 } from './d1Commit.js'
import { zohoComplianceStore, type ComplianceStore } from './complianceStore.js'
import { d1ComplianceStore } from './d1Compliance.js'

export { Forbidden, Malformed, validateChanges, Conflict } from './commitGates.js'
export type { RowConflict } from './commitGates.js'

/** Reads the plant: the Zoho substrate cache, or one atomic D1 batch. */
export function readSnapshotCached(store: Store): Promise<Assembled> {
  return d1Enabled() ? readSnapshotD1(store as D1Client) : readSnapshotCachedZoho(store as ZohoClient)
}

/** The poll route's memoized revision read. */
export function readRevisionMemoized(store: Store): Promise<string> {
  return d1Enabled() ? readRevisionD1(store as D1Client) : readRevisionMemoizedZoho(store as ZohoClient)
}

/**
 * One commit at a time per process, across engines. The Zoho arm carries its
 * own queue (commit.ts — its tests pin direct calls through it); this outer
 * queue is the engine seam's mutex, so the D1 arm inherits serialization
 * without building its own. Same shape as commit.ts's: a rejected commit does
 * not jam the queue — the chain swallows the outcome and the next waiter runs.
 */
let engineQueue: Promise<unknown> = Promise.resolve()

export function commitChanges(store: Store, caller: Caller, changes: StateChanges): Promise<CommitResult> {
  const run = engineQueue.then(() =>
    d1Enabled() ? commitChangesD1(store as D1Client, caller, changes) : commitChangesZoho(store as ZohoClient, caller, changes),
  )
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Files one audit row for an admin action and bumps the revision. */
export function writeAdminAudit(
  store: Store,
  caller: Caller,
  action: string,
  doc: string,
  details: string,
): Promise<void> {
  return d1Enabled()
    ? writeAdminAuditD1(store as D1Client, caller, action, doc, details)
    : writeAdminAuditZoho(store as ZohoClient, caller, action, doc, details)
}

/**
 * The compliance register's data home: the standalone Zoho table, or plain D1
 * documents rows under collection 'compliance' — both arms keep the register's
 * version grammar and its route contracts (complianceStore.ts is the seam).
 */
export function complianceStore(store: Store): ComplianceStore {
  return d1Enabled() ? d1ComplianceStore(store as D1Client) : zohoComplianceStore(store as ZohoClient)
}

/**
 * A no-op under D1: that side's memos are keyed by the revision token itself,
 * and every write bumps the token inside its own atomic batch — the write IS
 * the invalidation. The Zoho substrate cache keeps its explicit invalidation.
 */
export function invalidateSnapshotCache(nowAt?: string): void {
  if (d1Enabled()) return
  invalidateSnapshotCacheZoho(nowAt)
}
