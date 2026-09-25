import { useEffect, useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { Modal } from '../../components/Modal'
import { useToast } from '../../context/ToastContext'
import { adminRoleAction, fetchAdminRoles, type RolesSnapshot } from '../../lib/adminApi'
import { PAGE_CATALOG, type PageRow } from '../../lib/pages.ts'
import { PERMISSIONS } from '../../lib/permissions.ts'

/**
 * Role composition — the screen that makes page access runtime data.
 *
 * A role is a named bundle of permissions; a user's session carries the union
 * of whatever their roles grant. This screen edits those bundles at runtime,
 * which is the whole reason auth moved to WorkOS: the catalog is fixed in code
 * (src/lib/pages.ts) but who gets what is data, not a deploy. Ticking pages
 * composes a scoped app — a lab tester, a procurement clerk — without anyone
 * touching code.
 */

/** Every permission is a page — there is nothing else to tick. */
const DAY_PAGES = PAGE_CATALOG.filter((p) => p.tier === 'open')
const MASTER_PAGES = PAGE_CATALOG.filter((p) => p.tier === 'masters')
/** Settings and the two Administration pages — the ticks that make an administrator. */
const SITE_PAGES = PAGE_CATALOG.filter((p) => p.tier === 'settings' || p.tier === 'admin')

/** Plain words for what a role grants — the line the admin actually reads. */
function summarize(permissions: Iterable<string>): string {
  const held = new Set(permissions)
  const pages = PAGE_CATALOG.filter((p) => held.has(p.slug)).map((p) => p.label)
  return pages.length
    ? `Pages: ${pages.join(', ')}`
    : "No pages ticked — holders keep the whole day’s work (operator)"
}

function PageChip({ page, on, onToggle }: { page: PageRow; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={on ? 'page-chip on' : 'page-chip'} aria-pressed={on} onClick={onToggle}>
      {page.label}
    </button>
  )
}

export function Roles() {
  const showToast = useToast()
  const [snapshot, setSnapshot] = useState<RolesSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  /** The role being edited: slug → its working permission set. */
  const [editing, setEditing] = useState<{ slug: string; held: Set<string> } | null>(null)

  const reload = async () => {
    try {
      setSnapshot(await fetchAdminRoles())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read roles.')
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    const result = await fn()
    setBusy(false)
    if (result.ok) {
      showToast(label)
      setEditing(null)
      setCreating(false)
      await reload()
    } else {
      setError(result.error ?? 'The change was refused.')
    }
  }

  const roles = snapshot?.roles ?? []
  const editingRole = editing ? roles.find((r) => r.slug === editing.slug) : undefined
  const toggle = (slug: string) => {
    if (!editing) return
    const next = new Set(editing.held)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    setEditing({ slug: editing.slug, held: next })
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="small">A role's whole permission set is replaced when you save it.</span>
        <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
          + New role
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {snapshot?.missing?.length ? (
        <p className="form-error" role="alert">
          Could not create {snapshot.missing.join(', ')} in WorkOS — run{' '}
          <code>scripts/workos/seed-rbac.mjs</code> to finish, or they cannot be ticked.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>What it grants</th>
              <th className="cell-tight">Users</th>
              <th className="cell-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {!roles.length ? (
              <tr>
                <td colSpan={4} className="empty">
                  <EmptyState
                    filtered={false}
                    empty={snapshot === null ? 'Reading roles…' : 'No roles yet — run scripts/workos/seed-rbac.mjs, then create one here.'}
                    onClear={() => {}}
                  />
                </td>
              </tr>
            ) : (
              roles.map((role) => {
                const open = editing?.slug === role.slug
                return (
                  <tr key={role.slug}>
                    <td data-label="Role">
                      <b>{role.slug}</b>
                      <div className="cell-sub">{role.name}</div>
                    </td>
                    <td data-label="What it grants">{open ? summarize(editing!.held) : summarize(role.permissions)}</td>
                    <td data-label="Users" className="cell-tight">
                      {snapshot?.assignments[role.slug] ?? 0}
                    </td>
                    <td className="cell-actions">
                      {open ? (
                        <div className="row-actions">
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(`Permissions saved for ${role.slug}.`, () =>
                                adminRoleAction({
                                  action: 'set-permissions',
                                  slug: role.slug,
                                  permissions: [...editing!.held],
                                }),
                              )
                            }
                          >
                            Save
                          </button>
                          <button className="btn btn-light" type="button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-light"
                          type="button"
                          disabled={editing !== null}
                          onClick={() => setEditing({ slug: role.slug, held: new Set(role.permissions) })}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {editing && editingRole ? (
        <Modal
          title={`Pages and permissions — ${editingRole.slug}`}
          open
          onClose={() => setEditing(null)}
          saveDisabled={busy}
          onSave={() =>
            void run(`Permissions saved for ${editingRole.slug}.`, () =>
              adminRoleAction({
                action: 'set-permissions',
                slug: editingRole.slug,
                permissions: [...editing!.held],
              }),
            )
          }
        >
          <p className="small">
            Tick the pages this role opens. Any role with a page ticked narrows its holder's
            whole app to the ticked pages (union across all their roles); a role with no pages
            ticked grants the whole day's work.
          </p>

          <div className="field">
            <label>Day's work</label>
            <div className="chip-row">
              {DAY_PAGES.map((page) => (
                <PageChip key={page.id} page={page} on={editing.held.has(page.slug)} onToggle={() => toggle(page.slug)} />
              ))}
            </div>
          </div>

          <div className="field">
            <label>Masters</label>
            <div className="chip-row">
              {MASTER_PAGES.map((page) => (
                <PageChip key={page.id} page={page} on={editing.held.has(page.slug)} onToggle={() => toggle(page.slug)} />
              ))}
            </div>
          </div>

          <div className="field">
            <label>Settings &amp; Administration</label>
            <div className="chip-row">
              {SITE_PAGES.map((page) => (
                <PageChip key={page.id} page={page} on={editing.held.has(page.slug)} onToggle={() => toggle(page.slug)} />
              ))}
            </div>
            <p className="small">
              These ticks are what makes an administrator — they carry the Settings and
              user/role admin screens (and their writes) like any other page.
            </p>
          </div>

          {(() => {
            const extra = [...editing.held].filter(
              (p) => !(PERMISSIONS as readonly string[]).includes(p),
            )
            if (!extra.length) return null
            return (
              <p className="small">
                This role also holds <b>{extra.join(', ')}</b> — outside this app's catalog
                (probably retired). Saving clears them.
              </p>
            )
          })()}

          <p className="small">
            {[...editing.held].some((p) => p.startsWith('page.'))
              ? 'Saving takes effect on each holder’s next poll — no reload needed.'
              : 'No pages ticked: holders of only this role keep the whole day’s work.'}
          </p>
        </Modal>
      ) : null}

      <p className="small">
        Page permissions narrow: a user holding any ticked page sees exactly their ticked
        pages (the union across all their roles) instead of the whole day's work. A role
        with nothing ticked is the operator — the whole day's work. A ticked page carries
        that page's writes too; the server refuses a scoped user's commits to any other
        page's tables. A full administrator is just a role with every page ticked.
      </p>
      <p className="small">
        Roles cannot be deleted from here — WorkOS's management API does not expose it. A role
        nobody holds and nothing ticked is inert: retire it by clearing its permissions, or delete
        it in the WorkOS dashboard. WorkOS's built-in <code>member</code> and <code>admin</code>{' '}
        roles are not shown — they cannot be deleted and carry none of the app's permissions; a
        user with no roles at all is an operator (the day's work only).
      </p>

      {creating ? (
        <NewRoleDialog
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={(body) => void run(`Role ${body.slug} created.`, () => adminRoleAction(body))}
        />
      ) : null}
    </div>
  )
}

function NewRoleDialog({
  busy,
  onClose,
  onSave,
}: {
  busy: boolean
  onClose: () => void
  onSave: (body: { action: 'create-role'; slug: string; name: string }) => void
}) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const slugOk = /^[a-z0-9][a-z0-9.\-_:*]*$/.test(slug)
  return (
    <Modal
      title="New role"
      open
      onClose={onClose}
      saveDisabled={busy || !slugOk || !name.trim()}
      onSave={() => onSave({ action: 'create-role', slug, name: name.trim() })}
    >
      <div className="field">
        <label>Slug (lowercase, no spaces — permanent once created)</label>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" placeholder="shift-lead" />
      </div>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="Shift Lead" />
      </div>
      <p className="small">
        The role starts with no permissions — tick its pages once it appears.
      </p>
    </Modal>
  )
}
