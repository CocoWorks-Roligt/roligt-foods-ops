import { describe, expect, it } from 'vitest'
import { labReportFileName, labReportPdf, pdfText } from './labReportPdf.ts'
import { migrateState } from './migrate.ts'
import { blankScores, defaultSensoryParameters } from './sensory.ts'
import type { LabReport } from '../types.ts'

/**
 * A generated report attached to a QC record is filed as a PDF. jsPDF writes its text
 * uncompressed by default, so the bytes can be read back to see what the file says.
 */

const state = migrateState({})

const certificate: LabReport = {
  id: 'LR-2026-0007',
  category: 'micro',
  customerName: 'Roligt Foods',
  customerAddress: 'Mandya',
  issueDate: '2026-10-09',
  labTechnician: 'A. Rao',
  sampleQtyAmount: 500,
  sampleQtyUnit: 'mL',
  sampleName: 'Tender Coconut Water',
  batchLotDetails: 'BAT-2026-0001',
  batchId: 'BAT-2026-0001',
  sampleDate: '2026-10-08',
  results: [{ name: 'Total Plate Count', method: 'IS 5402', unit: 'cfu/mL', result: '<10' }],
  createdAt: '2026-10-09T08:00:00.000Z',
}

const text = async (blob: Blob) => new TextDecoder('latin1').decode(await blob.arrayBuffer())

describe('labReportPdf', () => {
  it('renders a lab certificate as a PDF carrying its number, sample and results', async () => {
    const blob = await labReportPdf(state, certificate, { logo: null })
    const body = await text(blob)
    expect(body.startsWith('%PDF-')).toBe(true)
    for (const s of ['TEST REPORT', 'LR-2026-0007', 'Tender Coconut Water', 'Total Plate Count', 'END OF REPORT']) {
      expect(body).toContain(s)
    }
  })

  it('renders a sensory evaluation with its scores and decision', async () => {
    const scores = blankScores(defaultSensoryParameters()).map((s) => ({ ...s, score: 4 }))
    const blob = await labReportPdf(state, { ...certificate, id: 'LR-2026-0008', category: 'sensory', scores }, { logo: null })
    const body = await text(blob)
    expect(body).toContain('LR-2026-0008')
    expect(body).toContain('SENSORY SUMMARY')
    expect(body).toContain('SCORING GUIDE')
  })

  it('dates the batch tested: when it was extracted and when it was packed', async () => {
    const dated = {
      ...state,
      batches: [{ id: 'BAT-2026-0001', date: '2026-10-07', sourceLines: [] } as unknown as (typeof state.batches)[number]],
    }
    const body = await text(await labReportPdf(dated, certificate, { logo: null }))
    expect(body).toContain('Extraction date')
    expect(body).toContain('Not packed yet')
  })

  it('is filed under the report number', () => {
    expect(labReportFileName(certificate)).toBe('LR-2026-0007.pdf')
  })
})

describe('pdfText', () => {
  it('keeps Latin-1 and spells out what the built-in fonts cannot print', () => {
    expect(pdfText('Pass – minor “mod” … 4°C · ok')).toBe('Pass - minor "mod" ... 4°C · ok')
    expect(pdfText('नारियल')).toBe('??????')
    expect(pdfText(null)).toBe('')
  })
})
