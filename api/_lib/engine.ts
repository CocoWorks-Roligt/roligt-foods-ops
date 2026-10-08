/**
 * The engine facade — the one module the routes import for every store-shaped
 * call. Today it answers with the Zoho engine everywhere; Phase 4 slots the D1
 * arms in beside each delegate under the same d1Enabled() switch, and a route
 * never learns which store served it.
 *
 * The facade takes the store as an argument and dispatches on the environment
 * switch (store.ts) — it never imports shared.ts, so tests keep injecting
 * their own clients through the routes' imports exactly as they always have.
 * The error classes and the cache/revision plumbing re-export from their one
 * home (commitGates.ts, snapshot.ts), so every `instanceof` in a route catch
 * stays the same class object the engines throw.
 */
import { d1Enabled, type Store } from './store.js'
import type { ZohoClient } from './zoho.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import {
  readSnapshotCached as readSnapshotCachedZoho,
  readRevisionMemoized as readRevisionMemoizedZoho,
  invalidateSnapshotCache,
  type Assembled,
} from './snapshot.js'
import { commitChanges as commitChangesZoho, type CommitResult } from './commit.js'
import { writeAdminAudit as writeAdminAuditZoho } from './adminAudit.js'

export { invalidateSnapshotCache }
export { Forbidden, Malformed, validateChanges, Conflict } from './commitGates.js'
export type { RowConflict } from './commitGates.js'

/**
 * Phase 4 lands the D1 arms. Until then the switch cannot flip in production
 * (no deployment sets D1_DATABASE_ID), and an early flip fails loudly instead
 * of serving Zoho-shaped rows out of a D1 database.
 */
function d1Pending(what: string): never {
  throw new Error(`The D1 engine is not built yet (Phase 4) — ${what} has no D1 arm.`)
}

/** Reads the plant, sweeping only when the revision moved (the Zoho
 *  substrate cache; the D1 arm will be one batch). */
export function readSnapshotCached(store: Store): Promise<Assembled> {
  if (d1Enabled()) d1Pending('readSnapshotCached')
  return readSnapshotCachedZoho(store as ZohoClient)
}

/** The poll route's memoized revision read. */
export function readRevisionMemoized(store: Store): Promise<string> {
  if (d1Enabled()) d1Pending('readRevisionMemoized')
  return readRevisionMemoizedZoho(store as ZohoClient)
}

/**
 * One commit at a time per process, across engines. The Zoho arm carries its
 * own queue (commit.ts — its tests pin direct calls through it); this outer
 * queue is the engine seam's mutex, so the D1 arm that lands in Phase 4
 * inherits serialization without building its own. Same shape as commit.ts's:
 * a rejected commit does not jam the queue — the chain swallows the outcome
 * and the next waiter runs.
 */
let engineQueue: Promise<unknown> = Promise.resolve()

export function commitChanges(store: Store, caller: Caller, changes: StateChanges): Promise<CommitResult> {
  const run = engineQueue.then(() =>
    d1Enabled() ? d1Pending('commitChanges') : commitChangesZoho(store as ZohoClient, caller, changes),
  )
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Files one audit row for an admin action and bumps the revision (the D1 arm
 *  is one batch — Phase 4). */
export function writeAdminAudit(
  store: Store,
  caller: Caller,
  action: string,
  doc: string,
  details: string,
): Promise<void> {
  if (d1Enabled()) d1Pending('writeAdminAudit')
  return writeAdminAuditZoho(store as ZohoClient, caller, action, doc, details)
}
