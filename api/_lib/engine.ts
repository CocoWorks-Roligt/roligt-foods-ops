/**
 * The engine facade — the one module the routes import for every store-shaped
 * call. D1 is the only engine since the Zoho arm's deletion (2026-10-16 —
 * docs/d1-migration-2026-10-09.md, Phase 7); the facade stays so routes keep
 * their one import seam, and the verdicts and token grammars stay in their
 * one home (commitGates.ts, d1Commit.ts) so nothing drifts.
 */
import { LockedError, type Store } from './store.js'
import type { Caller } from './auth.js'
import type { StateChanges } from '../../src/lib/sync.js'
import type { Assembled } from './snapshot.js'
import { commitChangesD1, type CommitResult } from './d1Commit.js'
import { writeAdminAuditD1 } from './adminAudit.js'
import { readSnapshotD1, readRevisionD1 } from './d1Snapshot.js'
import { d1ComplianceStore } from './d1Compliance.js'
import type { ComplianceStore } from './complianceStore.js'

export { Forbidden, Malformed, validateChanges, Conflict } from './commitGates.js'
export type { RowConflict } from './commitGates.js'

/**
 * A usable store, or the honest refusal: a deployment without the D1_* env is
 * misconfigured, and the answer is the same 503 + Retry-After ladder LockedError
 * already owns (a day, not a minute — a redeploy fixes this, not a retry).
 */
function requireStore(store: Store | null): Store {
  if (store) return store
  throw new LockedError(86_400, 'The D1 store is not configured for this deployment.')
}

/** Reads the plant: one atomic D1 batch, memoized by the revision token. */
export async function readSnapshotCached(store: Store | null): Promise<Assembled> {
  return readSnapshotD1(requireStore(store))
}

/** The poll route's memoized revision read. */
export async function readRevisionMemoized(store: Store | null): Promise<string> {
  return readRevisionD1(requireStore(store))
}

/**
 * One commit at a time per process. The queue is the engine seam's mutex — a
 * rejected commit does not jam it: the chain swallows the outcome and the next
 * waiter runs.
 */
let engineQueue: Promise<unknown> = Promise.resolve()

export async function commitChanges(store: Store | null, caller: Caller, changes: StateChanges): Promise<CommitResult> {
  const run = engineQueue.then(() => commitChangesD1(requireStore(store), caller, changes))
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Files one audit row for an admin action and bumps the revision. */
export async function writeAdminAudit(
  store: Store | null,
  caller: Caller,
  action: string,
  doc: string,
  details: string,
): Promise<void> {
  return writeAdminAuditD1(requireStore(store), caller, action, doc, details)
}

/**
 * The compliance register's data home: plain D1 documents rows under collection
 * 'compliance', keeping the register's version grammar and its route contracts
 * (d1Compliance.ts is the arm; complianceStore.ts the shared surface).
 */
export function complianceStore(store: Store | null): ComplianceStore {
  return d1ComplianceStore(requireStore(store))
}
