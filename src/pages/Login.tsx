import { useState } from 'react'
import { OfflineBar } from '../components/PwaPrompts'
import { Select } from '../components/Select'
import { useAuth } from '../context/AuthContext'
import { WORKOS_CONFIGURED, getDevRole, setDevRole } from '../lib/authMode'
import type { Role } from '../types'

export function Login() {
  const { signIn, session } = useAuth()
  const [error, setError] = useState('')
  const [devRole, setPickedRole] = useState<Role>(getDevRole)

  const submit = async () => {
    setError('')
    const message = await signIn()
    if (message) setError(message)
  }

  return (
    <div className="login-page">
      <div className="login-offline">
        <OfflineBar />
      </div>
      <div className="login-shell">
        <section className="login-stage">
          {/* Concentric coconut-water rings — the one decorative moment the
             page gets, hairline husk strokes that stay behind the type. */}
          <svg className="login-rings" aria-hidden="true" viewBox="0 0 200 200" focusable="false">
            <circle cx="100" cy="100" r="96" />
            <circle cx="100" cy="100" r="72" />
            <circle cx="100" cy="100" r="48" />
            <circle cx="100" cy="100" r="24" />
          </svg>
          <div className="login-brand">
            <div className="mark login-mark">R</div>
            <div>
              <span className="login-eyebrow">Roligt Foods</span>
              <h1 className="login-wordmark">
                Operations
                <br />
                Control
              </h1>
            </div>
          </div>
          <p className="login-lede">
            One ledger from the farm gate to the dispatch truck — procurement, extraction,
            melange, packing and quality, posted as they happen.
          </p>
          <div className="login-flow" aria-label="Production flow">
            <span>Receiving</span>
            <span>Extraction</span>
            <span>Blend</span>
            <span>Packing</span>
            <span>Dispatch</span>
          </div>
          <ul className="login-points">
            <li>
              <b>Offline-first.</b> The floor keeps working when the network drops; saves sync
              when it returns.
            </li>
            <li>
              <b>One ledger.</b> Every edit reverses its own lines — stock is never hand-corrected.
            </li>
            <li>
              <b>Traceable.</b> Any lot, back to its farm and forward to its truck.
            </li>
          </ul>
        </section>

        <section className="login-panel">
          <div className="card login-card">
            <div className="section-head">
              <div>
                <h3>Sign in</h3>
                <span>to continue to Operations Control</span>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              {WORKOS_CONFIGURED ? (
                <>
                  <button className="btn primary login-submit" type="submit">
                    Continue with email
                  </button>
                  <p className="login-help">
                    Accounts are provisioned by an administrator — Roles &amp; Users decides
                    every page you can open.
                  </p>
                </>
              ) : (
                <>
                  <div className="field" style={{ marginBottom: 14 }}>
                    <label>Dev session — role</label>
                    <Select
                      value={devRole}
                      onChange={(e) => {
                        const next = e.target.value as Role
                        setDevRole(next) // persisted; applied by the context at sign-in
                        setPickedRole(next)
                      }}
                    >
                      <option value="Admin">Admin</option>
                      <option value="Operator">Operator</option>
                      <option value="QualityTester">Quality Tester</option>
                      <option value="Npd">NPD</option>
                    </Select>
                    <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                      Dev fallback active (no WorkOS env). You will sign in as{' '}
                      {session?.user.email ?? 'dev@roligt.local'}.
                    </span>
                  </div>
                  <button className="btn primary login-submit" type="submit">
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
          <p className="login-foot">
            CocoWorks · A Roligt Foods company
            {WORKOS_CONFIGURED ? '' : ' · dev fallback session'}
          </p>
        </section>
      </div>
    </div>
  )
}
