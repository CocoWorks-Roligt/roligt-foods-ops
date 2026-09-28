/**
 * Facade tests. `APPTICS_CONFIGURED` is a module-level constant over
 * `import.meta.env`, so each case stubs the env and re-imports fresh — a real
 * token in a developer's .env.local must never leak one case into another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  boot: vi.fn(() => Promise.resolve()),
  trackEvent: vi.fn(),
  trackScreen: vi.fn(),
  setUser: vi.fn(),
}))

vi.mock('./appticsSdk', () => ({
  bootAppticsSdk: sdk.boot,
  sdkTrackEvent: sdk.trackEvent,
  sdkTrackScreen: sdk.trackScreen,
  sdkSetUser: sdk.setUser,
}))

describe('apptics facade', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // DC defaults to empty for every case (tests that want one override it):
    // vitest loads .env.local into import.meta.env, so a developer's real
    // VITE_APPTICS_DC would otherwise leak into the cases that pin boot args.
    vi.stubEnv('VITE_APPTICS_DC', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('no-ops every call when unconfigured', async () => {
    vi.stubEnv('VITE_APPTICS_APP_TOKEN', '')
    const a = await import('./apptics')
    expect(a.APPTICS_CONFIGURED).toBe(false)
    a.initApptics()
    a.trackPageView('/production')
    a.trackEvent('db_commit', { ok: true })
    a.setAppticsUser('dev@roligt.local')
    await Promise.resolve()
    expect(sdk.boot).not.toHaveBeenCalled()
    expect(sdk.trackScreen).not.toHaveBeenCalled()
    expect(sdk.trackEvent).not.toHaveBeenCalled()
    expect(sdk.setUser).not.toHaveBeenCalled()
  })

  it('boots exactly once and forwards calls once ready', async () => {
    vi.stubEnv('VITE_APPTICS_APP_TOKEN', 'tok-1')
    const a = await import('./apptics')
    // Fired before the (async) boot resolves: buffered, not dropped.
    a.trackPageView('/procurement')
    a.setAppticsUser('qa@roligt.local')
    a.initApptics()
    a.initApptics() // idempotent
    await vi.waitFor(() => expect(sdk.trackScreen).toHaveBeenCalled())
    expect(sdk.boot).toHaveBeenCalledTimes(1)
    expect(sdk.boot).toHaveBeenCalledWith('tok-1', '')
    expect(sdk.trackScreen).toHaveBeenCalledWith('/procurement')
    expect(sdk.setUser).toHaveBeenCalledWith('qa@roligt.local')

    // After ready, calls go straight through.
    a.trackEvent('db_commit', { ok: true, reason: 'ok', tables: 'grns', rows: 3 })
    expect(sdk.trackEvent).toHaveBeenCalledWith('db_commit', {
      ok: true,
      reason: 'ok',
      tables: 'grns',
      rows: 3,
    })
  })

  it('passes the data-center code through when set', async () => {
    vi.stubEnv('VITE_APPTICS_APP_TOKEN', 'tok-2')
    vi.stubEnv('VITE_APPTICS_DC', 'IN')
    const a = await import('./apptics')
    a.initApptics()
    await vi.waitFor(() => expect(sdk.boot).toHaveBeenCalled())
    expect(sdk.boot).toHaveBeenCalledWith('tok-2', 'IN')
  })

  it('drops the buffer silently when the script fails to load', async () => {
    vi.stubEnv('VITE_APPTICS_APP_TOKEN', 'tok-3')
    sdk.boot.mockRejectedValueOnce(new Error('apptics sdk failed to load'))
    const a = await import('./apptics')
    a.trackPageView('/quality')
    a.initApptics()
    await vi.waitFor(() => expect(sdk.boot).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(sdk.trackScreen).not.toHaveBeenCalled()
    // And it stays quiet for the rest of the session rather than retrying.
    a.trackEvent('connectivity', { state: 'offline' })
    await Promise.resolve()
    expect(sdk.trackEvent).not.toHaveBeenCalled()
    expect(sdk.boot).toHaveBeenCalledTimes(1)
  })
})
