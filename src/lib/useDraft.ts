import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Draft autosave for the long forms (overhaul §6): work in progress survives
 * a closed tab, a dropped signal, a navigated-away finger — the same promise
 * the plant's mirror makes for saved work, made locally for unsaved work.
 *
 * A draft is written on every change (debounced, so a fast typer writes
 * paragraphs, not letters) and read back on the next mount of the same form
 * id. The form reports `restored` once when that happens, so the operator is
 * told their words came back rather than wondering why the form is full.
 * `clear()` forgets the draft — call it when the form submits, or from the
 * "discard draft" action beside the restored note. Storage may refuse
 * (private window, quota): the hook degrades to no autosave, never to a
 * crash.
 */

const PREFIX = 'roligt_draft_'

interface StoredDraft<T> {
  savedAt: string
  value: T
}

export interface Draft<T> {
  value: T
  set: (next: T) => void
  /** True when a saved draft was found and restored on mount. */
  restored: boolean
  /** Forget the stored draft; the current value is kept. */
  clear: () => void
}

export function useDraft<T>(id: string, initial: T): Draft<T> {
  const [value, setValue] = useState<T>(initial)
  const [restored, setRestored] = useState(false)
  /** Set on the first edit — nothing is written for a form merely opened. */
  const touched = useRef(false)
  const latest = useRef(value)
  latest.current = value
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read once per mount: a draft found there becomes the starting value.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFIX + id)
      if (!raw) return
      const parsed = JSON.parse(raw) as StoredDraft<T>
      if (parsed && typeof parsed === 'object' && 'value' in parsed) {
        setValue(parsed.value)
        setRestored(true)
      }
    } catch {
      // an unreadable draft is no draft
    }
  }, [id])

  // Write on change, debounced — and flush what is held when the form goes.
  useEffect(() => {
    if (!touched.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      try {
        localStorage.setItem(PREFIX + id, JSON.stringify({ savedAt: new Date().toISOString(), value } satisfies StoredDraft<T>))
      } catch {
        // no autosave — the form still works
      }
    }, 400)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [id, value])

  // The unmount flush: the last debounce never fired, but the operator's
  // last words are still the ones to keep.
  useEffect(
    () => () => {
      if (!touched.current) return
      try {
        localStorage.setItem(PREFIX + id, JSON.stringify({ savedAt: new Date().toISOString(), value: latest.current } satisfies StoredDraft<T>))
      } catch {
        // no autosave
      }
    },
    [id],
  )

  const set = useCallback((next: T) => {
    touched.current = true
    setValue(next)
  }, [])

  const clear = useCallback(() => {
    touched.current = false
    setRestored(false)
    try {
      localStorage.removeItem(PREFIX + id)
    } catch {
      // nothing stored
    }
  }, [id])

  return { value, set, restored, clear }
}
