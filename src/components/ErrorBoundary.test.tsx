// @vitest-environment happy-dom
/**
 * The white-screen pin: a page whose render throws is replaced by a card with
 * two ways out, the shell around it survives, and navigating away repairs the
 * app on its own — plus the last-resort boundary under createRoot, which owes
 * the device plain HTML even when every provider above it has died.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RootErrorBoundary, RouteErrorBoundary } from './ErrorBoundary'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../lib/apptics', () => ({ trackEvent }))

/** Throws while rendering — the bad row a page could not digest. */
function Boom({ always = false }: { always?: boolean }) {
  if (always || !recovered) throw new Error('cannot read qty of undefined')
  return <p>All good</p>
}
let recovered = false

function Home() {
  return (
    <div>
      <h2>Dashboard</h2>
      <nav>
        <a href="/boom">to the broken page</a>
      </nav>
    </div>
  )
}

/** The shape Layout mounts: one boundary around the routed content. */
function Shell() {
  return (
    <div className="app">
      <aside>Signed in as operator.</aside>
      <main>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/boom" element={<Boom always={alwaysThrows} />} />
          </Routes>
        </RouteErrorBoundary>
      </main>
    </div>
  )
}
let alwaysThrows = false

beforeEach(() => {
  recovered = false
  alwaysThrows = false
  trackEvent.mockClear()
})

afterEach(() => {
  cleanup()
  // React logs the caught error to console.error; vitest prints it as noise.
  vi.restoreAllMocks()
})

describe('RouteErrorBoundary', () => {
  it('a throwing page renders the card, and the shell around it survives', () => {
    render(
      <MemoryRouter initialEntries={['/boom']}>
        <Shell />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('This screen hit an error')).toBeTruthy()
    expect(screen.getByText(/cannot read qty of undefined/)).toBeTruthy()
    // the shell did not white-screen with it
    expect(screen.getByText('Signed in as operator.')).toBeTruthy()
    expect(screen.queryByText('Dashboard')).toBeNull()
    // and the throw was reported with the route it happened on
    expect(trackEvent).toHaveBeenCalledWith(
      'render_error',
      expect.objectContaining({ where: '/boom', message: 'cannot read qty of undefined' }),
    )
  })

  it('"Reload screen" re-renders the page — recovered, it paints', () => {
    render(
      <MemoryRouter initialEntries={['/boom']}>
        <Shell />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()

    recovered = true // the retried render now succeeds
    fireEvent.click(screen.getByRole('button', { name: 'Reload screen' }))
    expect(screen.getByText('All good')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"Go to Dashboard" navigates away, and the route key resets the boundary', () => {
    // alwaysThrows: the page would throw on every render it ever gets — the
    // card can only clear because navigating remounts the boundary fresh
    alwaysThrows = true
    render(
      <MemoryRouter initialEntries={['/boom']}>
        <Shell />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }))
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('RootErrorBoundary', () => {
  it('the last resort shows plain HTML with a reload button — no blank root', () => {
    render(
      <RootErrorBoundary>
        <Boom always />
      </RootErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('This screen could not be shown')).toBeTruthy()
    expect(screen.getByText(/cannot read qty of undefined/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    // reported with the window's pathname — it may have no router to ask
    expect(trackEvent).toHaveBeenCalledWith(
      'render_error',
      expect.objectContaining({ where: window.location.pathname, component: 'root' }),
    )
  })
})
