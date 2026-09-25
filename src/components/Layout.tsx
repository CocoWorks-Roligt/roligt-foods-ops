import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useSaveStatus } from '../context/AppContext'
import { useAuth } from '../context/AuthContext'
import { allowedPages, pageScope, PAGE_CATALOG, type PageRow } from '../lib/pages.ts'
import { useSessionPermissions } from '../lib/sessionPermissions'
import { PAGES } from '../lib/utils'
import type { ViewId } from '../types'
import {
  CloseIcon,
  DashboardIcon,
  FlaskIcon,
  MenuIcon,
  PageIcon,
  ProcurementIcon,
  ProductionIcon,
  QualityIcon,
  ReportIcon,
  SlidersIcon,
} from './NavIcons'
import { InstallButton, OfflineBar } from './PwaPrompts'
import { Toast } from './Toast'

/**
 * Icons for the thumb bar — the SPA-side companion to the page catalog (pages.ts
 * is isomorphic, so the marks live here). A page with no bespoke icon takes the
 * generic one; nobody needs twenty bespoke glyphs to tell their four pages apart.
 */
const PAGE_ICONS: Partial<Record<ViewId, ComponentType<{ className?: string }>>> = {
  dashboard: DashboardIcon,
  procurement: ProcurementIcon,
  production: ProductionIcon,
  quality: QualityIcon,
  'control-samples': FlaskIcon,
  reports: ReportIcon,
  'test-parameters': SlidersIcon,
}

const pageIcon = (id: ViewId) => PAGE_ICONS[id] ?? PageIcon

/** The four screens an operator lives in, surfaced in thumb reach on phones. */
const navRow = (id: ViewId) => PAGE_CATALOG.find((p) => p.id === id)!
const BOTTOM_NAV: (PageRow & { Icon: ComponentType<{ className?: string }> })[] = [
  { ...navRow('dashboard'), Icon: pageIcon('dashboard') },
  { ...navRow('procurement'), Icon: pageIcon('procurement'), label: 'Procure' },
  { ...navRow('production'), Icon: pageIcon('production'), label: 'Produce' },
  { ...navRow('quality'), Icon: pageIcon('quality'), label: 'Quality' },
]

/**
 * Whether this device's work has actually reached the database.
 *
 * "Data is saved to the server" was printed here unconditionally, which was a promise
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

const NAV_PATHS = PAGE_CATALOG.map((p) => p.path)

function isActive(pathname: string, path: string) {
  if (path === '/') return pathname === '/'
  // A deeper page that is itself a nav item (Live Reports lives under Lab
  // Reports' URL) highlights its own item, not every prefix of its path.
  const shadowed = NAV_PATHS.some(
    (p) =>
      p !== path &&
      p.startsWith(`${path}/`) &&
      (pathname === p || pathname.startsWith(`${p}/`)),
  )
  if (shadowed) return false
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { session, signOut, isAdmin } = useAuth()
  const permissions = useSessionPermissions()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerCloseRef = useRef<HTMLButtonElement>(null)

  // /reports/live is its own page one level under Lab Reports; resolving by the
  // first path segment alone would hang the lab page's title on it. The admin
  // screens live two segments deep for the same reason — their own titles, not
  // a shared "admin" one.
  const segments = location.pathname.split('/').filter(Boolean)
  const view = (segments[0] === 'reports' && segments[1] === 'live'
    ? 'live-reports'
    : segments[0] === 'admin' && (segments[1] === 'users' || segments[1] === 'roles')
      ? `admin-${segments[1]}`
      : segments[0] || 'dashboard') as ViewId
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

  // Page scoping, decided once by the catalog (src/lib/pages.ts): the default
  // caller gets the whole open day's work; a caller holding any page permission
  // gets exactly the pages they hold plus whatever their manage permissions
  // open. The scope arrives with the live permission set, so a role change
  // lands on the next poll and this list (and the redirect below) follow
  // without a reload.
  const scope = pageScope(permissions)
  const allowed = allowedPages(permissions)
  const openItems = allowed.filter((p) => p.tier === 'open')
  const mastersItems = allowed.filter((p) => p.tier === 'masters' || p.tier === 'settings')
  const adminItems = allowed.filter((p) => p.tier === 'admin')

  // The gate on everything the nav did not name: a scoped caller deep-linked
  // (or bookmarked before their role changed) into a page they no longer hold
  // lands on their first page instead. Hiding the links is not the gate.
  if (scope && allowed.length === 0) {
    return (
      <div className="page">
        <h2>No pages assigned</h2>
        <p className="muted">
          Your account holds no pages. Ask an administrator to tick the pages your role should
          open (Roles &amp; Permissions, under Administration).
        </p>
      </div>
    )
  }
  if (scope) {
    const onAllowed = allowed.some((p) => location.pathname === p.path || location.pathname.startsWith(`${p.path}/`))
    if (!onAllowed) return <Navigate to={allowed[0]!.path} replace />
  }

  const renderNav = (items: readonly PageRow[]) => (
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

  // The thumb bar mirrors what the caller lives in: an operator's four screens,
  // or a scoped caller's own pages (never more than the catalog's four).
  const bottomItems: (PageRow & { Icon: ComponentType<{ className?: string }> })[] = scope
    ? allowed.slice(0, 4).map((p) => ({ ...p, Icon: pageIcon(p.id) }))
    : BOTTOM_NAV
  const bottomNavActive = bottomItems.some((item) => isActive(location.pathname, item.path))

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
        {renderNav(openItems)}

        {mastersItems.length > 0 ? (
          <>
            <div className="nav-title">Masters</div>
            {renderNav(mastersItems)}
          </>
        ) : null}

        {adminItems.length > 0 ? (
          <>
            <div className="nav-title">Administration</div>
            {renderNav(adminItems)}
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
            <div className="pill">
              {email}
              {isAdmin ? ' (admin)' : ''}
            </div>
            <button className="btn btn-light" type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <OfflineBar />
        <div className="content">
          {/* Route chunks load on first navigation (see App.tsx); the boundary
              sits inside Layout so the nav, offline bar and header stay mounted
              while one lands. Same look as the boot gate in App.tsx. */}
          <Suspense
            fallback={
              <div className="empty" style={{ minHeight: '40vh', display: 'grid', placeItems: 'center' }}>
                Loading…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Quick navigation">
        {bottomItems.map(({ id, path, label, Icon }) => {
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
