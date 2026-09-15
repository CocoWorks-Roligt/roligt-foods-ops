import { isValidElement, type ReactNode } from 'react'
import { useApp } from '../context/AppContext'
import { historyOf } from '../lib/audit'
import { KIND_LABEL, linkedRecords } from '../lib/links'
import { fmtDate } from '../lib/utils'
import { ExportButtons } from './ExportButtons'
import { Modal } from './Modal'
import { RecordTrail } from './RecordTrail'

export interface DetailField {
  label: string
  value: ReactNode
  /** Span the full row — notes, addresses, long lists. */
  wide?: boolean
}

export interface DetailSection {
  title: string
  fields: DetailField[]
}

/**
 * Flattens what a field renders down to the text an export can carry. Values are
 * `ReactNode` because the view puts badges, lists and record links in them, so
 * anything that is not plain text has to be walked for the words inside it.
 */
function toText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).filter(Boolean).join(' ')
  if (isValidElement(node)) {
    const { children, doc, label } = node.props as {
      children?: ReactNode
      doc?: string
      label?: string
    }
    // A record link carries its number as a prop, not as children.
    if (children === undefined && (label || doc)) return String(label || doc)
    return toText(children)
  }
  return ''
}

/** `BAT-2026-0002 · Tender Coconut Water` becomes `bat-2026-0002-tender-coconut-water`. */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'record'

interface ExportRow {
  label: string
  value: string
}

/**
 * Field and value, and nothing else.
 *
 * There used to be a Section column in front of these, repeating the same handful of
 * headings down the sheet — "Receipt, Receipt, Receipt, Source, Source" — which is
 * noise in a two-column list of a single document's fields. The sections are still how
 * the record reads on screen; they are just not a column.
 */
const COLUMNS = [
  { header: 'Field', value: (r: ExportRow) => r.label },
  { header: 'Value', value: (r: ExportRow) => r.value },
]

/**
 * Read-only record view. Every document page uses the same shape so a GRN, a dispatch
 * and a batch all read alike, and each one exports on its own, field for field. This
 * is the only export left in the app: the list exports that sat in every page header
 * were a second, parallel way of reading the same screen, and every one of them had to
 * be kept in step with the table beside it.
 */
export function DetailView({
  open,
  title,
  sections,
  onClose,
  exportName,
  record,
}: {
  open: boolean
  title: string
  sections: DetailSection[]
  onClose: () => void
  /** File name stem. Defaults to the record title. */
  exportName?: string
  /**
   * The record on show. Given it, the view adds what the record came from and what it
   * went into — each a link to open — and the record's own audit history, so every
   * document reads as one step in a chain rather than a page of its own.
   */
  record?: string
}) {
  const { state } = useApp()

  const rows: ExportRow[] = sections.flatMap((section) =>
    section.fields.map((f) => ({ label: f.label, value: toText(f.value) })),
  )
  if (record && open) {
    const linked = linkedRecords(state, record)
    for (const [heading, refs] of [
      ['Came from', linked.cameFrom],
      ['Went into', linked.wentInto],
    ] as const) {
      for (const r of refs) rows.push({ label: `${heading} · ${KIND_LABEL[r.kind]}`, value: r.id })
    }
    for (const a of historyOf(state, record)) {
      rows.push({ label: `${fmtDate(a.time)} · ${a.role}`, value: `${a.action} — ${a.details}` })
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      readOnly
      onClose={onClose}
      onSave={onClose}
      footerLeft={
        <ExportButtons
          name={exportName || slug(title)}
          title={title}
          subtitle="Full record"
          columns={COLUMNS}
          rows={rows}
        />
      }
    >
      {sections.map((section) => (
        <div className="detail-section" key={section.title}>
          <h4>{section.title}</h4>
          <div className="detail-grid">
            {section.fields.map((f) => (
              <div className={`detail-item${f.wide ? ' wide' : ''}`} key={f.label}>
                <span className="detail-label">{f.label}</span>
                <span className="detail-value">
                  {f.value === '' || f.value === null || f.value === undefined ? '—' : f.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {record && open ? <RecordTrail record={record} /> : null}
    </Modal>
  )
}
