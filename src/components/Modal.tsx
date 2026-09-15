import { useEffect, type ReactNode } from 'react'

interface ModalProps {
  title: string
  open: boolean
  onClose: () => void
  onSave: () => void
  saveLabel?: string
  /** Read-only view: no Save, and the only button closes the dialog. */
  readOnly?: boolean
  /** Holds Save shut until the dialog's own precondition is met — a typed
   *  confirmation phrase, mainly. Cancel and the × stay live. */
  saveDisabled?: boolean
  /** Actions pinned to the left of the footer — record-level exports, mainly. */
  footerLeft?: ReactNode
  children: ReactNode
}

export function Modal({
  title,
  open,
  onClose,
  onSave,
  saveLabel = 'Save',
  readOnly = false,
  saveDisabled = false,
  footerLeft,
  children,
}: ModalProps) {
  // The backdrop deliberately does not close the dialog. Every form here is one an
  // operator fills in over a minute or two, and a stray click on the dimmed area used
  // to throw the whole thing away without a word. Escape, Cancel and the × still close it.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A dropdown open on top of the dialog takes the key first. Without this,
      // dismissing a dropdown threw away the whole half-filled form behind it.
      if (document.querySelector('.ui-select-list')) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="close" onClick={onClose} type="button">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className={`modal-foot${footerLeft ? ' split' : ''}`}>
          {footerLeft ? <div className="modal-foot-left">{footerLeft}</div> : null}
          {readOnly ? (
            <button className="btn btn-primary" type="button" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="btn btn-light" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={saveDisabled}
                onClick={onSave}
              >
                {saveLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
