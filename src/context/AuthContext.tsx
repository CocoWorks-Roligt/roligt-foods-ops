import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Role } from '../types'
import { setAuthTokenProvider, setUnauthorizedHandler } from '../lib/authToken'
import { KINDE_CONFIGURED, getDevRole } from '../lib/authMode'

/** A structural subset of the Kinde session — everything the app reads from it. */
export interface SessionLike {
  user: { email: string }
}

interface AuthContextValue {
  session: SessionLike | null
  ready: boolean
  /** Unknown until the provider resolved it; treated as Operator until then. */
  role: Role
  isAdmin: boolean
  /** Starts the Kinde hosted login (arguments kept for interface stability). */
  signIn: (email: string, password: string) => Promise<string | null>
  /** Kinde owns password resets; this tells the user where to go. */
  sendPasswordReset: (email: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionLike | null>(null)
  const [role, setRole] = useState<Role>('Operator')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!KINDE_CONFIGURED) {
      // Dev fallback: no Kinde account yet. Role is switchable from the login screen.
      setSession({ user: { email: 'dev@roligt.local' } })
      setRole(getDevRole())
      setAuthTokenProvider(async () => null) // BFF runs with ALLOW_DEV_SESSION=1
      setUnauthorizedHandler(null)
      setReady(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        // The SDK is loaded dynamically so the fallback path has no Kinde code at all.
        // The token is handed over as a provider, not a value: Kinde access tokens
        // expire and the SDK refreshes them, so dbApi must ask for a current one on
        // every request rather than reuse the string captured at sign-in.
        const { getKindeSession, freshToken } = await import('../lib/kindeSession')
        setAuthTokenProvider((force) => freshToken(force))
        const s = await getKindeSession()
        if (cancelled) return
        setSession(s.session)
        setRole(s.role)
      } catch {
        if (!cancelled) setSession(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The BFF refused the token even after a forced refresh (dbApi's 401 path):
  // the session is dead. Clearing it renders the login screen; this device's
  // unsaved work survives in the local mirror and is pushed after re-signing-in.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null)
      setRole('Operator')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const signIn = useCallback(async () => {
    if (KINDE_CONFIGURED) {
      const { login } = await import('../lib/kindeSession')
      await login()
      return null // the browser leaves for the hosted page
    }
    // Dev fallback: enter (or re-enter) the dev session with the role picked on
    // the login screen. The mount effect has [] deps and never re-fires, so this
    // is the only way back in after a fallback signOut.
    setSession({ user: { email: 'dev@roligt.local' } })
    setRole(getDevRole())
    setAuthTokenProvider(async () => null) // BFF dev session covers it
    return null
  }, [])

  const sendPasswordReset = useCallback(async () => {
    return 'Passwords are managed in Kinde — ask an administrator to reset it.'
  }, [])

  const signOut = useCallback(async () => {
    if (KINDE_CONFIGURED) {
      const { logout } = await import('../lib/kindeSession')
      await logout()
      return
    }
    // Dev fallback: land on the login screen (no reload) so the role picker is
    // reachable and the picked role survives as the next default.
    setSession(null)
    setRole('Operator')
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
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
