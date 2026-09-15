import { useState } from 'react'
import { OfflineBar } from '../components/PwaPrompts'
import { useAuth } from '../context/AuthContext'

export function Login() {
  const { signIn, sendPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)

  const submit = async () => {
    if (!email || !password) {
      setError('Enter your email and password.')
      return
    }
    setLoading(true)
    setError('')
    setNotice('')
    const message = await signIn(email, password)
    setLoading(false)
    if (message) setError(message)
  }

  const resetPassword = async () => {
    if (!email) {
      setNotice('')
      setError('Type your email address first, then choose Forgot password.')
      return
    }
    setResetting(true)
    setError('')
    setNotice('')
    const message = await sendPasswordReset(email)
    setResetting(false)
    if (message) setError(message)
    else setNotice(`Reset link sent to ${email}. Open it on this device to set a new password.`)
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
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Email</label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? (
            <div className="note warning-note" style={{ marginBottom: 14 }}>
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="note" style={{ marginBottom: 14 }}>
              {notice}
            </div>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          {/* Without this, a forgotten password is the end of the road — there is no
              other way into the app and no one on the floor is opening Supabase. */}
          <button
            type="button"
            className="link-btn"
            disabled={resetting}
            style={{ display: 'block', margin: '14px auto 0' }}
            onClick={() => void resetPassword()}
          >
            {resetting ? 'Sending…' : 'Forgot password?'}
          </button>
        </form>
      </div>
    </div>
  )
}
