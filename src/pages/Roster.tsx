/**
 * The plant roster.
 *
 * Three views of the same people: the week grid (who is on which shift, one cell
 * per person per day), attendance for one day, and the staff register. The grid
 * is the working surface — a cell is clicked, a shift is picked, done — while the
 * register is a master: administrators edit it, everyone reads it.
 */

import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import {
  SortHeader,
  SortSelect,
  sortRows,
  useTableSort,
  type SortAccessors,
} from '../components/tableSort'
import { StatusBadge } from '../components/StatusBadge'
import { useAuth } from '../context/AuthContext'
import { useApp } from '../context/AppContext'
import { fmtDate, toDateKey } from '../lib/utils'
import type { ShiftAssignment, ShiftName, StaffMember } from '../types'

const SHIFTS: ShiftName[] = ['Morning', 'Evening', 'General']
const LINES = ['Extraction', 'Melange', 'Packing', 'QC', 'Dispatch', 'General']
const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Leave', 'Half day'] as const

/** The Monday of the week `d` falls in. */
const mondayOf = (d: Date) => {
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return monday
}

const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00`)
  d.setDate(d.getDate() + n)
  return toDateKey(d)
}

type Tab = 'week' | 'attendance' | 'staff'

export function Roster() {
  const { state, addStaff, updateStaff, setStaffStatus, setShift, clearShift, setAttendance } =
    useApp()
  const { isAdmin } = useAuth()

  const [tab, setTab] = useState<Tab>('week')
  const [weekOf, setWeekOf] = useState(() => toDateKey(mondayOf(new Date())))
  const [attDate, setAttDate] = useState(() => toDateKey())

  /** The shift dialog's person and day, with the form for what they are on. */
  const [shiftFor, setShiftFor] = useState<{ staffId: string; date: string } | null>(null)
  const [shiftForm, setShiftForm] = useState<{ shift: ShiftName; line: string; note: string }>({
    shift: 'Morning',
    line: LINES[0],
    note: '',
  })

  const [staffSearch, setStaffSearch] = useState('')
  const [staffEditId, setStaffEditId] = useState<string | null | undefined>(undefined)
  const [staffForm, setStaffForm] = useState({ name: '', role: '', phone: '' })

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekOf, i)), [weekOf])
  const today = toDateKey()
  const activeStaff = state.staff.filter((s) => s.status === 'Active')
  const shiftById = useMemo(
    () => new Map(state.shifts.map((s) => [s.id, s])),
    [state.shifts],
  )
  const attendanceById = useMemo(
    () => new Map(state.attendance.map((a) => [a.id, a])),
    [state.attendance],
  )

  const editing = staffEditId ? state.staff.find((s) => s.id === staffEditId) : undefined

  const openShiftCell = (staffId: string, date: string) => {
    const existing = shiftById.get(`${staffId}|${date}`)
    setShiftForm({
      shift: existing?.shift || 'Morning',
      line: existing?.line || LINES[0],
      note: existing?.note || '',
    })
    setShiftFor({ staffId, date })
  }

  // ── Week grid ────────────────────────────────────────────────────────────────
  const weekGrid = (
    <div className="toolbar roster-week-nav">
      <button className="btn btn-light" type="button" onClick={() => setWeekOf(addDays(weekOf, -7))}>
        ‹ Previous
      </button>
      <button className="btn btn-light" type="button" onClick={() => setWeekOf(addDays(weekOf, 7))}>
        Next ›
      </button>
      <span className="small">
        {fmtDate(days[0])} – {fmtDate(days[6])}
        {weekOf === toDateKey(mondayOf(new Date())) ? ' · this week' : ''}
      </span>
    </div>
  )

  const dayHead = (key: string) => {
    const d = new Date(`${key}T00:00:00`)
    const name = d.toLocaleDateString('en-IN', { weekday: 'short' })
    return key === today ? <b>{name}</b> : name
  }

  const weekBody = activeStaff.length ? (
    <div className="table-wrap">
      <table className="roster-grid">
        <thead>
          <tr>
            <th>Staff</th>
            {days.map((d) => (
              <th key={d} className="cell-tight">
                {dayHead(d)} {Number(d.slice(8))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {activeStaff.map((m) => (
            <tr key={m.id}>
              <td data-label="Staff">
                <b>{m.name}</b>
                <div className="cell-sub">{m.role || '—'}</div>
              </td>
              {days.map((d) => {
                const shift = shiftById.get(`${m.id}|${d}`)
                return (
                  <td key={d} data-label={`${dayHead(d)} ${Number(d.slice(8))}`}>
                    <button
                      type="button"
                      className={`shift-cell${shift ? ' set' : ''}`}
                      onClick={() => openShiftCell(m.id, d)}
                      title={shift ? `${shift.shift} · ${shift.line}` : 'Set a shift'}
                    >
                      {shift ? (
                        <>
                          <span className="shift-tag">{shift.shift}</span>
                          <span className="small">{shift.line}</span>
                        </>
                      ) : (
                        <span className="small">—</span>
                      )}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <EmptyState
        filtered={false}
        empty="No one is on the roster yet. Add staff on the Staff tab."
        onClear={() => setTab('staff')}
      />
    </div>
  )

  // ── Attendance ───────────────────────────────────────────────────────────────
  const rosteredThatDay = state.shifts
    .filter((s) => s.date === attDate)
    .map((s) => s.staffId)
  const rosteredStaff = activeStaff
    .filter((m) => rosteredThatDay.includes(m.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const unrosteredStaff = activeStaff.filter((m) => !rosteredThatDay.includes(m.id))
  const dayStaff = [...rosteredStaff, ...unrosteredStaff]
  const marks = dayStaff.map((m) => attendanceById.get(`${m.id}|${attDate}`)?.status)
  const counted = (of: string) => marks.filter((x) => x === of).length

  const attendanceBody = dayStaff.length ? (
    <>
      <div className="toolbar">
        <input
          type="date"
          value={attDate}
          max={today}
          onChange={(e) => setAttDate(e.target.value)}
          aria-label="Attendance for"
        />
        <span className="small">
          {counted('Present')} present · {counted('Absent')} absent · {counted('Leave')} leave ·{' '}
          {counted('Half day')} half day
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Staff</th>
              <th>Shift</th>
              <th>Marked</th>
            </tr>
          </thead>
          <tbody>
            {dayStaff.map((m) => {
              const shift = shiftById.get(`${m.id}|${attDate}`)
              const marked = attendanceById.get(`${m.id}|${attDate}`)?.status
              return (
                <tr key={m.id}>
                  <td data-label="Staff">
                    <b>{m.name}</b>
                    <div className="cell-sub">{m.role || '—'}</div>
                  </td>
                  <td data-label="Shift">
                    {shift ? `${shift.shift} · ${shift.line}` : <span className="small">Not rostered</span>}
                  </td>
                  <td data-label="Marked">
                    <div className="type-tabs attendance-marks">
                      {ATTENDANCE_STATUSES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={`type-tab${marked === s ? ' active' : ''}`}
                          onClick={() => setAttendance(m.id, attDate, s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  ) : (
    <div className="empty">
      <EmptyState
      filtered={false}
      empty="No active staff to mark. Add staff on the Staff tab."
      onClear={() => setTab('staff')}
    />
    </div>
  )

  // ── Staff register ───────────────────────────────────────────────────────────
  const { sort, toggle, setSort } = useTableSort()
  const sortBy: SortAccessors<StaffMember> = {
    name: (s) => s.name,
    role: (s) => s.role,
    phone: (s) => s.phone,
    status: (s) => s.status,
    added: (s) => s.addedOn,
  }
  const staffList = useMemo(() => {
    const q = staffSearch.trim().toLowerCase()
    return state.staff.filter((s) =>
      [s.name, s.role, s.phone || ''].join(' ').toLowerCase().includes(q),
    )
  }, [staffSearch, state.staff])
  const sortedStaff = sortRows(staffList, sort, sortBy)

  const openStaffForm = (member?: StaffMember) => {
    setStaffForm({
      name: member?.name || '',
      role: member?.role || '',
      phone: member?.phone || '',
    })
    setStaffEditId(member?.id ?? null)
  }

  const staffBody = (
    <>
      <div className="toolbar">
        <input
          placeholder="Search name, role or phone"
          value={staffSearch}
          onChange={(e) => setStaffSearch(e.target.value)}
        />
        {isAdmin ? (
          <button className="btn btn-primary" type="button" onClick={() => openStaffForm()}>
            + Add Staff
          </button>
        ) : null}
      </div>
      <SortSelect
        sort={sort}
        onPick={setSort}
        columns={[
          { k: 'name', label: 'Name' },
          { k: 'role', label: 'Role' },
          { k: 'phone', label: 'Phone', kind: 'text' },
          { k: 'status', label: 'Status' },
        ]}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Name" k="name" sort={sort} onToggle={toggle} />
              <SortHeader label="Role" k="role" sort={sort} onToggle={toggle} />
              <SortHeader label="Phone" k="phone" sort={sort} onToggle={toggle} />
              <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
              {isAdmin ? <th className="cell-actions">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {!sortedStaff.length ? (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="empty">
                  <EmptyState
                    filtered={!!staffSearch.trim()}
                    empty="No staff yet."
                    onClear={() => setStaffSearch('')}
                  />
                </td>
              </tr>
            ) : (
              sortedStaff.map((m) => (
                <tr key={m.id}>
                  <td data-label="Name">
                    <b>{m.name}</b>
                    <div className="cell-sub cell-id">{m.id}</div>
                  </td>
                  <td data-label="Role">{m.role || '—'}</td>
                  <td data-label="Phone" className="cell-id">
                    {m.phone || '—'}
                  </td>
                  <td data-label="Status">
                    <StatusBadge value={m.status} />
                  </td>
                  {isAdmin ? (
                    <td className="cell-actions">
                      <div className="row-actions">
                        <button className="btn btn-light" type="button" onClick={() => openStaffForm(m)}>
                          Edit
                        </button>
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => setStaffStatus(m.id, m.status === 'Active' ? 'Inactive' : 'Active')}
                        >
                          {m.status === 'Active' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )

  const shiftTarget = shiftFor
    ? state.staff.find((s) => s.id === shiftFor.staffId)
    : undefined
  const existingShift: ShiftAssignment | undefined = shiftFor
    ? shiftById.get(`${shiftFor.staffId}|${shiftFor.date}`)
    : undefined

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Staff Roster</h3>
          <span>Who is on which shift, and who turned up</span>
        </div>
      </div>

      <div className="vendors-toolbar">
        <div className="type-tabs" role="tablist">
          {(
            [
              ['week', 'This week'],
              ['attendance', 'Attendance'],
              ['staff', 'Staff'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`type-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'week' ? (
        <>
          {weekGrid}
          {weekBody}
        </>
      ) : null}
      {tab === 'attendance' ? attendanceBody : null}
      {tab === 'staff' ? staffBody : null}

      <Modal
        open={!!shiftFor}
        title={shiftTarget && shiftFor ? `${shiftTarget.name} · ${fmtDate(shiftFor.date)}` : 'Shift'}
        saveLabel={existingShift ? 'Update Shift' : 'Set Shift'}
        onClose={() => setShiftFor(null)}
        footerLeft={
          existingShift && shiftFor ? (
            <button
              className="btn btn-light"
              type="button"
              onClick={() => {
                clearShift(shiftFor.staffId, shiftFor.date)
                setShiftFor(null)
              }}
            >
              Clear Shift
            </button>
          ) : undefined
        }
        onSave={() => {
          if (!shiftFor) return
          setShift(shiftFor.staffId, shiftFor.date, shiftForm)
          setShiftFor(null)
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Shift</label>
            <Select
              value={shiftForm.shift}
              onChange={(e) => setShiftForm((f) => ({ ...f, shift: e.target.value as ShiftName }))}
            >
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>On</label>
            <Select
              value={shiftForm.line}
              onChange={(e) => setShiftForm((f) => ({ ...f, line: e.target.value }))}
            >
              {LINES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="field span-2">
            <label>Note (optional)</label>
            <input
              value={shiftForm.note}
              placeholder="Anything the next shift should know"
              onChange={(e) => setShiftForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={staffEditId !== undefined}
        title={editing ? `Edit ${editing.name}` : 'Add staff'}
        saveLabel={editing ? 'Save Changes' : 'Add'}
        onClose={() => setStaffEditId(undefined)}
        onSave={() => {
          if (editing) {
            if (updateStaff(editing.id, staffForm)) setStaffEditId(undefined)
          } else if (addStaff(staffForm)) {
            setStaffEditId(undefined)
          }
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label>Name</label>
            <input
              value={staffForm.name}
              placeholder="Full name"
              onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Role</label>
            <input
              value={staffForm.role}
              placeholder="e.g. Extraction operator"
              onChange={(e) => setStaffForm((f) => ({ ...f, role: e.target.value }))}
            />
          </div>
          <div className="field span-2">
            <label>Phone</label>
            <input
              value={staffForm.phone}
              placeholder="Optional"
              onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
