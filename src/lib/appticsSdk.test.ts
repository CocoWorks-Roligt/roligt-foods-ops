// @vitest-environment happy-dom
/**
 * Adapter tests — the script-injection contract the SDK's loader form demands:
 * settings staged before the tag is appended, crash capture armed on load.
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
    if (!el) throw new Error('SDK script was never injected')
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
    delete window.appticssettings
  })

  it('stages appticssettings before appending, then arms crash capture on load', async () => {
    const injected = stubAppend()
    const booted = bootAppticsSdk('tok-1', 'IN')
    // Settings exist by append time — the SDK reads them while the script
    // runs, not after.
    expect(window.appticssettings?._defaultoptions).toEqual({ aaID: 'tok-1', DC: 'IN' })

    // The classic script defines window.apptics synchronously when it loads.
    const api = fakeApptics()
    window.apptics = api
    injected().dispatchEvent(new Event('load'))
    await booted
    expect(api.enableGlobalErrorHandler).toHaveBeenCalledWith(true)
  })

  it('omits DC entirely when not given', async () => {
    const injected = stubAppend()
    const booted = bootAppticsSdk('tok-2')
    expect(window.appticssettings?._defaultoptions).toEqual({ aaID: 'tok-2' })
    window.apptics = fakeApptics()
    injected().dispatchEvent(new Event('load'))
    await booted
  })

  it('rejects when the script fails to load', async () => {
    const injected = stubAppend()
    const booted = bootAppticsSdk('tok-3')
    injected().dispatchEvent(new Event('error'))
    await expect(booted).rejects.toThrow('apptics sdk failed to load')
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
