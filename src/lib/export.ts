import { toDateKey } from './utils'
/**
 * CSV export for the record lists. Every page hands over the rows it is already
 * showing — filters, search and sort included — so what downloads is what the
 * operator can see on screen, not a fresh unfiltered dump of the table.
 */

export interface ExportColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

/** Formula prefixes a spreadsheet evaluates when a cell starts with one — the
 *  CSV injection class (a vendor named `=HYPERLINK(...)` used to run on open).
 *  Guarded with a leading apostrophe, which every mainstream sheet reads as
 *  "this cell is text". Plain negative numbers are the exception: `-20` is a
 *  quantity, and sheets treat a bare `-20` as a number, not a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/** RFC 4180: quote everything and double the quotes inside, so commas, line breaks
 *  and rupee amounts survive a round trip through Excel. */
const cell = (v: string | number | null | undefined) => {
  const s = String(v ?? '')
  const text = FORMULA_PREFIX.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s
  return `"${text.replaceAll('"', '""')}"`
}

export function toCsv<T>(columns: ExportColumn<T>[], rows: T[]) {
  const lines = [columns.map((c) => cell(c.header)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','))
  return lines.join('\r\n')
}

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
