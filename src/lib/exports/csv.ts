/**
 * The guarded CSV renderer — ONE implementation, shared by the client's
 * table exports (src/lib/export.ts re-exports it) and the server's export
 * engine (api/_lib/exports.ts), so a cell that would run as a formula when a
 * spreadsheet opens it is guarded the same way everywhere it is written.
 *
 * Isomorphic: `.ts` extensions, no browser globals.
 */

export interface ExportColumn<R> {
  header: string
  value: (row: R) => string | number | null | undefined
}

/** Formula prefixes a spreadsheet evaluates when a cell starts with one — the
 *  CSV injection class (a vendor named `=HYPERLINK(...)` used to run on open).
 *  Guarded with a leading apostrophe, which every mainstream sheet reads as
 *  "this cell is text". Plain negative numbers are the exception: `-20` is a
 *  quantity, and sheets treat a bare `-20` as a number, not a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/** RFC 4180: quote everything and double the quotes inside, so commas, line
 *  breaks and rupee amounts survive a round trip through Excel. */
export const guardCell = (v: string | number | null | undefined): string => {
  const s = String(v ?? '')
  const text = FORMULA_PREFIX.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s
  return `"${text.replaceAll('"', '""')}"`
}

/** The table body: header row + one row per record, CRLF-joined (RFC 4180). */
export function toCsv<R>(columns: ExportColumn<R>[], rows: R[]): string {
  const lines = [columns.map((c) => guardCell(c.header)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => guardCell(c.value(row))).join(','))
  return lines.join('\r\n')
}

/**
 * The export file's leading block (§6: title, filters, generated-by,
 * timestamp) — `#`-prefixed lines before the table. A human opening the file
 * reads them; a parser keyed on the header row skips them (documented in
 * DECISIONS D0). The `# ` prefix itself is the injection guard here: no line
 * of the block can start a cell a spreadsheet would evaluate.
 */
export function toCsvWithMeta<R>(meta: string[], columns: ExportColumn<R>[], rows: R[]): string {
  const head = meta.map((l) => `# ${String(l).replaceAll(/[\r\n]+/g, ' ')}`).join('\r\n')
  return `${head}\r\n${toCsv(columns, rows)}\r\n`
}
