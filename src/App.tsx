import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { UpdatePrompt } from './components/PwaPrompts'
import { AppProvider } from './context/AppContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { PwaProvider } from './context/PwaContext'
import { ToastProvider } from './context/ToastContext'
import { Audit } from './pages/Audit'
import { Customers } from './pages/Customers'
import { Dashboard } from './pages/Dashboard'
import { DispatchPage } from './pages/Dispatch'
import { Inventory } from './pages/Inventory'
import { Login } from './pages/Login'
import { Orders } from './pages/Orders'
import { Packing } from './pages/Packing'
import { PackingMaterials } from './pages/PackingMaterials'
import { Procurement } from './pages/Procurement'
import { Production } from './pages/Production'
import { PurchaseProducts } from './pages/PurchaseProducts'
import { Quality } from './pages/Quality'
import { Reports } from './pages/Reports'
import { ReportView } from './pages/ReportView'
import { Settings } from './pages/Settings'
import { StockIssues } from './pages/StockIssues'
import { Storage } from './pages/Storage'
import { Stickers } from './pages/Stickers'
import { TestParameters } from './pages/TestParameters'
import { Traceability } from './pages/Traceability'
import { Vendors } from './pages/Vendors'

/**
 * A master screen, for an admin only.
 *
 * Hiding the nav links is not a gate — the paths are still typeable, and a bookmark
 * outlives a role change. Anyone else is sent back to the dashboard.
 */
function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth()
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />
}

function AuthGate() {
  const { session, ready } = useAuth()

  if (!ready) {
    return (
      <div className="empty" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        Loading…
      </div>
    )
  }

  if (!session) return <Login />

  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="procurement" element={<Procurement />} />
            <Route path="production" element={<Production />} />
            <Route path="packing" element={<Packing />} />
            <Route path="quality" element={<Quality />} />
            <Route path="reports" element={<Reports />} />
            <Route path="reports/:id" element={<ReportView />} />
            <Route path="orders" element={<Orders />} />
            <Route path="dispatch" element={<DispatchPage />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="stock-issues" element={<StockIssues />} />
            <Route path="packing-materials" element={<PackingMaterials />} />
            <Route path="storage" element={<Storage />} />
            <Route path="stickers" element={<Stickers />} />
            <Route path="traceability" element={<Traceability />} />
            <Route path="vendors" element={<AdminOnly><Vendors /></AdminOnly>} />
            <Route path="customers" element={<AdminOnly><Customers /></AdminOnly>} />
            <Route path="purchase-products" element={<AdminOnly><PurchaseProducts /></AdminOnly>} />
            <Route path="test-parameters" element={<AdminOnly><TestParameters /></AdminOnly>} />
            <Route path="settings" element={<AdminOnly><Settings /></AdminOnly>} />
            <Route path="audit" element={<Audit />} />
            <Route path="melanges" element={<Navigate to="/production?stage=melange" replace />} />
            <Route path="masters" element={<Navigate to="/vendors" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  )
}

export default function App() {
  return (
    <PwaProvider>
      <ToastProvider>
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
        <UpdatePrompt />
      </ToastProvider>
    </PwaProvider>
  )
}
