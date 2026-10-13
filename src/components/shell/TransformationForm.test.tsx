// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MassBalanceBar } from './TransformationForm.tsx'
import { DEFAULT_MASS_BALANCE_CONFIG } from '../../lib/rules/massBalance.ts'

afterEach(cleanup)

const line = (item: string, qty: number, uom = 'kg') => ({ item, qty, uom })

describe('MassBalanceBar', () => {
  it('reads within tolerance when outputs and spoilage account for the inputs', () => {
    render(
      <MassBalanceBar
        inputs={[line('coconuts', 600)]}
        outputs={[line('bulk', 500)]}
        spoilage={[line('husk loss', 95)]}
        items={{}}
      />,
    )
    const bar = screen.getByRole('status')
    expect(bar.className).toContain('good')
    expect(bar.textContent).toContain('within the 2% tolerance')
    expect(bar.textContent).toContain('Spoilage 95 kg')
  })

  it('reads outside tolerance, naming the variance', () => {
    render(
      <MassBalanceBar
        inputs={[line('coconuts', 600)]}
        outputs={[line('bulk', 400)]}
        spoilage={[line('husk loss', 95)]}
        items={{}}
      />,
    )
    const bar = screen.getByRole('status')
    expect(bar.className).toContain('bad')
    expect(bar.textContent).toContain('outside the 2% tolerance')
  })

  it('ignores rows waiting to be filled, but judges an unknown unit', () => {
    const { rerender } = render(
      <MassBalanceBar inputs={[line('', 0, '')]} outputs={[]} spoilage={[]} items={{}} />,
    )
    expect(screen.getByRole('status').textContent).toContain('Enter the inputs')

    rerender(
      <MassBalanceBar
        inputs={[line('coconuts', 600, 'baskets')]}
        outputs={[]}
        spoilage={[]}
        items={{}}
      />,
    )
    const bar = screen.getByRole('status')
    expect(bar.className).toContain('neutral')
    expect(bar.textContent).toContain('Cannot total yet')
  })

  it('converts litres through the item density before summing', () => {
    // 500 L of bulk at 0.97 kg/L = 485 kg against 600 kg in, 115 kg spoilage: 0% variance.
    render(
      <MassBalanceBar
        inputs={[line('coconuts', 600)]}
        outputs={[line('bulk', 500, 'litre')]}
        spoilage={[line('husk loss', 115)]}
        items={{ bulk: { uom: 'litre', densityKgPerL: 0.97 } }}
        config={DEFAULT_MASS_BALANCE_CONFIG}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Out 485 kg')
  })
})
