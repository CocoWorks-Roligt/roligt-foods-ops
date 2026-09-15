import type { Session } from '@supabase/supabase-js'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '../lib/supabaseClient'
import type { Role } from '../types'

interface AuthContextValue {
  session: Session | null
  ready: boolean
  /**
   * What this user is allowed to do. Read from `app_user`, which is also what the
   * database's own policies read — the UI and the RLS agree because they are looking
   * at the same row, rather than the UI being the only thing that ever checked.
   *
   * Unknown until the row comes back; treated as Operator until then, so a slow
   * network cannot briefly hand somebody the admin screens.
   */
  role: Role
  isAdmin: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  /** Sends the reset link. Resolves to an error message, or null when it went out. */
  sendPasswordReset: (email: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [role, setRole] = useState<Role>('Operator')

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      // Offline, a token refresh can reject. Fall through to the login screen rather
      // than leaving the app stuck on "Loading…" forever.
      .catch(() => setSession(null))
      .finally(() => setReady(true))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // The role travels with the user, not the session, so it is re-read whenever the
  // signed-in user changes. Anything that cannot be read is Operator: a failure to
  // establish that somebody is an admin must never be read as proof that they are.
  const userId = session?.user?.id
  useEffect(() => {
    let cancelled = false
    if (!userId) {
      setRole('Operator')
      return
    }
    supabase
      .from('app_user')
      .select('role')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setRole(data?.role === 'Admin' ? 'Admin' : 'Operator')
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error?.message || null
  }, [])

  /**
   * Locked out is a dead end otherwise: the app has no other way back in, and an
   * operator on a plant floor cannot be expected to find the Supabase console.
   */
  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    return error?.message || null
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  return (
    <AuthContext.Provider
      value={{ session, ready, role, isAdmin: role === 'Admin', signIn, sendPasswordReset, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
