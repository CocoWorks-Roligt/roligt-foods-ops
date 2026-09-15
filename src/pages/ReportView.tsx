import { Link, useParams } from 'react-router-dom'
import logo from '../assets/logo.png'
import { useApp } from '../context/AppContext'
import { categoryTitle } from '../lib/qcCategories'
import { fmtDate } from '../lib/utils'

export function ReportView() {
  const { state } = useApp()
  const { id } = useParams()
  const report = state.labReports.find((r) => r.id === id)

  if (!report) {
    return (
      <div className="card">
        <div className="empty">Report {id} not found.</div>
        <Link className="btn btn-light" to="/reports" style={{ marginTop: 12 }}>
          Back to Reports
        </Link>
      </div>
    )
  }

  return (
    <div className="report-page">
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Link className="btn btn-light" to="/reports">
          ← Back to Reports
        </Link>
        <button className="btn btn-primary" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>

      <div className="report-sheet">
        <div className="report-header">
          <img src={logo} className="report-logo" alt="Roligt Foods" />
          <div>
            <div className="report-title">TEST REPORT</div>
            <div className="report-subtitle">{categoryTitle(report.category)}</div>
          </div>
        </div>

        <div className="report-top-row">
          <div>
            <b>Test Report No.:</b> {report.id}
          </div>
          <div>
            <b>Issue Date:</b> {fmtDate(report.issueDate)}
          </div>
        </div>
        <div className="report-row">
          <b>{report.customerName}</b>
          <div className="small">{report.customerAddress}</div>
        </div>
        <div className="report-row">
          <b>Lab Technician:</b> {report.labTechnician || '—'}
        </div>

        <div className="report-results-title">DETAILS</div>
        <table className="report-details-table">
          <tbody>
            <tr>
              <td>Sample Qty</td>
              <td>
                {/* A blank quantity printed as "0 mL" on a formal lab report, which reads
                    as a measurement rather than as a field nobody filled in. */}
                {report.sampleQtyAmount
                  ? `${report.sampleQtyAmount} ${report.sampleQtyUnit}`
                  : '—'}
              </td>
            </tr>
            <tr>
              <td>Sample Name</td>
              <td>{report.sampleName}</td>
            </tr>
            <tr>
              <td>Batch/Lot/Other Details</td>
              <td>{report.batchLotDetails || '—'}</td>
            </tr>
            <tr>
              <td>Date</td>
              <td>{fmtDate(report.sampleDate)}</td>
            </tr>
          </tbody>
        </table>

        <div className="report-results-title">TEST RESULTS</div>
        <table className="report-results-table">
          <thead>
            <tr>
              <th>S. No</th>
              <th>Test Parameter</th>
              <th>Test Method</th>
              <th>Unit</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {report.results.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td>{i + 1}</td>
                <td>{r.name}</td>
                <td>{r.method}</td>
                <td>{r.unit}</td>
                <td>{r.result || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="report-end-of-report">** END OF REPORT **</div>

        <div className="report-signature">
          <div className="report-signature-line" />
          <div className="report-signature-name">Mr. {report.labTechnician || '—'}</div>
          <div>Authorised Signatory - Biology</div>
        </div>
      </div>
    </div>
  )
}
