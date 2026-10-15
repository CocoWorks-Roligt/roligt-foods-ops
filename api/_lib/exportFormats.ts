/**
 * The export format renderers — server-only (heavy libraries; the CSV guard is
 * the isomorphic half in src/lib/exports/csv.ts). XLSX renders through exceljs
 * (DECISIONS dependency log), PDF through the same jsPDF + autotable pair the
 * challan PDF already rides. PDF text is Latin-1 only (challanPdf's note), so
 * ₹ prints as "Rs." there; CSV/XLSX carry the rupee sign natively.
 *
 * Every format carries the §6 header block: title, filters applied,
 * generated-by, timestamp (IST — the plant's own clock).
 */
import type { ExportColumn } from '../../src/lib/exports/csv.ts'

export interface ExportMeta {
  title: string
  /** `Window: 2026-04-15 → 2026-10-15` — every applied filter, one line each. */
  lines: string[]
}

export interface RenderedFile {
  bytes: Buffer
  contentType: string
  ext: string
}

/** `15 Oct 2026, 14:30 IST` — the plant's clock, not the server's. */
export const istStamp = (at: string | number | Date): string => {
  const d = new Date(at)
  return `${d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} IST`
}

/** The built-in PDF fonts are Latin-1 (challanPdf's constraint): swap the
 *  rupee sign for "Rs." in PDF text only. */
export const latin1Text = (v: string): string => v.replaceAll('₹', 'Rs.')

export async function renderXlsx<R>(
  meta: ExportMeta,
  columns: ExportColumn<R>[],
  rows: R[],
): Promise<RenderedFile> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Roligt Foods Ops'
  wb.created = new Date()
  const sheet = wb.addWorksheet('Report')
  sheet.addRow([meta.title])
  sheet.getCell(1, 1).font = { bold: true, size: 13 }
  for (const line of meta.lines) sheet.addRow([line])
  sheet.addRow([])
  const headerRow = sheet.addRow(columns.map((c) => c.header))
  headerRow.font = { bold: true }
  for (const row of rows) sheet.addRow(columns.map((c) => c.value(row) ?? ''))
  // Injection guard, the CSV class: a cell that starts like a formula is
  // stored as text with the same leading apostrophe Excel itself writes.
  const firstDataRow = meta.lines.length + 4
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n < firstDataRow) return
    row.eachCell({ includeEmpty: false }, (cell) => {
      const raw = cell.value
      if (typeof raw === 'string' && /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw)) {
        cell.value = `'${raw}`
      }
    })
  })
  const bytes = Buffer.from(await wb.xlsx.writeBuffer())
  return { bytes, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' }
}

export async function renderPdf<R>(
  meta: ExportMeta,
  columns: ExportColumn<R>[],
  rows: R[],
): Promise<RenderedFile> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ orientation: columns.length > 8 ? 'landscape' : 'portrait' })
  doc.setFontSize(14)
  doc.text(latin1Text(meta.title), 14, 16)
  doc.setFontSize(9)
  meta.lines.forEach((line, i) => doc.text(latin1Text(line), 14, 22 + i * 5))
  autoTable(doc, {
    startY: 24 + meta.lines.length * 5,
    head: [columns.map((c) => latin1Text(c.header))],
    body: rows.map((row) => columns.map((c) => latin1Text(String(c.value(row) ?? '')))),
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [13, 148, 136] },
    didDrawPage: (d: { pageNumber: number; settings: { margin: { left: number } } }) => {
      doc.setFontSize(8)
      doc.text(`Page ${d.pageNumber}`, d.settings.margin.left, 290)
    },
  })
  return { bytes: Buffer.from(doc.output('arraybuffer')), contentType: 'application/pdf', ext: 'pdf' }
}
