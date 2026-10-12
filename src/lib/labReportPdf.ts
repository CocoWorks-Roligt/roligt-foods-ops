/**
 * A generated lab report as a PDF — the file a QC record keeps when a report made in
 * the app is attached to it.
 *
 * Attaching used to file only a link to the report, so the QC record's evidence was
 * whatever the report said at the moment someone opened it, and the link opened
 * nothing anywhere a file was expected. Now the report is rendered here, on attach,
 * and the PDF goes to the file store like any uploaded lab report: what the record
 * holds is the report as it read when QA relied on it.
 *
 * The layout follows ReportView's two sheets — the lab certificate and the sensory
 * evaluation — in plain tables. jsPDF is loaded only when a report is rendered, so it
 * never weighs on the app's first load.
 */
import logo from '../assets/logo.png'
import { categoryDef, categoryTitle, isLegacyTest } from './qcCategories'
import {
  CRITICAL_BELOW,
  DEFAULT_MINOR_SCORE,
  DEFAULT_PASS_SCORE,
  SCORING_GUIDE,
  scoreSensory,
  weightedScore,
} from './sensory'
import { fmtDate, fmtQty } from './utils'
import { productionDateRows, productionDates } from './productionDates'
import type { AppState, LabReport } from '../types'

/**
 * The PDF's built-in fonts only carry the Latin-1 set. Anything else — an arrow, a
 * Devanagari name — would print as noise, so the common typographic marks are spelt
 * plainly and the rest become '?'.
 */
export function pdfText(value: unknown): string {
  return String(value ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?')
}

const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : pdfText(v))

async function logoDataUrl(): Promise<string | null> {
  try {
    const blob = await (await fetch(logo)).blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null // a report without its letterhead is still the report
  }
}

/** The file name a generated report is stored under. */
export const labReportFileName = (report: LabReport) => `${report.id}.pdf`

/** Renders `report` as the PDF a QC record keeps. */
export async function labReportPdf(
  state: Pick<AppState, 'config' | 'batches' | 'packingRuns'>,
  report: LabReport,
  options: { logo?: string | null } = {},
): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const left = 14
  const width = doc.internal.pageSize.getWidth() - left * 2
  const image = options.logo === undefined ? await logoDataUrl() : options.logo

  const def = categoryDef(state, report.category)
  const scored = def?.format === 'scored' || !!report.scores
  const title = scored ? (def?.title || 'Sensory Evaluation').toUpperCase() : 'TEST REPORT'
  const subtitle = scored ? 'Roligt Foods - CocoWorks' : categoryTitle(state, report.category)

  // letterhead
  let y = 14
  if (image) {
    try {
      doc.addImage(image, 'PNG', left, y, 28, 14)
    } catch {
      // an image the PDF cannot read is skipped, not fatal
    }
  }
  doc.setFont('helvetica', 'bold').setFontSize(16).text(pdfText(title), left + 34, y + 6)
  doc.setFont('helvetica', 'normal').setFontSize(10).text(pdfText(subtitle), left + 34, y + 12)
  y += 22
  doc.setFontSize(10)
  doc.text(`${scored ? 'Report No.' : 'Test Report No.'}: ${pdfText(report.id)}`, left, y)
  doc.text(`${scored ? 'Date' : 'Issue Date'}: ${pdfText(fmtDate(scored ? report.sampleDate : report.issueDate))}`, left + width, y, {
    align: 'right',
  })
  y += 4

  const batch = report.batchId || report.batchLotDetails
  // When the batch was made and packed, as it stood when the report was filed.
  const dates = report.batchId ? productionDateRows(productionDates(state, report.batchId)) : []
  /** Each table starts below the last — autoTable remembers where it ended. */
  const next = () => ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6
  const heading = (text: string) => {
    const at = next()
    doc.setFont('helvetica', 'bold').setFontSize(11).text(pdfText(text), left, at)
    doc.setFont('helvetica', 'normal').setFontSize(10)
    return at + 2
  }
  const pairs = (rows: [string, unknown][], startY: number) =>
    autoTable(doc, {
      startY,
      margin: { left, right: left },
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: { 0: { cellWidth: 60, fontStyle: 'bold' } },
      body: rows.map(([label, value]) => [pdfText(label), dash(value)]),
    })
  const grid = (head: string[], body: unknown[][], startY: number) =>
    autoTable(doc, {
      startY,
      margin: { left, right: left },
      theme: 'grid',
      styles: { fontSize: 8.5, cellPadding: 1.8 },
      headStyles: { fillColor: [235, 235, 235], textColor: 20 },
      head: [head.map(pdfText)],
      body: body.map((row) => row.map(dash)),
    })

  if (!scored) {
    pairs(
      [
        ['Customer', [report.customerName, report.customerAddress].filter(Boolean).join('\n')],
        ['Lab Technician', report.labTechnician],
      ],
      y + 4,
    )
    pairs(
      [
        ['Sample Qty', report.sampleQtyAmount ? `${report.sampleQtyAmount} ${report.sampleQtyUnit}` : ''],
        ['Sample Name', report.sampleName],
        ['Batch/Lot/Other Details', batch],
        ...dates,
        ['Date', fmtDate(report.sampleDate)],
      ],
      heading('DETAILS'),
    )
    grid(
      ['S. No', 'Test Parameter', 'Test Method', 'Unit', 'Result'],
      report.results.map((r, i) => [i + 1, r.name, r.method, r.unit, r.result]),
      heading('TEST RESULTS'),
    )
  } else {
    const scores = report.scores || []
    const summary = scoreSensory(scores, report)
    const pass = report.passScore ?? DEFAULT_PASS_SCORE
    const minor = report.minorScore ?? DEFAULT_MINOR_SCORE
    pairs(
      [
        ['Product Category', report.productGroup],
        ['Product / Variant', report.sampleName],
        ['Batch / Trial No.', batch],
        ...dates,
        ['Evaluator', report.labTechnician],
        ['Serving Temperature (°C)', report.servingTemp],
        ['Storage Condition', report.storageCondition],
      ],
      y + 4,
    )
    grid(
      ['Section', 'Attribute', 'Weight %', 'Score (1-5)', 'Weighted', 'Critical?', 'Observation / Defect', 'Action Required'],
      scores.map((s, i) => {
        const weighted = weightedScore(s)
        return [
          i && scores[i - 1].section === s.section ? '' : s.section,
          s.name,
          fmtQty(s.weight),
          s.score ?? '',
          weighted == null ? '' : fmtQty(weighted),
          s.critical ? 'Yes' : 'No',
          s.observation,
          s.action,
        ]
      }),
      heading('ATTRIBUTES'),
    )
    pairs(
      [
        ['Weighted Sensory Score / 100', summary.score == null ? '' : fmtQty(summary.score)],
        ['Average Raw Score / 5', summary.average == null ? '' : fmtQty(summary.average)],
        [`Critical Attributes Scored Below ${CRITICAL_BELOW}`, summary.criticalBelow],
        [`Critical Attributes Scored ${CRITICAL_BELOW}`, summary.criticalAt],
        ['Missing Scores', summary.missing],
        ['Final Decision', summary.decision],
      ],
      heading('SENSORY SUMMARY'),
    )
    doc
      .setFontSize(8)
      .text(
        pdfText(
          `Pass at ${pass}/100 · pass with minor modification from ${minor} · below ${minor}, hold for R&D review · any critical attribute below ${CRITICAL_BELOW}, reject / hold.`,
        ),
        left,
        next() - 2,
        { maxWidth: width },
      )
    doc.setFontSize(10)
    const checks = report.productChecks
    if (checks) {
      pairs(
        [
          ['Critical Checkpoints', checks.checkpoints],
          ['Defects to Watch', checks.defects],
          ['R&D Focus', checks.focus],
        ],
        heading(`PRODUCT-SPECIFIC CHECKPOINTS - ${checks.name.toUpperCase()}`) + 4,
      )
    }
    pairs([['Comments & corrective action', report.comments]], heading('R&D / QA COMMENTS & CORRECTIVE ACTION'))
    grid(
      ['Score', 'Meaning', 'QA/QC Interpretation'],
      SCORING_GUIDE.map((g) => [g.score, g.meaning, g.reading]),
      heading('SCORING GUIDE'),
    )
  }

  // close and signature, on a fresh page when the tables filled this one
  let end = next() + 4
  if (end > doc.internal.pageSize.getHeight() - 40) {
    doc.addPage()
    end = 24
  }
  doc.setFontSize(10).text('** END OF REPORT **', left + width / 2, end, { align: 'center' })
  const signatory = scored
    ? 'Evaluator'
    : def?.signatory || (isLegacyTest(report.category) ? 'Authorised Signatory - Biology' : 'Authorised Signatory')
  doc.line(left + width - 60, end + 18, left + width, end + 18)
  doc.text(dash(report.labTechnician), left + width - 30, end + 23, { align: 'center' })
  doc.text(pdfText(signatory), left + width - 30, end + 28, { align: 'center' })

  return doc.output('blob')
}
