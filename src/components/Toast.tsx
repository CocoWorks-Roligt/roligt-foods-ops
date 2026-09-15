import { useToastMessage } from '../context/ToastContext'

export function Toast() {
  const toast = useToastMessage()
  if (!toast) return null
  return <div className="toast">{toast.message}</div>
}
