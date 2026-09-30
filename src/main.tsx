import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initApptics } from './lib/apptics'
import { RootErrorBoundary } from './components/ErrorBoundary'

// Staging-only Apptics trial: boots crash capture before any app code can
// throw. A no-op unless the token env is present (src/lib/apptics.ts).
initApptics()

// App renders AuthProvider (and everything else) itself. With WorkOS the
// browser holds no tokens, so there is no provider to mount here: the session
// is a server-owned cookie the BFF reads, and login is a route the SPA links
// to (/api/auth/start) rather than an SDK flow.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The last resort: a throw in the providers themselves white-screened the
        device before this existed. Plain HTML, a reload button, nothing that
        could throw again — see src/components/ErrorBoundary.tsx. */}
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
