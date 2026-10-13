/**
 * The transformation form core (overhaul §6 TransformationForm): the
 * inputs/outputs/spoilage line grid with the mass-balance verdict folding
 * live above it. Whatever the operator types is judged by the SAME
 * computeMassBalance the server's close gate enforces from (rules lib is
 * isomorphic), so the number on screen and the number that refuses a close
 * cannot drift apart.
 *
 * Presentational + controlled: the page owns the lines and what item names
 * mean (the items master); this component edits rows and reports the fold.
 */
import {
  DEFAULT_MASS_BALANCE_CONFIG,
  MassBalanceError,
  computeMassBalance,
  toBaseKg,
  type MassBalanceConfig,
  type MassBalanceItems,
} from '../../lib/rules/massBalance.ts'

export interface TransformationLine {
  item: string
  qty: number
  uom: string
}

export interface TransformationValue {
  inputs: TransformationLine[]
  outputs: TransformationLine[]
  spoilage: TransformationLine[]
}

type LineKey = keyof TransformationValue

const SECTIONS: { key: LineKey; title: string; hint: string }[] = [
  { key: 'inputs', title: 'Inputs', hint: 'What was drawn into the run' },
  { key: 'outputs', title: 'Outputs', hint: 'What the run produced' },
  { key: 'spoilage', title: 'Spoilage', hint: 'What was lost, and why — record the reason in the run notes' },
]

const kg = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`

/** The live verdict: totals in kg, variance as a percent of inputs, the
 *  tolerance named — good/bad said in words, colour only seconding them. */
export function MassBalanceBar({
  inputs,
  outputs,
  spoilage,
  items,
  config = DEFAULT_MASS_BALANCE_CONFIG,
}: {
  inputs: readonly TransformationLine[]
  outputs: readonly TransformationLine[]
  spoilage: readonly TransformationLine[]
  items: MassBalanceItems
  config?: MassBalanceConfig
}) {
  // Zero-qty rows are not judged — a row waiting to be filled cannot make a
  // form wrong (the close gate folds the same way, via batchLines).
  const fold = (lines: readonly TransformationLine[]) => lines.filter((l) => Number(l.qty) > 0)
  let verdict: { tone: 'good' | 'bad' | 'neutral'; text: string } | null = null
  try {
    const foldKg = (lines: readonly TransformationLine[]) =>
      fold(lines).reduce((total, line) => total + toBaseKg(line, items, config), 0)
    const r = computeMassBalance(fold(inputs), fold(outputs), fold(spoilage), items, config)
    if (r.inputBaseUnits <= 0) {
      verdict = { tone: 'neutral', text: 'Enter the inputs to see the balance.' }
    } else {
      const head = `In ${kg(r.inputBaseUnits)} · Out ${kg(r.outputBaseUnits)} · Spoilage ${kg(foldKg(spoilage))}`
      const pct = `${r.variancePct >= 0 ? '+' : ''}${r.variancePct.toFixed(2)}%`
      verdict = r.withinTolerance
        ? { tone: 'good', text: `${head} — variance ${pct}, within the ${config.massBalanceTolerancePct}% tolerance ✓` }
        : { tone: 'bad', text: `${head} — variance ${pct}, outside the ${config.massBalanceTolerancePct}% tolerance ✗` }
    }
  } catch (e) {
    verdict =
      e instanceof MassBalanceError
        ? { tone: 'neutral', text: `Cannot total yet — ${e.message}` }
        : { tone: 'neutral', text: 'Cannot total yet — check the units on every line.' }
  }
  return (
    <div className={`mass-balance ${verdict.tone}`} role="status">
      {verdict.text}
    </div>
  )
}

export function TransformationForm({
  value,
  onChange,
  items,
  config,
}: {
  value: TransformationValue
  onChange: (next: TransformationValue) => void
  /** Material masters — where a litre-heavy item's density comes from. */
  items: MassBalanceItems
  config?: MassBalanceConfig
}) {
  const setLine = (key: LineKey, index: number, patch: Partial<TransformationLine>) => {
    const lines = value[key].map((l, i) => (i === index ? { ...l, ...patch } : l))
    onChange({ ...value, [key]: lines })
  }
  const addLine = (key: LineKey) => {
    // kg is the unit everything sums in — the default that can never fail to fold.
    onChange({ ...value, [key]: [...value[key], { item: '', qty: 0, uom: 'kg' }] })
  }
  const removeLine = (key: LineKey, index: number) => {
    onChange({ ...value, [key]: value[key].filter((_, i) => i !== index) })
  }

  return (
    <div className="transform-form">
      <MassBalanceBar
        inputs={value.inputs}
        outputs={value.outputs}
        spoilage={value.spoilage}
        items={items}
        config={config}
      />
      {SECTIONS.map(({ key, title, hint }) => (
        <fieldset key={key} className="transform-section">
          <legend>{title}</legend>
          <small className="transform-hint">{hint}</small>
          {value[key].length === 0 ? (
            <p className="transform-empty">No lines yet.</p>
          ) : (
            <div className="transform-rows">
              {value[key].map((line, i) => (
                <div key={i} className="transform-row">
                  <label className="visually-hidden" htmlFor={`${key}-${i}-item`}>
                    {title} line {i + 1} item
                  </label>
                  <input
                    id={`${key}-${i}-item`}
                    type="text"
                    value={line.item}
                    placeholder="Item"
                    onChange={(e) => setLine(key, i, { item: e.target.value })}
                  />
                  <label className="visually-hidden" htmlFor={`${key}-${i}-qty`}>
                    {title} line {i + 1} quantity
                  </label>
                  <input
                    id={`${key}-${i}-qty`}
                    type="number"
                    min={0}
                    step="any"
                    value={Number.isFinite(line.qty) ? line.qty : 0}
                    onChange={(e) => setLine(key, i, { qty: Number(e.target.value) })}
                  />
                  <label className="visually-hidden" htmlFor={`${key}-${i}-uom`}>
                    {title} line {i + 1} unit
                  </label>
                  <input
                    id={`${key}-${i}-uom`}
                    type="text"
                    value={line.uom}
                    placeholder="kg"
                    onChange={(e) => setLine(key, i, { uom: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn-light transform-remove"
                    aria-label={`Remove ${title.toLowerCase()} line ${i + 1}`}
                    onClick={() => removeLine(key, i)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-light" onClick={() => addLine(key)}>
            Add {title.toLowerCase()} line
          </button>
        </fieldset>
      ))}
    </div>
  )
}
