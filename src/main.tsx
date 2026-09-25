import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// App renders AuthProvider (and everything else) itself. With WorkOS the
// browser holds no tokens, so there is no provider to mount here: the session
// is a server-owned cookie the BFF reads, and login is a route the SPA links
// to (/api/auth/start) rather than an SDK flow.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
