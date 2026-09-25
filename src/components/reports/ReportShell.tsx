import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ExportButtons } from '../ExportButtons'
import { useSaveStatus } from '../../context/AppContext'
import type { ExportColumn } from '../../lib/export'
import type { ReportDef } from '../../lib/reports/index.ts'

/**
 * What every live report is dressed in: the title, the method note that says
 * how its figures are counted (a report whose arithmetic is invisible is a
 * report nobody can defend), the range it covers and whether that range is
 * what the database currently holds, and the export pair.
 *
 * The shell never derives anything — it is chrome around a derivation.
 */

/** Whether the figures above are what the database holds right now. */
function SyncNote() {
  const { offline, dirty } = useSaveStatus()
  const text = offline
    ? 'Offline — reading this device’s last sync'
    : dirty
      ? 'Saving — includes this device’s unsaved changes'
      : 'In sync with the database'
  return <span className={`sync-note ${offline ? 'off' : dirty ? 'busy' : 'ok'}`}>{text}</span>
}

interface Props<T> {
  def: ReportDef
  /** What the shell prints as the covered range — a window label or "as of now". */
  range: string
  /** The rows the export pair downloads; the buttons hide when it is empty. */
  exportName?: string
  columns?: ExportColumn<T>[]
  rows?: T[]
  /** Extra controls (the range picker, a grouping switch) above the report. */
  controls?: ReactNode
  children: ReactNode
}

export function ReportShell<T>({ def, range, exportName, columns, rows, controls, children }: Props<T>) {
  const [showMethod, setShowMethod] = useState(false)

  return (
    <div className="card live-report">
      <div className="section-head">
        <div>
          <h3>{def.title}</h3>
          <span>{def.method}</span>
          <div className="report-meta">
            <span className="pill report-range">{range}</span>
            <SyncNote />
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowMethod((s) => !s)}
              aria-expanded={showMethod}
            >
              {showMethod ? 'Hide how this is counted' : 'How this is counted'}
            </button>
          </div>
          {showMethod && (
            <p className="method-note">
              Derived from {def.sources.toLowerCase()}, live off the records — nothing here is stored,
              so it can never drift from the registers it reads. A change of range re-derives it.
            </p>
          )}
        </div>
        <div className="section-head-actions">
          <Link className="btn btn-light" to="/reports/live">
            All reports
          </Link>
          {exportName && columns && rows ? (
            <ExportButtons name={exportName} title={def.title} subtitle={range} columns={columns} rows={rows} />
          ) : null}
        </div>
      </div>
      {controls ? <div className="report-controls">{controls}</div> : null}
      {children}
    </div>
  )
}
