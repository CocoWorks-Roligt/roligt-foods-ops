/**
 * Two different situations look identical in a table: nothing has been created yet,
 * and a filter matched nothing. Saying "No batches" when six exist behind a search
 * term reads as data loss, so the two are told apart — and the filtered one offers
 * the way out.
 */
export function EmptyState({
  filtered,
  empty,
  onClear,
}: {
  /** True when a search box or filter is narrowing the list right now. */
  filtered: boolean
  /** What to say when the list is genuinely empty. */
  empty: string
  onClear: () => void
}) {
  if (!filtered) return <span className="empty-text">{empty}</span>
  return (
    <span className="empty-text">
      Nothing matches the current search or filter.{' '}
      <button type="button" className="link-btn" onClick={onClear}>
        Clear it
      </button>
    </span>
  )
}
