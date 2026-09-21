import { useApp } from '../context/AppContext'
import { KIND_LABEL, docRef } from '../lib/links'
import { useDocViewer } from './docViewerContext'

/**
 * A record number you can follow — without going anywhere.
 *
 * Clicking opens the record in a dialog over the page you are on, so the search,
 * filters and scroll you were in the middle of survive. The record's own page still
 * has the fuller View for when you went there on purpose. A number the plant has no
 * record of stays plain text, rather than a link that goes nowhere.
 *
 * `doc` is also what a record's export reads when it flattens a view to text.
 */
export function DocLink({ doc, label }: { doc: string | undefined; label?: string }) {
  const { state } = useApp()
  const { openDoc } = useDocViewer()
  const ref = docRef(state, doc)
  if (!ref) return <>{label || doc || '—'}</>
  return (
    <button
      type="button"
      className="link-button doc-link"
      title={`Open ${KIND_LABEL[ref.kind].toLowerCase()} ${ref.id}`}
      onClick={(e) => {
        // Links sit inside table rows and cards that may have their own click.
        e.stopPropagation()
        openDoc(ref.id)
      }}
    >
      {label || doc}
    </button>
  )
}

