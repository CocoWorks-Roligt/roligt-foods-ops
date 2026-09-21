/**
 * The plant roster — who exists, who is on which shift, and who turned up.
 *
 * Three lists, deliberately small. A person is a master like a vendor: never
 * deleted, only deactivated, because shifts and attendance keep naming them. A
 * shift and an attendance mark are both keyed `staffId|date`, so saving the same
 * person and day again replaces what was there — there is no such thing as two
 * shifts or two verdicts, and no delete-vs-edit ambiguity to police.
 */

import { useCallback } from 'react'
import { deepClone } from '../../lib/utils'
import type { ShiftName, StaffMember } from '../../types'
import { POSTED } from './deps'
import type { CoreDeps } from './deps'

export interface StaffInput {
  name: string
  role: string
  phone?: string
}

/** What a person is on for a day, as the shift dialog states it. */
export interface ShiftInput {
  shift: ShiftName
  line: string
  note?: string
}

export function useStaffRoster({ state, setState, nextId, log, showToast, forbidden }: CoreDeps) {
  const addStaff = useCallback(
    (input: StaffInput): string | null => {
      if (forbidden('Changing the staff register')) return null
      const name = input.name.trim()
      if (!name) {
        showToast('Staff name is required.')
        return null
      }
      if (state.staff.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        showToast(`${name} is already on the roster.`)
        return null
      }
      let createdId = ''
      setState((prev) => {
        const draft = deepClone(prev)
        const member: StaffMember = {
          id: nextId(draft, 'staff'),
          name,
          role: input.role.trim(),
          phone: input.phone?.trim() || undefined,
          status: 'Active',
          addedOn: new Date().toISOString().slice(0, 10),
        }
        draft.staff.push(member)
        log(draft, 'Added staff', member.id, `${member.name}${member.role ? ` (${member.role})` : ''}`)
        createdId = member.id
        return draft
      })
      showToast(`${name} added to the roster.`)
      return createdId || POSTED
    },
    [forbidden, log, nextId, setState, showToast, state.staff],
  )

  const updateStaff = useCallback(
    (id: string, patch: StaffInput): string | null => {
      if (forbidden('Changing the staff register')) return null
      const name = patch.name.trim()
      const existing = state.staff.find((s) => s.id === id)
      if (!existing) return null
      if (!name) {
        showToast('Staff name is required.')
        return null
      }
      if (state.staff.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) {
        showToast(`${name} is already on the roster.`)
        return null
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const member = draft.staff.find((s) => s.id === id)
        if (!member) return prev
        member.name = name
        member.role = patch.role.trim()
        member.phone = patch.phone?.trim() || undefined
        // Shifts and attendance name the person by id, so renaming them rewrites
        // nobody's history — the id is the person, the name is only how it prints.
        log(draft, 'Updated staff', member.id, member.name)
        return draft
      })
      showToast(`${name} updated.`)
      return POSTED
    },
    [forbidden, log, setState, showToast, state.staff],
  )

  const setStaffStatus = useCallback(
    (id: string, status: 'Active' | 'Inactive') => {
      if (forbidden('Changing the staff register')) return
      setState((prev) => {
        const draft = deepClone(prev)
        const member = draft.staff.find((s) => s.id === id)
        if (!member) return prev
        member.status = status
        log(draft, 'Updated staff status', member.id, `${member.name}: ${status}`)
        return draft
      })
      showToast(status === 'Active' ? 'Back on the roster.' : 'Marked inactive. Their shifts and attendance stay on record.')
    },
    [forbidden, log, setState, showToast],
  )

  /** Puts a person on a shift for a day, replacing whatever they had that day. */
  const setShift = useCallback(
    (staffId: string, date: string, input: ShiftInput) => {
      const member = state.staff.find((s) => s.id === staffId)
      if (!member) return
      if (member.status !== 'Active') {
        showToast(`${member.name} is inactive. Reactivate them on the Staff tab first.`)
        return
      }
      setState((prev) => {
        const draft = deepClone(prev)
        const id = `${staffId}|${date}`
        const existing = draft.shifts.findIndex((s) => s.id === id)
        const assignment = {
          id,
          staffId,
          date,
          shift: input.shift,
          line: input.line,
          note: input.note?.trim() || undefined,
        }
        if (existing >= 0) draft.shifts[existing] = assignment
        else draft.shifts.push(assignment)
        log(draft, 'Set shift', staffId, `${member.name} · ${date} · ${input.shift} · ${input.line}`)
        return draft
      })
      showToast(`${member.name} is on ${input.shift} shift, ${input.line}.`)
    },
    [log, setState, showToast, state.staff],
  )

  const clearShift = useCallback(
    (staffId: string, date: string) => {
      const member = state.staff.find((s) => s.id === staffId)
      setState((prev) => {
        const draft = deepClone(prev)
        const before = draft.shifts.length
        draft.shifts = draft.shifts.filter((s) => s.id !== `${staffId}|${date}`)
        if (draft.shifts.length === before) return prev
        log(draft, 'Cleared shift', staffId, `${member?.name || staffId} · ${date}`)
        return draft
      })
      showToast('Shift cleared.')
    },
    [log, setState, showToast, state.staff],
  )

  /** Marks one person one day. Saving again for the same day overwrites the mark. */
  const setAttendance = useCallback(
    (staffId: string, date: string, status: 'Present' | 'Absent' | 'Leave' | 'Half day') => {
      const member = state.staff.find((s) => s.id === staffId)
      if (!member) return
      setState((prev) => {
        const draft = deepClone(prev)
        const id = `${staffId}|${date}`
        const existing = draft.attendance.findIndex((a) => a.id === id)
        const record = { id, staffId, date, status }
        if (existing >= 0) draft.attendance[existing] = record
        else draft.attendance.push(record)
        log(draft, 'Marked attendance', staffId, `${member.name} · ${date} · ${status}`)
        return draft
      })
    },
    [log, setState, state.staff],
  )

  return { addStaff, updateStaff, setStaffStatus, setShift, clearShift, setAttendance }
}
