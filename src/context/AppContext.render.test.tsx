// @vitest-environment happy-dom
/**
 * Render-level characterization of AppProvider: the mirror-first boot (step 2
 * of docs/perf-audit-2026-09-25.md) and a measured re-render count for a
 * representative save (step 3 — the number the context-split decision was
 * waiting on). Mounts the real provider and the real Vendors register with a
 * faked dbApi, so what is counted is the actual component tree React commits.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp, useSaveStatus } from './AppContext'
import { AuthProvider } from './AuthContext'
import { ToastProvider } from './ToastContext'
import { Vendors } from '../pages/Vendors'
import { clearLocal, writeLocal } from '../lib/localDb'
import { seed } from '../data/seed'
import type { AppState, Vendor } from '../types'

const dbApi = vi.hoisted(() => ({
  fetchDb: vi.fn(),
  fetchRevision: vi.fn(),
  saveDb: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
}))
vi.mock('../lib/dbApi', () => dbApi)
vi.mock('../lib/authSession', () => ({
  fetchSession: vi.fn(async () => ({ user: { email: 'qa@roligt.local' } })),
}))

const VENDOR: Vendor = {
  id: 'V-0001',
  name: 'Kumar Farms',
  vendorTypeId: 'VT-FARMER',
  phone: '98',
  area: 'Hosur',
  payment: 'Cash',
  status: 'Active',
}

/** A plant with exactly one vendor — enough for the register to render a row. */
function plant(): Partial<AppState> {
  return { ...seed, vendors: [VENDOR] }
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>
        <AppProvider>{children}</AppProvider>
      </AuthProvider>
    </ToastProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  // vitest runs without globals here, so testing-library's auto-cleanup never
  // registers — without this, the previous test's tree stays in the document.
  cleanup()
  clearLocal()
  vi.clearAllMocks()
  dbApi.fetchRevision.mockResolvedValue(1)
})

describe('AppProvider boot', () => {
  it('paints from the device mirror before the server answers', async () => {
    writeLocal({ state: plant() as AppState, dirty: false, revision: 1 })
    const server = deferred<{ state: Partial<AppState> | null; revision: number }>()
    dbApi.fetchDb.mockReturnValue(server.promise)
    render(
      <Providers>
        <Vendors />
      </Providers>,
    )
    // No gate: the mirror row is on screen while the snapshot is still in flight.
    expect(screen.getByText('Kumar Farms')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Loading…')

    await act(async () => {
      server.resolve({ state: plant(), revision: 1 })
    })
    expect(screen.getByText('Kumar Farms')).toBeTruthy()
  })

  it('keeps the Loading gate on a first run (no mirror) until the snapshot lands', async () => {
    const server = deferred<{ state: Partial<AppState> | null; revision: number }>()
    dbApi.fetchDb.mockReturnValue(server.promise)
    render(
      <Providers>
        <Vendors />
      </Providers>,
    )
    expect(screen.queryByText('Kumar Farms')).toBeNull()
    expect(document.body.textContent).toContain('Loading…')

    await act(async () => {
      server.resolve({ state: plant(), revision: 1 })
    })
    expect(screen.getByText('Kumar Farms')).toBeTruthy()
  })
})

describe('AppProvider re-render cost of a save', () => {
  it('a vendor edit re-renders the mounted consumers a bounded number of times', async () => {
    dbApi.fetchDb.mockResolvedValue({ state: plant(), revision: 1, permissions: [] })
    dbApi.saveDb.mockResolvedValue({ ok: true, revision: 2 })

    let appRenders = 0
    let statusRenders = 0
    let update: ReturnType<typeof useApp>['updateVendor'] | null = null
    function ProbeApp() {
      appRenders += 1
      const app = useApp()
      update = app.updateVendor
      return null
    }
    function ProbeStatus() {
      statusRenders += 1
      useSaveStatus()
      return null
    }

    // Note on method: Profiler.onRender never fires for this update (React 19
    // does not report a context-driven re-render to a Profiler above the
    // consumers), so the cost is measured as wall-clock across the act() that
    // flushes the save's render+commit, plus render-count probes in the tree.
    render(
      <Providers>
        <Vendors />
        <ProbeApp />
        <ProbeStatus />
      </Providers>,
    )
    await waitFor(() => expect(screen.getByText('Kumar Farms')).toBeTruthy())
    // let the reconcile's clean-mirror write settle, then measure only the save
    await act(async () => {})
    appRenders = 0
    statusRenders = 0

    const t0 = performance.now()
    await act(async () => {
      update!('V-0001', { name: 'Kumar Farms', phone: '9999900000', area: 'Hosur', payment: 'Cash' })
    })
    const t1 = performance.now()
    // flush the saveDb round trip and whatever it flips
    await act(async () => {
      await Promise.resolve()
    })
    const t2 = performance.now()

    // The measured baseline for the audit (step 3 of the perf pass): one
    // representative masters save re-renders every mounted useApp consumer
    // (the register page + any siblings) once, in ~1 ms of JS on this machine.
    // Pinned loosely — the interesting number is printed, the assertions only
    // guard against a regression to per-flip re-render storms.
    // eslint-disable-next-line no-console
    console.log(
      `[render-measure] save: render+commit=${(t1 - t0).toFixed(2)}ms ` +
        `(+${(t2 - t1).toFixed(2)}ms save flush) ` +
        `useApp-consumer renders=${appRenders} saveStatus-consumer renders=${statusRenders}`,
    )
    expect(appRenders).toBeGreaterThanOrEqual(1) // the page subtree re-rendered
    expect(appRenders).toBeLessThanOrEqual(3) // once per commit, not per keystroke
    expect(statusRenders).toBeLessThanOrEqual(3)
    expect(screen.getByText('9999900000')).toBeTruthy() // the edit landed
  })
})
