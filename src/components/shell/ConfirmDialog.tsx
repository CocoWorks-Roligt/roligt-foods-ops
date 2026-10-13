import { Modal } from '../Modal'

/**
 * The one confirmation pattern (overhaul §6) as a thin adapter over the app's
 * Modal, which already owns the cancel/confirm footer: an action that cannot
 * be undone, or that the operator should consciously choose, asks once — with
 * the verb the button performs, never a generic "OK". `danger` swaps the
 * confirm button to the failure colour; `busy` holds it shut mid-flight.
 */
export interface ConfirmDialogProps {
  open: boolean
  title: string
  /** What will happen, in plain language — one sentence, the consequence named. */
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
  busy?: boolean
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      onSave={onConfirm}
      title={title}
      saveLabel={busy ? 'Working…' : confirmLabel}
      saveClass={danger ? 'btn btn-danger' : 'btn btn-primary'}
      saveDisabled={busy}
    >
      <p>{body}</p>
    </Modal>
  )
}
