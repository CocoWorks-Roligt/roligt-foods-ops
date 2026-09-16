import { Fragment } from 'react'
import { Link, useParams } from 'react-router-dom'
import logo from '../assets/logo.png'
import { useApp } from '../context/AppContext'
import { categoryDef, categoryTitle, isLegacyTest } from '../lib/qcCategories'
import {
  CRITICAL_BELOW,
  DEFAULT_MINOR_SCORE,
  DEFAULT_PASS_SCORE,
  SCORING_GUIDE,
  scoreSensory,
  weightedScore,
} from '../lib/sensory'
import { fmtDate, fmtQty } from '../lib/utils'
import type { LabReport } from '../types'

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

  const def = categoryDef(state, report.category)
  const scored = def?.format === 'scored' || !!report.scores

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

      {scored ? (
        <SensorySheet report={report} title={def?.title || 'Sensory Evaluation'} />
      ) : (
        <div className="report-sheet">
          <div className="report-header">
            <img src={logo} className="report-logo" alt="Roligt Foods" />
            <div>
              <div className="report-title">TEST REPORT</div>
              <div className="report-subtitle">{categoryTitle(state, report.category)}</div>
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
            <div className="report-signature-name">{report.labTechnician || '—'}</div>
            <div>
              {def?.signatory ||
                (isLegacyTest(report.category) ? 'Authorised Signatory - Biology' : 'Authorised Signatory')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** A sensory evaluation, laid out the way the plant's sheet reads. */
function SensorySheet({ report, title }: { report: LabReport; title: string }) {
  const scores = report.scores || []
  const summary = scoreSensory(scores, report)
  const pass = report.passScore ?? DEFAULT_PASS_SCORE
  const minor = report.minorScore ?? DEFAULT_MINOR_SCORE
  const checks = report.productChecks
  /** How many rows each section heading spans, keyed by the row it starts on. */
  const spans = new Map<number, number>()
  scores.forEach((s, i) => {
    if (i && scores[i - 1].section === s.section) {
      let start = i
      while (start && scores[start - 1].section === s.section) start--
      spans.set(start, (spans.get(start) || 1) + 1)
    } else spans.set(i, 1)
  })

  return (
    <div className="report-sheet">
      <div className="report-header">
        <img src={logo} className="report-logo" alt="Roligt Foods" />
        <div>
          <div className="report-title">{title.toUpperCase()}</div>
          <div className="report-subtitle">Roligt Foods – CocoWorks</div>
        </div>
      </div>

      <div className="report-top-row">
        <div>
          <b>Report No.:</b> {report.id}
        </div>
        <div>
          <b>Date:</b> {fmtDate(report.sampleDate)}
        </div>
      </div>

      <table className="report-details-table">
        <tbody>
          <tr>
            <td>Product Category</td>
            <td>{report.productGroup || '—'}</td>
          </tr>
          <tr>
            <td>Product / Variant</td>
            <td>{report.sampleName || '—'}</td>
          </tr>
          <tr>
            <td>Batch / Trial No.</td>
            <td>{report.batchLotDetails || '—'}</td>
          </tr>
          <tr>
            <td>Evaluator</td>
            <td>{report.labTechnician || '—'}</td>
          </tr>
          <tr>
            <td>Serving Temperature (°C)</td>
            <td>{report.servingTemp || '—'}</td>
          </tr>
          <tr>
            <td>Storage Condition</td>
            <td>{report.storageCondition || '—'}</td>
          </tr>
        </tbody>
      </table>

      <div className="report-results-title">ATTRIBUTES</div>
      <table className="report-sensory-table">
        <colgroup>
          <col style={{ width: '12%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '9%' }} />
          <col style={{ width: '16.5%' }} />
          <col style={{ width: '16.5%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Section</th>
            <th>Attribute</th>
            <th className="num">Weight %</th>
            <th className="num">Score (1–5)</th>
            <th className="num">Weighted</th>
            <th className="num">Critical?</th>
            <th>Observation / Defect</th>
            <th>Action Required</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => {
            const weighted = weightedScore(s)
            return (
              <tr key={`${s.section}-${s.name}-${i}`}>
                {spans.has(i) ? <td rowSpan={spans.get(i)}>{s.section}</td> : null}
                <td>{s.name}</td>
                <td className="num">{fmtQty(s.weight)}</td>
                <td className="num">{s.score ?? '—'}</td>
                <td className="num">{weighted == null ? '—' : fmtQty(weighted)}</td>
                <td className="num">{s.critical ? 'Yes' : 'No'}</td>
                <td>{s.observation || ''}</td>
                <td>{s.action || ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="report-results-title">SENSORY SUMMARY</div>
      <table className="report-details-table">
        <tbody>
          <tr>
            <td>Weighted Sensory Score / 100</td>
            <td>{summary.score == null ? '—' : fmtQty(summary.score)}</td>
          </tr>
          <tr>
            <td>Average Raw Score / 5</td>
            <td>{summary.average == null ? '—' : fmtQty(summary.average)}</td>
          </tr>
          <tr>
            <td>Critical Attributes Scored Below {CRITICAL_BELOW}</td>
            <td>{summary.criticalBelow}</td>
          </tr>
          <tr>
            <td>Critical Attributes Scored {CRITICAL_BELOW}</td>
            <td>{summary.criticalAt}</td>
          </tr>
          <tr>
            <td>Missing Scores</td>
            <td>{summary.missing}</td>
          </tr>
          <tr>
            <td>Final Decision</td>
            <td>
              <b className="report-decision">{summary.decision}</b>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="small" style={{ marginTop: 6 }}>
        Pass at {pass}/100 · pass with minor modification from {minor} · below {minor}, hold for R&amp;D
        review · any critical attribute below {CRITICAL_BELOW}, reject / hold.
      </div>

      {checks ? (
        <>
          <div className="report-results-title">PRODUCT-SPECIFIC CHECKPOINTS — {checks.name.toUpperCase()}</div>
          <table className="report-details-table">
            <tbody>
              <tr>
                <td>Critical Checkpoints</td>
                <td>{checks.checkpoints || '—'}</td>
              </tr>
              <tr>
                <td>Defects to Watch</td>
                <td>{checks.defects || '—'}</td>
              </tr>
              <tr>
                <td>R&amp;D Focus</td>
                <td>{checks.focus || '—'}</td>
              </tr>
            </tbody>
          </table>
        </>
      ) : null}

      <div className="report-results-title">R&amp;D / QA COMMENTS &amp; CORRECTIVE ACTION</div>
      <div className="report-comments">{report.comments || '—'}</div>

      <div className="report-results-title">SCORING GUIDE</div>
      <table className="report-sensory-table">
        <colgroup>
          <col style={{ width: '10%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '70%' }} />
        </colgroup>
        <thead>
          <tr>
            <th className="num">Score</th>
            <th>Meaning</th>
            <th>QA/QC Interpretation</th>
          </tr>
        </thead>
        <tbody>
          {SCORING_GUIDE.map((g) => (
            <Fragment key={g.score}>
              <tr>
                <td className="num">{g.score}</td>
                <td>{g.meaning}</td>
                <td>{g.reading}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      <div className="report-end-of-report">** END OF REPORT **</div>

      <div className="report-signature">
        <div className="report-signature-line" />
        <div className="report-signature-name">{report.labTechnician || '—'}</div>
        <div>Evaluator</div>
      </div>
    </div>
  )
}
