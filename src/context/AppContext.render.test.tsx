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
import { diffState } from '../lib/sync'
import { migrateState } from '../lib/migrate'
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
  return migrateState({ vendors: [VENDOR] })
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
  sessionStorage.clear()
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

describe('AppProvider offline push', () => {
  /**
   * The P0, end to end. A device comes back online holding a receipt it posted
   * with no signal; while it was away a colleague saved a new vendor. The push
   * this device makes must be diffed against the base it recorded when it went
   * dirty — diffing against the fresh server instead made every row the device
   * had not touched look already-present, and the push then deleted the
   * colleague's vendor (and everybody else's work) wholesale.
   */
  it('pushes offline work against the recorded base, not the fresh server — no deletions', async () => {
    const base = plant() // what this device last knew the database held
    const local = {
      ...plant(),
      grns: [{ id: 'GRN-2026-0001', date: '2026-09-28', status: 'Posted' }] as unknown as AppState['grns'],
    }
    const colleague = { ...VENDOR, id: 'V-0002', name: 'Colleague Farms' }
    const freshServer = { ...plant(), vendors: [...(plant().vendors ?? []), colleague] }
    writeLocal({ state: local as AppState, dirty: true, revision: '1', base: base as AppState })
    dbApi.fetchDb.mockResolvedValue({ state: freshServer, revision: '2', permissions: [] })
    dbApi.saveDb.mockResolvedValue({ ok: true, revision: '3:x' })

    render(
      <Providers>
        <Vendors />
      </Providers>,
    )
    await waitFor(() => expect(dbApi.saveDb).toHaveBeenCalled())
    const [next, prev] = dbApi.saveDb.mock.calls[0] as [AppState, AppState | null]

    // the push is diffed against the recorded base — one vendor in it, the
    // colleague's row nowhere near it
    expect(prev && 'vendors' in prev ? prev.vendors : []).toHaveLength(1)

    // and through the real engine: what this push carries is one receipt and no
    // deletion of any kind — while the same save diffed against the fresh server
    // (the old wiring) would have removed the colleague's vendor
    const changes = diffState(prev, next)
    expect(changes.tables.every((t) => !t.remove.length)).toBe(true)
    expect(changes.tables.find((t) => t.table === 'grns')?.upsert).toHaveLength(1)
    const oldWiring = diffState(freshServer as AppState, local as AppState)
    expect(oldWiring.tables.find((t) => t.table === 'vendors')?.remove).toContain('V-0002')
  })

  it("adopts a dirty tab's spill even after a clean tab overwrote the shared key", async () => {
    // The two-tab clobber, end to end. Tab A posts a receipt with no signal (a
    // dirty write, which lives on ITS spill); tab B, clean, then mirrors the
    // older plant over the shared key. Boot must adopt A's work from the spill
    // fold — the shared copy is a view of the server and never overrules it.
    const base = plant()
    const local = {
      ...plant(),
      grns: [{ id: 'GRN-2026-0001', date: '2026-09-28', status: 'Posted' }] as unknown as AppState['grns'],
    }
    sessionStorage.setItem('roligt_foods_ops_tab', 'tabA')
    writeLocal({ state: local as AppState, dirty: true, revision: '1', base: base as AppState })
    sessionStorage.setItem('roligt_foods_ops_tab', 'tabB')
    writeLocal({ state: plant() as AppState, dirty: false, revision: '2' })

    dbApi.fetchDb.mockResolvedValue({ state: plant(), revision: '2', permissions: [] })
    dbApi.saveDb.mockResolvedValue({ ok: true, revision: '3:x' })

    render(
      <Providers>
        <Vendors />
      </Providers>,
    )
    await waitFor(() => expect(dbApi.saveDb).toHaveBeenCalled())
    const [next, prev] = dbApi.saveDb.mock.calls[0] as [AppState, AppState | null]
    // the spill's receipt was adopted and pushed — not lost to tab B's mirror
    expect(next.grns.some((g) => g.id === 'GRN-2026-0001')).toBe(true)
    expect(prev && 'grns' in prev ? (prev.grns ?? []).length : 0).toBe(0)
  })
})
