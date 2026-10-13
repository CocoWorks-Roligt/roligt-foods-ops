// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraft } from './useDraft.ts'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

describe('useDraft', () => {
  it('saves edits after the debounce and restores them on the next mount', () => {
    const first = renderHook(() => useDraft('grn', { note: '' }))
    act(() => {
      first.result.current.set({ note: 'driver waited' })
    })
    expect(localStorage.getItem('roligt_draft_grn')).toBeNull() // not yet
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(JSON.parse(localStorage.getItem('roligt_draft_grn')!)).toMatchObject({
      value: { note: 'driver waited' },
    })
    first.unmount()

    const second = renderHook(() => useDraft('grn', { note: '' }))
    expect(second.result.current.value).toEqual({ note: 'driver waited' })
    expect(second.result.current.restored).toBe(true)
  })

  it('writes nothing for a form merely opened', () => {
    const { unmount } = renderHook(() => useDraft('fresh', { a: 1 }))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    unmount()
    expect(localStorage.getItem('roligt_draft_fresh')).toBeNull()
  })

  it('clear forgets the draft — a reopen starts empty', () => {
    const first = renderHook(() => useDraft('qc', { x: 'words' }))
    first.result.current.set({ x: 'words' })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    first.result.current.clear()
    expect(localStorage.getItem('roligt_draft_qc')).toBeNull()

    const second = renderHook(() => useDraft('qc', { x: '' }))
    expect(second.result.current.value).toEqual({ x: '' })
    expect(second.result.current.restored).toBe(false)
  })

  it('keeps drafts of different forms apart', () => {
    const a = renderHook(() => useDraft('form-a', { v: 'a' }))
    const b = renderHook(() => useDraft('form-b', { v: 'b' }))
    act(() => {
      a.result.current.set({ v: 'A!' })
      b.result.current.set({ v: 'B!' })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    a.unmount()
    b.unmount()
    expect(JSON.parse(localStorage.getItem('roligt_draft_form-a')!).value).toEqual({ v: 'A!' })
    expect(JSON.parse(localStorage.getItem('roligt_draft_form-b')!).value).toEqual({ v: 'B!' })
  })
})
