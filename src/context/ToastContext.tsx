import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * Transient messages, kept deliberately apart from the plant's state.
 *
 * These used to live in `AppProvider` beside the entire database. Because the context
 * value there is rebuilt on every render, a toast appearing — and again 2.8 seconds
 * later when it expired — re-rendered every screen in the app, inventory tables and
 * all, twice, for a line of text at the bottom of the window. A toast is not plant
 * data and does not belong in the provider that holds it.
 *
 * `showToast` is stable, so anything that only needs to *raise* a message never
 * re-renders when one is shown. Only `Toast` itself subscribes to the message.
 */
interface ToastState {
  message: string
  id: number
}

const ToastValueContext = createContext<ToastState | null>(null)
const ShowToastContext = createContext<((message: string) => void) | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)

  const showToast = useCallback((message: string) => {
    setToast({ message, id: Date.now() })
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2800)
    return () => clearTimeout(t)
  }, [toast])

  const value = useMemo(() => toast, [toast])

  return (
    <ShowToastContext.Provider value={showToast}>
      <ToastValueContext.Provider value={value}>{children}</ToastValueContext.Provider>
    </ShowToastContext.Provider>
  )
}

/** The message currently on screen. Only `Toast` should need this. */
export function useToastMessage() {
  return useContext(ToastValueContext)
}

/** Raise a message. Stable across renders, so holding it costs a consumer nothing. */
export function useToast() {
  const ctx = useContext(ShowToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
