import { useState } from 'react'
import { OfflineBar } from '../components/PwaPrompts'
import { useAuth } from '../context/AuthContext'
import { KINDE_CONFIGURED, getDevRole, setDevRole } from '../lib/authMode'
import type { Role } from '../types'

export function Login() {
  const { signIn, session } = useAuth()
  const [error, setError] = useState('')
  const [devRole, setPickedRole] = useState<Role>(getDevRole)

  const submit = async () => {
    setError('')
    const message = await signIn('', '')
    if (message) setError(message)
  }

  return (
    <div className="login-page">
      <div className="login-offline">
        <OfflineBar />
      </div>
      <div className="card login-card">
        <div className="section-head">
          <div>
            <h3>Roligt Foods</h3>
            <span>Sign in to Operations Control</span>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {KINDE_CONFIGURED ? (
            <button className="btn primary" type="submit">
              Sign in with Kinde
            </button>
          ) : (
            <>
              <div className="field" style={{ marginBottom: 14 }}>
                <label>Dev session — role</label>
                <select
                  value={devRole}
                  onChange={(e) => {
                    const next = e.target.value as Role
                    setDevRole(next) // persisted; applied by the context at sign-in
                    setPickedRole(next)
                  }}
                >
                  <option value="Admin">Admin</option>
                  <option value="Operator">Operator</option>
                </select>
                <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                  Dev fallback active (no Kinde env). You will sign in as{' '}
                  {session?.user.email ?? 'dev@roligt.local'}.
                </span>
              </div>
              <button className="btn primary" type="submit">
                Sign in
              </button>
            </>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </div>
    </div>
  )
}
