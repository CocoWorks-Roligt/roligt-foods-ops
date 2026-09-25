import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  open: boolean
  onClose: () => void
  onSave: () => void
  saveLabel?: string
  /** The confirm button's class — `btn btn-danger` for destructive confirms. */
  saveClass?: string
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
  saveClass = 'btn btn-primary',
  readOnly = false,
  saveDisabled = false,
  footerLeft,
  children,
}: ModalProps) {
  // The backdrop deliberately does not close the dialog. Every form here is one an
  // operator fills in over a minute or two, and a stray click on the dimmed area used
  // to throw the whole thing away without a word. Escape, Cancel and the × still close it.
  const backdrop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A dropdown open on top of the dialog takes the key first — both the
      // select and the batch autocomplete close themselves on Escape. Without
      // this check, dismissing one threw away the half-filled form behind it.
      if (document.querySelector('.ui-select-list, .autocomplete-list')) return
      // With dialogs stacked — a record link opened from inside another dialog —
      // Escape belongs to the top one only.
      const stacked = Array.from(document.querySelectorAll('.modal-backdrop'))
      if (stacked.length > 1 && stacked[stacked.length - 1] !== backdrop.current) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" ref={backdrop}>
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
                className={saveClass}
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
