import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { KIND_LABEL, docHref, docRef } from '../lib/links'

/**
 * A record number you can follow.
 *
 * Opens the record on its own page with its View dialog up — a batch number on a QC
 * card opens the batch, a lot on a batch opens the goods receipt behind it. A number the
 * plant has no record of stays plain text, rather than a link that goes nowhere.
 *
 * `doc` is also what a record's export reads when it flattens a view to text.
 */
export function DocLink({ doc, label }: { doc: string | undefined; label?: string }) {
  const { state } = useApp()
  const navigate = useNavigate()
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
        navigate(docHref(ref))
      }}
    >
      {label || doc}
    </button>
  )
}
