/**
 * The audit trail behind /api/admin/* actions.
 *
 * The WorkOS admin API keeps its own logs, but the plant's single trail is the
 * one the Audit page shows and the one an auditor reads — so every mutating
 * admin action files one row here too, then bumps the revision exactly the way
 * commitChanges does, so every client's poll picks the entry up. Rows are
 * written in the flat shape the Audits collection stores (not AuditEntry) with
 * a fresh unique id — insert-only by construction.
 *
 * The filing is ONE atomic batch: the audit insert (insert-only, ON CONFLICT
 * DO NOTHING) and the shared revision-bump statement, so an admin action can
 * never land its trail row without the poll announcing it. The fresh token
 * feeds the read memos directly (noteD1Revision) — the state memo
 * self-invalidates by its revision key, which is the D1 side's whole
 * invalidation story.
 */
import type { D1Client } from './d1.js'
import { bumpStatement } from './d1Commit.js'
import { noteD1Revision } from './d1Snapshot.js'
import type { Caller } from './auth.js'

function auditId(): string {
  return `AUD-admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function writeAdminAuditD1(
  d1: D1Client,
  caller: Caller,
  action: string,
  doc: string,
  details: string,
): Promise<void> {
  const row = { id: auditId(), at: new Date().toISOString(), actor: caller.email, action, doc, details }
  const out = await d1.batch<{ value?: unknown }>([
    {
      sql: `INSERT INTO documents(collection, id, json, version, updated_at) VALUES ('audits', ?, ?, 1, ?)
        ON CONFLICT(collection, id) DO NOTHING`,
      params: [row.id, JSON.stringify(row), row.at],
    },
    bumpStatement(),
  ])
  const token = out[1].results[0]?.value
  if (typeof token !== 'string' || !token) {
    // unreachable while the schema's seed row stands — the honest error if it does not
    throw new Error('The app_revision row is missing — the audit landed but no poll will announce it.')
  }
  noteD1Revision(token)
}
