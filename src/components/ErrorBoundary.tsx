import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { trackEvent } from '../lib/apptics'

/**
 * Two boundaries, one per way a screen can die.
 *
 * Until these existed there was no ErrorBoundary anywhere in the tree: one row
 * a page's render could not digest white-screened the whole device, because a
 * throw above AuthGate unmounts everything — login chrome included — and the
 * only net was Apptics' script-level crash capture, which is staging-gated.
 * The route boundary (below, `RouteErrorBoundary`) keeps the shell alive: the
 * header, nav and save indicator stand, the broken page is replaced by a card
 * with two ways out, and navigating away resets it. The root boundary
 * (`RootErrorBoundary`) is the last resort under createRoot for a throw in the
 * providers themselves — plain HTML, no context, nothing that could throw again.
 */

interface BoundaryProps {
  /** Where the throw happened — the route for the payload's `where`. */
  where: string
  /** "Go to Dashboard" — a plain route change, supplied by the router-aware wrapper. */
  onGoHome?: () => void
  children: ReactNode
}

/** The card the route boundary shows in place of the page that threw. */
function ErrorCard({ error, onReset, onGoHome }: { error: Error; onReset: () => void; onGoHome?: () => void }) {
  return (
    <div className="empty" role="alert" style={{ minHeight: '40vh', display: 'grid', placeItems: 'center' }}>
      <div style={{ display: 'grid', gap: '12px', justifyItems: 'center', maxWidth: '46ch' }}>
        <h3 style={{ margin: 0 }}>This screen hit an error</h3>
        <p style={{ margin: 0, wordBreak: 'break-word' }}>
          {error.message || 'Something in this page failed to render.'} Other screens still work —
          your changes are unaffected.
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" className="btn btn-light" onClick={onReset}>
            Reload screen
          </button>
          {onGoHome ? (
            <button type="button" className="btn btn-light" onClick={onGoHome}>
              Go to Dashboard
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

class ErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Observability only — the facade is inert unless the trial is configured,
    // and the card below renders regardless of what happens here.
    trackEvent('render_error', {
      where: this.props.where,
      message: String(error.message || error).slice(0, 300),
      component: info.componentStack?.trim().split('\n')[0]?.slice(0, 200) ?? '',
    })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <ErrorCard
        error={this.state.error}
        onReset={() => this.setState({ error: null })}
        onGoHome={this.props.onGoHome}
      />
    )
  }
}

/**
 * The route boundary: keyed by pathname, so a navigation remounts it fresh —
 * leaving a broken page repairs the app without anyone pressing anything. The
 * key sits here rather than at the call site so no caller can forget it.
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <ErrorBoundary key={location.pathname} where={location.pathname} onGoHome={() => navigate('/')}>
      {children}
    </ErrorBoundary>
  )
}

/**
 * The last resort, mounted under createRoot around the whole app. It may be
 * rendering because providers died, so it touches no context at all: inline
 * styles, a real reload, the pathname read straight off the window.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    trackEvent('render_error', {
      where: typeof window === 'undefined' ? '' : window.location.pathname,
      message: String(error.message || error).slice(0, 300),
      component: 'root',
    })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '16px',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'grid', gap: '12px', justifyItems: 'center', maxWidth: '46ch' }}>
          <h1 style={{ fontSize: '1.25rem', margin: 0 }}>This screen could not be shown</h1>
          <p style={{ margin: 0, color: '#555' }}>
            {this.state.error.message || 'The app failed before it could start.'} Reload to
            continue.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '8px 16px', fontSize: '1rem', cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
