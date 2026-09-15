import { useState } from 'react'
import { exportCsv, type ExportColumn } from '../lib/export'
import { exportPdf } from '../lib/pdf'

interface Props<T> {
  /** File name stem shared by both downloads. */
  name: string
  /** Heading printed on the PDF. Falls back to the file name stem. */
  title?: string
  /** One line under the PDF heading: what was filtered, searched or selected. */
  subtitle?: string
  columns: ExportColumn<T>[]
  rows: T[]
}

/**
 * The CSV and PDF pair that sits in every section head. Both exports take the rows
 * the page is already showing, so what downloads is what the operator can see —
 * never a fresh unfiltered dump of the table.
 */
export function ExportButtons<T>({ name, title, subtitle, columns, rows }: Props<T>) {
  // jsPDF is fetched on first use, so the button has to say something while it lands.
  const [busy, setBusy] = useState(false)

  const savePdf = async () => {
    setBusy(true)
    try {
      await exportPdf({ name, title: title || name, subtitle, columns, rows })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="export-actions">
      <button
        className="btn btn-light"
        type="button"
        onClick={() => exportCsv(name, columns, rows)}
        disabled={!rows.length}
      >
        Export CSV
      </button>
      <button
        className="btn btn-light"
        type="button"
        onClick={() => void savePdf()}
        disabled={!rows.length || busy}
      >
        {busy ? 'Preparing…' : 'Export PDF'}
      </button>
    </div>
  )
}
