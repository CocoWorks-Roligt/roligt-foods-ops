// @vitest-environment happy-dom
/**
 * Adapter tests — the init-script contract Zoho's documented web integration
 * demands: the console snippet's init URL is injected as-is (settings come from
 * that script, never from us — a hand-staged partial `_defaultoptions` crashes
 * the SDK inside its own eval), and boot only resolves once the SDK the init
 * script appends has defined `window.apptics`, with crash capture armed.
 * appendChild is stubbed to a no-op: happy-dom would otherwise try to fetch the
 * script src itself and fire its own error event inside the test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootAppticsSdk, sdkSetUser, sdkTrackEvent, sdkTrackScreen } from './appticsSdk'

/** Captures the script tag bootAppticsSdk creates without letting happy-dom load it. */
function stubAppend(): () => HTMLScriptElement {
  const spy = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => node as HTMLScriptElement)
  return () => {
    const el = spy.mock.calls[0]?.[0]
    if (!el) throw new Error('init script was never injected')
    return el as HTMLScriptElement
  }
}

function fakeApptics() {
  return {
    trackEvent: vi.fn(),
    trackScreen: vi.fn(),
    setUser: vi.fn(),
    enableGlobalErrorHandler: vi.fn(),
  }
}

describe('bootAppticsSdk', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete window.apptics
  })

  it('injects the console snippet init URL and never stages settings itself', async () => {
    const injected = stubAppend()
    const booted = bootAppticsSdk('tok-1', '60089706541', '984000000004006', 'IN')
    const el = injected()
    expect(el.src).toBe(
      'https://apptics.zoho.in/sdk/web/v1/60089706541/984000000004006/init?aaID=tok-1',
    )
    expect(el.crossOrigin).toBe('anonymous')
    // The init script owns appticssettings; us touching it is the bug that
    // shipped this trial dead, so the adapter must leave it alone.
    expect((window as { appticssettings?: unknown }).appticssettings).toBeUndefined()

    // The init script's job, simulated: it appends the SDK, which then loads
    // and defines window.apptics.
    const api = fakeApptics()
    window.apptics = api
    el.dispatchEvent(new Event('load'))
    await booted
    expect(api.enableGlobalErrorHandler).toHaveBeenCalledWith(true)
  })

  it('routes to the default portal when no DC is given', async () => {
    const injected = stubAppend()
    const booted = bootAppticsSdk('tok-2', 'zso', 'proj')
    expect(injected().src).toBe('https://apptics.zoho.com/sdk/web/v1/zso/proj/init?aaID=tok-2')
    window.apptics = fakeApptics()
    injected().dispatchEvent(new Event('load'))
    await booted
  })

  it('rejects when the init script fails to load', async () => {
    const injected = stubAppend()
    const booted = bootAppticsSdk('tok-3', 'zso', 'proj')
    injected().dispatchEvent(new Event('error'))
    await expect(booted).rejects.toThrow('apptics sdk failed to load')
  })

  it('rejects when the SDK the init script pulls in never appears', async () => {
    vi.useFakeTimers()
    try {
      const injected = stubAppend()
      const booted = bootAppticsSdk('tok-4', 'zso', 'proj')
      injected().dispatchEvent(new Event('load'))
      const assertion = expect(booted).rejects.toThrow('apptics sdk failed to load')
      await vi.advanceTimersByTimeAsync(10_500)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sdk forwards', () => {
  afterEach(() => {
    delete window.apptics
  })

  it('forwards to window.apptics when present', () => {
    const api = fakeApptics()
    window.apptics = api
    sdkTrackEvent('db_commit', { ok: true })
    sdkTrackScreen('/quality')
    sdkSetUser('qa@roligt.local')
    expect(api.trackEvent).toHaveBeenCalledWith('db_commit', undefined, { ok: true })
    expect(api.trackScreen).toHaveBeenCalledWith('/quality')
    expect(api.setUser).toHaveBeenCalledWith('qa@roligt.local')
  })

  it('stays silent when the SDK never loaded', () => {
    expect(() => {
      sdkTrackEvent('db_commit')
      sdkTrackScreen('/quality')
      sdkSetUser('qa@roligt.local')
      sdkSetUser(null)
    }).not.toThrow()
  })
})
