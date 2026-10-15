import { toDateKey } from './utils'
import { toCsv as toCsvShared, type ExportColumn } from './exports/csv.ts'
/**
 * CSV export for the record lists. Every page hands over the rows it is already
 * showing — filters, search and sort included — so what downloads is what the
 * operator can see on screen, not a fresh unfiltered dump of the table.
 *
 * The guarded renderer itself lives in exports/csv.ts (ONE implementation —
 * the server's export engine folds with the same guard); this file keeps the
 * client-side download plumbing and re-exports the shared pieces.
 */

export type { ExportColumn }
export const toCsv = toCsvShared

/** `2026-08-17` — stamped into the file name so repeated exports do not overwrite.
 *  The local date, so a file exported first thing in the morning is not filed under
 *  yesterday. */
const stamp = () => toDateKey()

export function exportCsv<T>(name: string, columns: ExportColumn<T>[], rows: T[]) {
  // The BOM is what makes Excel read the file as UTF-8, and without it every ₹ in
  // the export arrives as mojibake.
  const blob = new Blob(['﻿', toCsv(columns, rows)], {
    type: 'text/csv;charset=utf-8;',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}-${stamp()}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
