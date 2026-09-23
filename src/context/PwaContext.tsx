import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { isIos, isStandalone, type BeforeInstallPromptEvent } from '../lib/pwa'

interface PwaContextValue {
  /** A newer build is cached and waiting to take over. */
  updateReady: boolean
  applyUpdate: () => void
  dismissUpdate: () => void
  /** The browser lost connectivity — reads and writes against the BFF will fail. */
  offline: boolean
  /** An install prompt is available (Chromium) or install instructions apply (iOS). */
  canInstall: boolean
  installed: boolean
  /** iOS cannot be prompted programmatically; the UI explains the Share-sheet route. */
  needsIosInstructions: boolean
  promptInstall: () => Promise<void>
}

const PwaContext = createContext<PwaContextValue | null>(null)

export function PwaProvider({ children }: { children: ReactNode }) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Deployments are infrequent; an hourly poll picks up a new build without
      // waiting for the operator to fully close the app.
      if (!registration) return
      setInterval(() => void registration.update(), 60 * 60 * 1000)
    },
  })

  const [offline, setOffline] = useState(() => !navigator.onLine)
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone)

  useEffect(() => {
    const goOnline = () => setOffline(false)
    const goOffline = () => setOffline(true)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setInstallEvent(null)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!installEvent) return
    await installEvent.prompt()
    const { outcome } = await installEvent.userChoice
    // The event is single-use either way.
    setInstallEvent(null)
    if (outcome === 'accepted') setInstalled(true)
  }, [installEvent])

  const needsIosInstructions = !installed && isIos() && !installEvent

  return (
    <PwaContext.Provider
      value={{
        updateReady: needRefresh,
        applyUpdate: () => void updateServiceWorker(true),
        dismissUpdate: () => setNeedRefresh(false),
        offline,
        canInstall: !installed && (Boolean(installEvent) || needsIosInstructions),
        installed,
        needsIosInstructions,
        promptInstall,
      }}
    >
      {children}
    </PwaContext.Provider>
  )
}

export function usePwa() {
  const ctx = useContext(PwaContext)
  if (!ctx) throw new Error('usePwa must be used within PwaProvider')
  return ctx
}
