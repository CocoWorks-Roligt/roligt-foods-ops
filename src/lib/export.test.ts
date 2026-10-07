import { describe, expect, it } from 'vitest'
import { toCsv, type ExportColumn } from './export.ts'

/**
 * The CSV formula guard (the audit's S3-2): quoting a cell does not stop a
 * spreadsheet from EVALUATING it — `=`, `+`, `-`, `@` (and tab/CR smuggling)
 * prefixes run on open — so those cells are prefixed with an apostrophe, the
 * "this is text" marker. Plain negative numbers are exempt: `-20` is a
 * quantity, and a sheet reading it as a number is the point. exportCsv only
 * downloads; toCsv is the pure half, so the tests read the CSV string.
 */
const cols: ExportColumn<{ v: string | number | null }>[] = [{ header: 'Value', value: (r) => r.v }]
const one = (v: string | number | null) => toCsv(cols, [{ v }]).split('\r\n')[1]!

describe('toCsv — formula guard', () => {
  it('apostrophes every formula prefix so no cell evaluates on open', () => {
    for (const hostile of ['=HYPERLINK("http://evil","x")', '+SUM(A1:A9)', '@cmd', '-2+3|cmd', '\t=cmd', '\r=cmd']) {
      const cell = one(hostile)
      // the guard sits INSIDE the quotes: the sheet sees text starting with '
      expect(cell.startsWith(`"'`)).toBe(true)
      expect(cell).not.toBe(`"${hostile}"`) // the raw payload never travels unguarded
    }
  })

  it('leaves plain negative numbers numeric — a quantity is not a formula', () => {
    // a number the operator typed as a number, and the same digits as text
    expect(one(-20)).toBe('"-20"')
    expect(one('-20')).toBe('"-20"')
    expect(one(3.5)).toBe('"3.5"')
  })

  it('still quotes and doubles — commas, breaks and quotes survive the round trip', () => {
    expect(one('he said "hi", twice')).toBe(`"he said ""hi"", twice"`)
    expect(one('plain text')).toBe('"plain text"')
    expect(one(null)).toBe('""')
  })
})
