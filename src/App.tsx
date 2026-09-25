import { lazy, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { DocViewerProvider } from './components/DocViewer'
import { Layout } from './components/Layout'
import { UpdatePrompt } from './components/PwaPrompts'
import { AppProvider } from './context/AppContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { PwaProvider } from './context/PwaContext'
import { ToastProvider } from './context/ToastContext'
import { canViewPage, firstAllowedPath } from './lib/pages.ts'
import { useSessionPermissions } from './lib/sessionPermissions'
import type { ViewId } from './types'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'

/**
 * Every route except the dashboard ships as a chunk of its own, fetched on first
 * navigation — the service worker precaches all of them (vite.config.ts
 * globPatterns), so once it installs, offline behavior is byte-for-byte what it
 * was. The dashboard stays in the shell bundle because it is the landing route:
 * the first paint after login should never wait on a chunk. Pages export named
 * components, so each lazy() re-wraps its named export — the same idiom
 * Traceability already uses for the trace graph.
 */
const Audit = lazy(() => import('./pages/Audit').then((m) => ({ default: m.Audit })))
const Customers = lazy(() => import('./pages/Customers').then((m) => ({ default: m.Customers })))
const DispatchPage = lazy(() => import('./pages/Dispatch').then((m) => ({ default: m.DispatchPage })))
const Inventory = lazy(() => import('./pages/Inventory').then((m) => ({ default: m.Inventory })))
const Orders = lazy(() => import('./pages/Orders').then((m) => ({ default: m.Orders })))
const Packing = lazy(() => import('./pages/Packing').then((m) => ({ default: m.Packing })))
const PackingMaterials = lazy(() => import('./pages/PackingMaterials').then((m) => ({ default: m.PackingMaterials })))
const Procurement = lazy(() => import('./pages/Procurement').then((m) => ({ default: m.Procurement })))
const ProductionPlanning = lazy(() => import('./pages/ProductionPlanning').then((m) => ({ default: m.ProductionPlanning })))
const Roster = lazy(() => import('./pages/Roster').then((m) => ({ default: m.Roster })))
const Production = lazy(() => import('./pages/Production').then((m) => ({ default: m.Production })))
const PurchaseProducts = lazy(() => import('./pages/PurchaseProducts').then((m) => ({ default: m.PurchaseProducts })))
const Quality = lazy(() => import('./pages/Quality').then((m) => ({ default: m.Quality })))
const Reports = lazy(() => import('./pages/Reports').then((m) => ({ default: m.Reports })))
const LiveReports = lazy(() => import('./pages/LiveReports').then((m) => ({ default: m.LiveReports })))
const ReportView = lazy(() => import('./pages/ReportView').then((m) => ({ default: m.ReportView })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const StockIssues = lazy(() => import('./pages/StockIssues').then((m) => ({ default: m.StockIssues })))
const Storage = lazy(() => import('./pages/Storage').then((m) => ({ default: m.Storage })))
const Stickers = lazy(() => import('./pages/Stickers').then((m) => ({ default: m.Stickers })))
const ControlSamples = lazy(() => import('./pages/ControlSamples').then((m) => ({ default: m.ControlSamples })))
const TestParameters = lazy(() => import('./pages/TestParameters').then((m) => ({ default: m.TestParameters })))
const Traceability = lazy(() => import('./pages/Traceability').then((m) => ({ default: m.Traceability })))
const Vendors = lazy(() => import('./pages/Vendors').then((m) => ({ default: m.Vendors })))
const UsersAdmin = lazy(() => import('./pages/admin/Users').then((m) => ({ default: m.Users })))
const RolesAdmin = lazy(() => import('./pages/admin/Roles').then((m) => ({ default: m.Roles })))

/**
 * A gated screen, decided by the one visibility rule in src/lib/pages.ts — the
 * same `allowedPages` Layout's nav and redirect consume, so the route and the
 * nav can never disagree.
 *
 * Hiding the nav links is not a gate — the paths are still typeable, and a bookmark
 * outlives a role change. A caller who cannot see the page is sent to the first
 * page they hold (the dashboard for the unscoped everyone of the day's work).
 */
function RequirePage({ viewId, children }: { viewId: ViewId; children: ReactNode }) {
  const permissions = useSessionPermissions()
  if (canViewPage(permissions, viewId)) return <>{children}</>
  return <Navigate to={firstAllowedPath(permissions) ?? '/'} replace />
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
        <DocViewerProvider>
          <Routes>
          <Route element={<Layout />}>
            {/* Every route runs through the page rule — the day's work too: a
                scoped caller's stale link bounces here, before the page mounts
                and fetches, rather than after Layout unmounts it. */}
            <Route index element={<RequirePage viewId="dashboard"><Dashboard /></RequirePage>} />
            <Route path="procurement" element={<RequirePage viewId="procurement"><Procurement /></RequirePage>} />
            <Route path="roster" element={<RequirePage viewId="roster"><Roster /></RequirePage>} />
            <Route path="production-planning" element={<RequirePage viewId="production-planning"><ProductionPlanning /></RequirePage>} />
            <Route path="production" element={<RequirePage viewId="production"><Production /></RequirePage>} />
            <Route path="packing" element={<RequirePage viewId="packing"><Packing /></RequirePage>} />
            <Route path="quality" element={<RequirePage viewId="quality"><Quality /></RequirePage>} />
            <Route path="control-samples" element={<RequirePage viewId="control-samples"><ControlSamples /></RequirePage>} />
            {/* Static path, ranked above reports/:id — /reports/live is the
                derived-reports page, not a lab report document. */}
            <Route path="reports/live" element={<RequirePage viewId="live-reports"><LiveReports /></RequirePage>} />
            <Route path="reports" element={<RequirePage viewId="reports"><Reports /></RequirePage>} />
            <Route path="reports/:id" element={<RequirePage viewId="reports"><ReportView /></RequirePage>} />
            <Route path="orders" element={<RequirePage viewId="orders"><Orders /></RequirePage>} />
            <Route path="dispatch" element={<RequirePage viewId="dispatch"><DispatchPage /></RequirePage>} />
            <Route path="inventory" element={<RequirePage viewId="inventory"><Inventory /></RequirePage>} />
            <Route path="stock-issues" element={<RequirePage viewId="stock-issues"><StockIssues /></RequirePage>} />
            <Route path="packing-materials" element={<RequirePage viewId="packing-materials"><PackingMaterials /></RequirePage>} />
            <Route path="storage" element={<RequirePage viewId="storage"><Storage /></RequirePage>} />
            <Route path="stickers" element={<RequirePage viewId="stickers"><Stickers /></RequirePage>} />
            <Route path="traceability" element={<RequirePage viewId="traceability"><Traceability /></RequirePage>} />
            <Route path="vendors" element={<RequirePage viewId="vendors"><Vendors /></RequirePage>} />
            <Route path="customers" element={<RequirePage viewId="customers"><Customers /></RequirePage>} />
            <Route path="purchase-products" element={<RequirePage viewId="purchase-products"><PurchaseProducts /></RequirePage>} />
            <Route path="test-parameters" element={<RequirePage viewId="test-parameters"><TestParameters /></RequirePage>} />
            <Route path="settings" element={<RequirePage viewId="settings"><Settings /></RequirePage>} />
            <Route path="audit" element={<RequirePage viewId="audit"><Audit /></RequirePage>} />
            <Route path="admin/users" element={<RequirePage viewId="admin-users"><UsersAdmin /></RequirePage>} />
            <Route path="admin/roles" element={<RequirePage viewId="admin-roles"><RolesAdmin /></RequirePage>} />
            <Route path="melanges" element={<Navigate to="/production?stage=melange" replace />} />
            <Route path="masters" element={<Navigate to="/vendors" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </DocViewerProvider>
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
