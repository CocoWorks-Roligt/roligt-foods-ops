import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { Modal } from '../../components/Modal'
import { Select } from '../../components/Select'
import { SortHeader, sortRows, useTableSort, type SortAccessors } from '../../components/tableSort'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import {
  adminUserAction,
  fetchAdminRoles,
  fetchAdminUsers,
  type AdminUserRow,
} from '../../lib/adminApi'
import { fmtDate } from '../../lib/utils'

/**
 * User administration — who can sign in, and as what.
 *
 * The accounts and their roles live in WorkOS; this screen is the plant-side
 * window onto them, so an administrator never has to send anyone to a
 * provider's dashboard to grant a colleague access. Every action here rides
 * /api/admin/users, which checks the Users page tick and files an audit row.
 */

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'invite' }
  | { kind: 'roles'; user: AdminUserRow }
  | { kind: 'delete'; user: AdminUserRow }

const accessors: SortAccessors<AdminUserRow> = {
  email: (u) => u.email,
  name: (u) => u.name,
  status: (u) => u.status,
  roles: (u) => u.roles.join(','),
  lastSignIn: (u) => u.lastSignInAt ?? '',
}

export function Users() {
  const showToast = useToast()
  const { session } = useAuth()
  const self = session?.user.email ?? ''
  // Case-insensitive, and truthy-only: while the session is still loading the
  // comparison must not quietly match every row. The server refuses self-actions
  // regardless — this disable is courtesy, not the guard.
  const isSelf = (u: AdminUserRow) => !!self && u.email.toLowerCase() === self.toLowerCase()
  const [users, setUsers] = useState<AdminUserRow[] | null>(null)
  const [roleSlugs, setRoleSlugs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const { sort, toggle } = useTableSort('email', 'asc')

  const reload = async () => {
    try {
      const [u, r] = await Promise.all([fetchAdminUsers(), fetchAdminRoles()])
      setUsers(u)
      setRoleSlugs(r.roles.map((role) => role.slug))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read users.')
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
      await reload()
      setDialog({ kind: 'none' })
    } else {
      setError(result.error ?? 'The change was refused.')
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = users ?? []
    if (!q) return rows
    return rows.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.roles.join(',').toLowerCase().includes(q),
    )
  }, [users, search])
  const sorted = sortRows(filtered, sort, accessors)

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          placeholder="Search email, name or role"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn btn-light" type="button" onClick={() => setDialog({ kind: 'invite' })}>
          + Invite by email
        </button>
        <button className="btn btn-primary" type="button" onClick={() => setDialog({ kind: 'create' })}>
          + Add user
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Email" k="email" sort={sort} onToggle={toggle} />
              <SortHeader label="Name" k="name" sort={sort} onToggle={toggle} />
              <SortHeader label="Roles" k="roles" sort={sort} onToggle={toggle} />
              <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
              <SortHeader label="Last sign-in" k="lastSignIn" sort={sort} onToggle={toggle} />
              <th className="cell-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {!sorted.length ? (
              <tr>
                <td colSpan={6} className="empty">
                  <EmptyState
                    filtered={!!search.trim()}
                    empty={
                      users === null
                        ? 'Reading users…'
                        : 'No users yet. Invite a colleague by email, or add one with a password.'
                    }
                    onClear={() => setSearch('')}
                  />
                </td>
              </tr>
            ) : (
              sorted.map((u) => (
                <tr key={u.membershipId}>
                  <td data-label="Email">
                    <b>{u.email}</b>
                    {u.status === 'inactive' ? (
                      <div className="cell-sub">deactivated — cannot sign in</div>
                    ) : null}
                  </td>
                  <td data-label="Name">{u.name || '—'}</td>
                  <td data-label="Roles">{u.roles.length ? u.roles.join(', ') : '—'}</td>
                  <td data-label="Status">{u.status}</td>
                  <td data-label="Last sign-in" className="cell-id">
                    {u.lastSignInAt ? fmtDate(u.lastSignInAt.slice(0, 10)) : 'never'}
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <button
                        className="btn btn-light"
                        type="button"
                        onClick={() => setDialog({ kind: 'roles', user: u })}
                      >
                        Roles
                      </button>
                      <button
                        className="btn btn-light"
                        type="button"
                        disabled={busy || (u.status === 'active' && isSelf(u))}
                        title={u.status === 'active' && isSelf(u) ? 'You cannot deactivate your own access.' : undefined}
                        onClick={() =>
                          void run(
                            u.status === 'active' ? 'User deactivated.' : 'User reactivated.',
                            () =>
                              adminUserAction(
                                u.status === 'active'
                                  ? { action: 'deactivate', membershipId: u.membershipId }
                                  : { action: 'reactivate', membershipId: u.membershipId },
                              ),
                          )
                        }
                      >
                        {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                      </button>
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={busy || isSelf(u)}
                        title={isSelf(u) ? 'You cannot remove or delete your own access.' : undefined}
                        onClick={() => setDialog({ kind: 'delete', user: u })}
                      >
                        Delete…
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {dialog.kind === 'create' ? (
        <CreateDialog
          roleSlugs={roleSlugs}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSave={(body) => void run('User created.', () => adminUserAction(body))}
        />
      ) : null}
      {dialog.kind === 'invite' ? (
        <InviteDialog
          roleSlugs={roleSlugs}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSave={(body) => void run('Invitation sent.', () => adminUserAction(body))}
        />
      ) : null}
      {dialog.kind === 'roles' ? (
        <RolesDialog
          user={dialog.user}
          roleSlugs={roleSlugs}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onSave={(body) => void run('Roles updated.', () => adminUserAction(body))}
        />
      ) : null}
      {dialog.kind === 'delete' ? (
        <DeleteDialog
          user={dialog.user}
          busy={busy}
          onClose={() => setDialog({ kind: 'none' })}
          onRemove={() =>
            void run(`Access removed for ${dialog.user.email}.`, () =>
              adminUserAction({ action: 'remove', membershipId: dialog.user.membershipId }),
            )
          }
          onDelete={() =>
            void run(`${dialog.user.email} was permanently deleted.`, () =>
              adminUserAction({ action: 'delete', userId: dialog.user.userId }),
            )
          }
        />
      ) : null}
    </div>
  )
}

/** One role picked from a Select — the simple cases; the matrix handles nuance.
 *  The empty choice is the operator tier: no roles, the day's work only. */
function RolePicker({
  value,
  onChange,
  slugs,
}: {
  value: string
  onChange: (slug: string) => void
  slugs: string[]
}) {
  return (
    <div className="field">
      <label>Role</label>
      <Select
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      >
        <option value="">No role — the day's work only</option>
        {slugs.map((slug) => (
          <option key={slug} value={slug}>
            {slug}
          </option>
        ))}
      </Select>
    </div>
  )
}

function CreateDialog({
  roleSlugs,
  busy,
  onClose,
  onSave,
}: {
  roleSlugs: string[]
  busy: boolean
  onClose: () => void
  onSave: (body: {
    action: 'create'
    email: string
    name?: string
    password?: string
    roleSlugs: string[]
  }) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('')
  return (
    <Modal
      title="Add user"
      open
      onClose={onClose}
      saveDisabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)}
      onSave={() =>
        onSave({
          action: 'create',
          email: email.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(password ? { password } : {}),
          roleSlugs: role ? [role] : [],
        })
      }
    >
      <div className="field">
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label>Password (optional — they can reset by email)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <RolePicker value={role} onChange={setRole} slugs={roleSlugs} />
    </Modal>
  )
}

function InviteDialog({
  roleSlugs,
  busy,
  onClose,
  onSave,
}: {
  roleSlugs: string[]
  busy: boolean
  onClose: () => void
  onSave: (body: { action: 'invite'; email: string; roleSlugs?: string[] }) => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  return (
    <Modal
      title="Invite by email"
      open
      onClose={onClose}
      saveDisabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)}
      onSave={() => onSave({ action: 'invite', email: email.trim(), roleSlugs: role ? [role] : [] })}
    >
      <p className="small">
        WorkOS sends the invitation; the colleague sets their own password. A role can be adjusted
        after they accept.
      </p>
      <div className="field">
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </div>
      <RolePicker value={role} onChange={setRole} slugs={roleSlugs} />
    </Modal>
  )
}

function RolesDialog({
  user,
  roleSlugs,
  busy,
  onClose,
  onSave,
}: {
  user: AdminUserRow
  roleSlugs: string[]
  busy: boolean
  onClose: () => void
  onSave: (body: { action: 'set-roles'; membershipId: string; roleSlugs: string[] }) => void
}) {
  // Chips, not a Select: a membership can carry several roles, and the whole
  // point of the multiple-roles setting is composing them.
  const [held, setHeld] = useState<Set<string>>(new Set(user.roles))
  const toggle = (slug: string) => {
    setHeld((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }
  return (
    <Modal title={`Roles — ${user.email}`} open onClose={onClose} saveDisabled={busy} onSave={() => onSave({ action: 'set-roles', membershipId: user.membershipId, roleSlugs: [...held] })}>
      <p className="small">The roles take effect on this user's next sign-in.</p>
      <div className="chip-row">
        {roleSlugs.map((slug) => (
          <button
            key={slug}
            type="button"
            className={`btn ${held.has(slug) ? 'btn-primary' : 'btn-light'}`}
            aria-pressed={held.has(slug)}
            onClick={() => toggle(slug)}
          >
            {slug}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/**
 * The destructive confirm — one dialog, two severities. Removing keeps the
 * WorkOS account (coming back later is one action here); deleting destroys it.
 * The server refuses both on the caller's own row, so the button is the only
 * guard this dialog needs beyond its own wording.
 */
function DeleteDialog({
  user,
  busy,
  onClose,
  onRemove,
  onDelete,
}: {
  user: AdminUserRow
  busy: boolean
  onClose: () => void
  onRemove: () => void
  onDelete: () => void
}) {
  const [mode, setMode] = useState<'remove' | 'delete'>('remove')
  return (
    <Modal
      title={`Remove ${user.email}?`}
      open
      onClose={onClose}
      saveLabel={mode === 'remove' ? 'Remove access' : 'Delete permanently'}
      saveClass="btn btn-danger"
      saveDisabled={busy}
      onSave={mode === 'remove' ? onRemove : onDelete}
    >
      <div className="chip-row">
        <button
          type="button"
          className={`btn ${mode === 'remove' ? 'btn-primary' : 'btn-light'}`}
          aria-pressed={mode === 'remove'}
          onClick={() => setMode('remove')}
        >
          Remove from organization
        </button>
        <button
          type="button"
          className={`btn ${mode === 'delete' ? 'btn-primary' : 'btn-light'}`}
          aria-pressed={mode === 'delete'}
          onClick={() => setMode('delete')}
        >
          Delete permanently
        </button>
      </div>
      <p className="small">
        {mode === 'remove'
          ? 'They can no longer sign in, but their WorkOS account is kept — bringing them back later is one action here.'
          : 'The WorkOS account and every organization membership of it are destroyed. There is no undo.'}
      </p>
      <p className="small">Their documents and audit rows stay — the plant's records are never rewritten.</p>
    </Modal>
  )
}
