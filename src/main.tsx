import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { KindeProvider } from '@kinde-oss/kinde-auth-react'
import './index.css'
import App from './App.tsx'
import { KindeBridge } from './components/KindeBridge'
import { KINDE_CONFIGURED } from './lib/authMode'

// App renders AuthProvider (and everything else) itself; main only decides
// whether that tree grows inside a Kinde provider or stands alone.
const tree = (
  <StrictMode>
    <App />
  </StrictMode>
)

// KINDE_CONFIGURED guarantees domain and clientId here; the redirect and logout
// URIs fall back to the origin the Kinde quickstart asks you to register.
createRoot(document.getElementById('root')!).render(
  KINDE_CONFIGURED ? (
    <KindeProvider
      clientId={import.meta.env.VITE_KINDE_CLIENT_ID ?? ''}
      domain={import.meta.env.VITE_KINDE_DOMAIN ?? ''}
      redirectUri={import.meta.env.VITE_KINDE_REDIRECT_URI ?? 'http://localhost:3000'}
      logoutUri={import.meta.env.VITE_KINDE_LOGOUT_URI ?? 'http://localhost:3000'}
    >
      <KindeBridge />
      {tree}
    </KindeProvider>
  ) : (
    tree
  ),
)
