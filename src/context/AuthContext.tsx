import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Role } from '../types'
import { setUnauthorizedHandler } from '../lib/authEvents'
import { WORKOS_CONFIGURED, getDevRole } from '../lib/authMode'
import { fetchSession, type SessionLike } from '../lib/authSession'
import { devPermissions, isAdminPermissions, type PermissionKey } from '../lib/permissions.ts'
import { setSessionPermissions, useSessionPermissions } from '../lib/sessionPermissions'

export type { SessionLike }

interface AuthContextValue {
  session: SessionLike | null
  ready: boolean
  /**
   * Derived: 'Admin' exactly when the session holds the whole permission
   * catalog. Kept because Layout, Roster and the audit trail's actor column
   * speak the old vocabulary; new gating should use `can`/`permissions`.
   */
  role: Role
  isAdmin: boolean
  /** The slugs the BFF will honor for this caller (src/lib/permissions.ts). */
  permissions: string[]
  can: (perm: PermissionKey) => boolean
  /** Sends the browser to the hosted AuthKit page (dev: enters the dev session). */
  signIn: () => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionLike | null>(null)
  const [ready, setReady] = useState(false)
  // The live set lives in the sessionPermissions store: AuthContext seeds it
  // here, and AppContext refreshes it whenever a snapshot carries permissions,
  // so gating everywhere reacts without a reload.
  const permissions = useSessionPermissions()

  useEffect(() => {
    if (!WORKOS_CONFIGURED) {
      // Dev fallback: no WorkOS account yet. Role is switchable from the login
      // screen, and the picker's choice rides the x-dev-role header dbApi sends.
      setSession({ user: { email: 'dev@roligt.local' } })
      setSessionPermissions(devPermissions(getDevRole()))
      setUnauthorizedHandler(null)
      setReady(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const booted = await fetchSession()
        if (cancelled) return
        if (booted) {
          setSession(booted.session)
          setSessionPermissions(booted.permissions)
        } else {
          setSession(null)
          setSessionPermissions([])
        }
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

  // The BFF refused the session cookie (dbApi's 401 path): the session is dead.
  // Clearing it renders the login screen; this device's unsaved work survives in
  // the local mirror and is pushed after re-signing-in.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null)
      setSessionPermissions([])
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const signIn = useCallback(async () => {
    if (WORKOS_CONFIGURED) {
      // Off to the hosted AuthKit page (themed with our branding). The BFF
      // exchanges the code and seals the cookie; the flow's state brings the
      // browser back to this exact view.
      const back = window.location.pathname + window.location.search
      window.location.assign(`/api/auth/start?return=${encodeURIComponent(back)}`)
      return null // the browser leaves for the hosted page
    }
    // Dev fallback: enter (or re-enter) the dev session with the role picked on
    // the login screen. The mount effect has [] deps and never re-fires, so this
    // is the only way back in after a fallback signOut.
    setSession({ user: { email: 'dev@roligt.local' } })
    setSessionPermissions(devPermissions(getDevRole()))
    return null
  }, [])

  const signOut = useCallback(async () => {
    if (WORKOS_CONFIGURED) {
      // Ends the session at WorkOS and clears the cookie, then lands on '/' —
      // where the router shows this login screen again.
      window.location.assign('/api/auth/signout')
      return
    }
    // Dev fallback: land on the login screen (no reload) so the role picker is
    // reachable and the picked role survives as the next default.
    setSession(null)
    setSessionPermissions([])
  }, [])

  const role: Role = isAdminPermissions(permissions) ? 'Admin' : 'Operator'
  const can = useCallback((perm: PermissionKey) => permissions.includes(perm), [permissions])

  return (
    <AuthContext.Provider
      value={{ session, ready, role, isAdmin: role === 'Admin', permissions, can, signIn, signOut }}
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
