import type { CompareLine } from '../../lib/reports/params.ts'

/**
 * Two windows, side by side, with the change between them — the same
 * derivation run twice, not two reports to be eyeballed against each other.
 *
 * A "—" in the change column is a value judgement the numbers cannot make:
 * there was nothing on the first side, and any percentage would be infinity
 * dressed up as a number. Some lines also know which direction is the good
 * one; the colour follows the direction, not the sign.
 */
export function CompareTable({ labelA, labelB, lines }: { labelA: string; labelB: string; lines: CompareLine[] }) {
  if (!lines.length) return null
  return (
    <div className="table-wrap compare-table">
      <table>
        <thead>
          <tr>
            <th>Measure</th>
            <th className="cell-num">{labelA}</th>
            <th className="cell-num">{labelB}</th>
            <th className="cell-num">Change</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const known = l.delta !== '—'
            const up = l.delta.startsWith('+')
            // goodDirection turns the colour; without it the change is news,
            // not a verdict, and stays neutral.
            const good =
              known && l.goodDirection ? (l.goodDirection === 'up') === up : null
            return (
              <tr key={l.label}>
                <td data-label="Measure">{l.label}</td>
                <td data-label={labelA} className="cell-num">
                  {l.a}
                </td>
                <td data-label={labelB} className="cell-num">
                  {l.b}
                </td>
                <td data-label="Change" className={`cell-num delta ${good === null ? '' : good ? 'good' : 'bad'}`}>
                  {l.delta}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
