/**
 * Chart colour parameters (DESIGN_SYSTEM §4) resolved from the live theme.
 *
 * The palettes were chosen by the six-checks validator, not by eye: the
 * categorical eight in a fixed order (never cycled; a ninth series folds to
 * "Other"), the teal ramp for magnitude, blue↔red with a gray midpoint for
 * polarity. Because a canvas cannot read CSS custom properties, these are
 * read from the document at chart-build time — a theme flip re-renders every
 * chart through the same resolution.
 */

export interface ChartTooltipStyle {
  backgroundColor: string
  borderColor: string
  borderWidth: number
  textStyle: { color: string; fontSize: number }
  extraCssText: string
}

export interface ChartBase {
  animation: boolean
  textStyle: { fontFamily: string; color: string }
  axisPointer: { lineStyle: { color: string } }
  tooltip: ChartTooltipStyle
}

export interface ChartColors {
  /** Categorical slots, fixed order — slot index IS the series identity. */
  categorical: readonly string[]
  /** One-hue teal ramp, light→dark = low→high magnitude. */
  sequential: readonly string[]
  /** Diverging: low pole, neutral midpoint, high pole. */
  diverging: { low: string; mid: string; high: string }
  ink: string
  inkSoft: string
  hair: string
  panel: string
  /** ECharts base option: fonts, axes, grid — the recessive furniture. */
  base: ChartBase
}

const PALETTES = {
  light: {
    categorical: ['#0d9488', '#eb6834', '#6250d6', '#eda100', '#e87ba4', '#008300', '#2a78d6', '#e34948'],
    sequential: ['#64c3a7', '#45a68b', '#238a71', '#006f57'],
    diverging: { low: '#2a78d6', mid: '#8a918f', high: '#e34948' },
  },
  dark: {
    categorical: ['#0d9488', '#d95926', '#9085e9', '#c98500', '#d55181', '#008300', '#3987e5', '#e66767'],
    sequential: ['#006952', '#138168', '#379a7f', '#53b397'],
    diverging: { low: '#3987e5', mid: '#9daaa6', high: '#e66767' },
  },
} as const

/** Resolves the current theme's tokens from the document. */
export function chartColors(): ChartColors {
  const dark =
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
  const p = dark ? PALETTES.dark : PALETTES.light
  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const v = (name: string, fallback: string) => css?.getPropertyValue(name)?.trim() || fallback
  const ink = v('--ink', '#15181b')
  const inkSoft = v('--ink-soft', '#5b626a')
  const hair = v('--hair-soft', '#e8eeec')
  const panel = v('--panel', '#ffffff')
  const font = v('font-family', "'Bricolage Grotesque', system-ui, sans-serif").split(',')[0]
  return {
    ...p,
    ink,
    inkSoft,
    hair,
    panel,
    base: {
      animation: false,
      textStyle: { fontFamily: `${font}, system-ui, sans-serif`, color: inkSoft },
      axisPointer: { lineStyle: { color: hair } },
      tooltip: {
        backgroundColor: panel,
        borderColor: hair,
        borderWidth: 1,
        textStyle: { color: ink, fontSize: 12 },
        extraCssText: 'box-shadow: 0 6px 24px rgba(21,24,27,.12); border-radius: 8px;',
      },
    },
  }
}

/** Slot colour for series index i, with the 9th-and-on folding to neutral. */
export function seriesColor(c: ChartColors, i: number): string {
  return c.categorical[i] ?? c.categorical[0]!
}
