import { useState } from 'react'
import { usePwa } from '../context/PwaContext'

/** Slim bar pinned under the header whenever the device drops off the network. */
export function OfflineBar() {
  const { offline } = usePwa()
  if (!offline) return null
  return (
    <div className="offline-bar" role="status">
      <span className="offline-dot" aria-hidden="true" />
      <span>
        You are offline. Saved screens still open, but new entries will not reach the server
        until the connection returns.
      </span>
    </div>
  )
}

/** Bottom-anchored card offering the newly cached build. */
export function UpdatePrompt() {
  const { updateReady, applyUpdate, dismissUpdate } = usePwa()
  if (!updateReady) return null
  return (
    <div className="pwa-prompt" role="alertdialog" aria-label="Update available">
      <div className="pwa-prompt-text">
        <b>New version available</b>
        <span className="small">Reload to pick up the latest operations build.</span>
      </div>
      <div className="pwa-prompt-actions">
        <button className="btn btn-light" type="button" onClick={dismissUpdate}>
          Later
        </button>
        <button className="btn btn-primary" type="button" onClick={applyUpdate}>
          Reload
        </button>
      </div>
    </div>
  )
}

/** Install entry point. Renders nothing once the app runs from the home screen. */
export function InstallButton({ className = 'btn btn-light' }: { className?: string }) {
  const { canInstall, needsIosInstructions, promptInstall } = usePwa()
  const [showIosHelp, setShowIosHelp] = useState(false)

  if (!canInstall) return null

  if (needsIosInstructions) {
    return (
      <span className="install-wrap">
        <button
          className={className}
          type="button"
          aria-expanded={showIosHelp}
          onClick={() => setShowIosHelp((v) => !v)}
        >
          Install app
        </button>
        {showIosHelp ? (
          <p className="install-hint" role="note">
            Tap the Share button in Safari, then choose <b>Add to Home Screen</b>.
          </p>
        ) : null}
      </span>
    )
  }

  return (
    <button className={className} type="button" onClick={() => void promptInstall()}>
      Install app
    </button>
  )
}
