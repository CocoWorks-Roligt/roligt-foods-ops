import { statusClass, statusLabel } from '../lib/utils'

/** Renders a stored status in the one word the app uses for it everywhere. */
export function StatusBadge({ value }: { value: string }) {
  return <span className={`status ${statusClass(value)}`}>{statusLabel(value)}</span>
}
