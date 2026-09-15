import { Fragment, useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useSaveStatus } from '../context/AppContext'
import { useAuth } from '../context/AuthContext'
import { PAGES } from '../lib/utils'
import type { ViewId } from '../types'
import {
  CloseIcon,
  DashboardIcon,
  MenuIcon,
  ProcurementIcon,
  ProductionIcon,
  QualityIcon,
} from './NavIcons'
import { InstallButton, OfflineBar } from './PwaPrompts'
import { Toast } from './Toast'

interface NavItem {
  id: ViewId
  path: string
  label: string
  /** Sub-heading printed above this item, when it starts a group inside the list. */
  group?: string
}

const OPS: NavItem[] = [
  { id: 'dashboard', path: '/', label: 'Dashboard' },
  { id: 'procurement', path: '/procurement', label: 'Procurement' },
  // The order is the order the work happens in. Quality Control gates everything a
  // batch produces, so it belongs beside the two stages that produce it — reaching it
  // used to mean jumping back up the list mid-run.
  { id: 'production', path: '/production', label: 'Production', group: 'Production' },
  { id: 'quality', path: '/quality', label: 'Quality Control' },
  { id: 'packing', path: '/packing', label: 'Packing', group: 'After production' },
  { id: 'orders', path: '/orders', label: 'Orders' },
  { id: 'dispatch', path: '/dispatch', label: 'Dispatch' },
  { id: 'inventory', path: '/inventory', label: 'Inventory', group: 'Stock' },
  { id: 'packing-materials', path: '/packing-materials', label: 'Packing Materials' },
  { id: 'stock-issues', path: '/stock-issues', label: 'Stock Issues' },
  { id: 'storage', path: '/storage', label: 'Storage' },
  { id: 'stickers', path: '/stickers', label: 'Stickers' },
  { id: 'traceability', path: '/traceability', label: 'Traceability', group: 'Records' },
  { id: 'reports', path: '/reports', label: 'Lab Reports' },
  { id: 'audit', path: '/audit', label: 'Audit Log' },
]

/**
 * Admin only. These are the screens that rewrite what everything else is measured
 * against — the item masters, the tolerances, the document numbering, and the button
 * that clears records from a date. An operator receiving a load does not need them,
 * and an accidental edit here is felt by every document posted afterwards.
 */
const MASTERS: NavItem[] = [
  { id: 'vendors', path: '/vendors', label: 'Suppliers' },
  { id: 'customers', path: '/customers', label: 'Customers' },
  { id: 'purchase-products', path: '/purchase-products', label: 'Products & Materials' },
  { id: 'test-parameters', path: '/test-parameters', label: 'Test Parameters' },
  { id: 'settings', path: '/settings', label: 'Settings' },
]

/** The four screens an operator lives in, surfaced in thumb reach on phones. */
const BOTTOM_NAV: (NavItem & { Icon: ComponentType<{ className?: string }> })[] = [
  { id: 'dashboard', path: '/', label: 'Dashboard', Icon: DashboardIcon },
  { id: 'procurement', path: '/procurement', label: 'Procure', Icon: ProcurementIcon },
  { id: 'production', path: '/production', label: 'Produce', Icon: ProductionIcon },
  { id: 'quality', path: '/quality', label: 'Quality', Icon: QualityIcon },
]

/**
 * Whether this device's work has actually reached the database.
 *
 * "Data is saved to Supabase" was printed here unconditionally, which was a promise
 * the app could not keep: with no signal, nothing was being saved anywhere and the
 * one toast that said so had already been and gone. This reads the real state.
 */
function SaveIndicator() {
  const saveStatus = useSaveStatus()
  if (saveStatus.offline) {
    return <span>Offline — changes are held on this device until you reconnect.</span>
  }
  if (saveStatus.dirty) return <span>Saving…</span>
  return <span>All changes saved.</span>
}

function isActive(pathname: string, path: string) {
  if (path === '/') return pathname === '/'
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { session, signOut, isAdmin } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerCloseRef = useRef<HTMLButtonElement>(null)

  const view = (location.pathname.split('/').filter(Boolean)[0] || 'dashboard') as ViewId
  const [title, subtitle] = PAGES[view] || PAGES.dashboard
  const email = session?.user?.email || 'Admin'

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  // A tap on any nav item navigates and the drawer should get out of the way.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    // Stop the page behind the drawer from scrolling under the operator's finger.
    document.body.classList.add('drawer-open')
    drawerCloseRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('drawer-open')
    }
  }, [drawerOpen])

  const go = (path: string) => navigate(path)

  const renderNav = (items: NavItem[]) => (
    <div className="nav">
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.group ? <div className="nav-group">{item.group}</div> : null}
          <button
            type="button"
            className={isActive(location.pathname, item.path) ? 'active' : ''}
            aria-current={isActive(location.pathname, item.path) ? 'page' : undefined}
            onClick={() => go(item.path)}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )

  const bottomNavActive = BOTTOM_NAV.some((item) => isActive(location.pathname, item.path))

  return (
    <div className="app">
      {/* Mobile-only app bar. The desktop equivalent is .topbar inside <main>. */}
      <header className="mobile-appbar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Open navigation menu"
          aria-expanded={drawerOpen}
          aria-controls="app-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <MenuIcon />
        </button>
        <div className="mobile-appbar-title">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <InstallButton className="btn btn-chip" />
      </header>

      <div
        className={`drawer-scrim${drawerOpen ? ' open' : ''}`}
        onClick={closeDrawer}
        aria-hidden="true"
      />

      <aside
        id="app-drawer"
        className={`sidebar${drawerOpen ? ' open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="brand">
          <div className="mark">R</div>
          <div>
            <h1>Roligt Foods</h1>
            <small>Operations Control</small>
          </div>
          <button
            ref={drawerCloseRef}
            type="button"
            className="icon-btn drawer-close"
            aria-label="Close navigation menu"
            onClick={closeDrawer}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="nav-title">Operations</div>
        {renderNav(OPS)}

        {isAdmin ? (
          <>
            <div className="nav-title">Masters</div>
            {renderNav(MASTERS)}
          </>
        ) : null}

        <div className="sidebar-footer">
          <div className="small" style={{ color: '#c9d5ca' }}>
            Signed in as {email}
            {isAdmin ? ' (admin)' : ''}. <SaveIndicator />
          </div>
          <div className="sidebar-footer-actions">
            <InstallButton className="btn btn-light" />
            <button className="btn btn-light" type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <div className="topbar-actions">
            <InstallButton />
            <div className="pill">{email}</div>
            <button className="btn btn-light" type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <OfflineBar />
        <div className="content">
          <Outlet />
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Quick navigation">
        {BOTTOM_NAV.map(({ id, path, label, Icon }) => {
          const active = isActive(location.pathname, path)
          return (
            <button
              key={id}
              type="button"
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
              onClick={() => go(path)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          )
        })}
        <button
          type="button"
          className={!bottomNavActive ? 'active' : ''}
          aria-label="Open navigation menu"
          aria-expanded={drawerOpen}
          aria-controls="app-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <MenuIcon />
          <span>More</span>
        </button>
      </nav>

      <Toast />
    </div>
  )
}
