// Extension is explicit: this file is also compiled by the nodenext api build
// (the BFF's counter gate judges period claims against it), where extensionless
// imports do not resolve — the same reason tables.ts and vendorTypes.ts spell
// their own imports out.
import type { NumberingRule } from '../types.ts'

/**
 * The period machinery of document numbering, split out of numbering.ts so the
 * server can run exactly the same arithmetic the honest client runs when it
 * mints — the api build cannot carry numbering.ts itself (its import graph is
 * client code), but a period claim judged by any other rule than the series'
 * own stored pattern is a gate that opens on forgeries: many distinct strings
 * can read as "a current period" at once, while only one of them is the period
 * THIS series computes to (the 2026-10-07 audit's counter-rewind finding).
 */

/** The date tokens a pattern may carry, evaluated on the clock in hand — the
 *  client passes its local clock, the BFF its own; a plant files by the date
 *  on its wall, and the boundary skew is settled the same way both sides
 *  always settled it: the claim that does not match moves nothing. */
export const PERIOD_TOKENS: Record<string, (d: Date) => string> = {
  YYYY: (d) => String(d.getFullYear()),
  YY: (d) => String(d.getFullYear()).slice(-2),
  YYYYMMDD: (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`,
  MM: (d) => String(d.getMonth() + 1).padStart(2, '0'),
  DD: (d) => String(d.getDate()).padStart(2, '0'),
}

/** The pattern every series runs when the plant has saved no rule of its own —
 *  exactly the `pattern` column of NUMBER_SERIES in numbering.ts; a test pins
 *  the two together so they cannot drift. The BFF reads this because a period
 *  claim for an unsaved series must be judged against the same default the
 *  client would mint with. */
export const DEFAULT_SERIES_PATTERNS: Record<string, string> = {
  grn: '{P}{YYYY}{N}',
  lot: '{P}-{YYYYMMDD}-{N}',
  batch: '{P}-{YYYY}-{N}',
  melangeBatch: '{P}-{YYYY}-{N}',
  packing: '{P}-{YYYY}-{N}',
  order: '{P}-{YYYY}-{N}',
  dispatch: '{P}-{YYYY}-{N}',
  challan: '{P}{N}/{YYYY}',
  issue: '{P}-{YYYY}-{N}',
  plan: '{P}-{YYYY}-{N}',
  pmReceipt: '{P}-{YYYY}-{N}',
  qc: '{P}-{YYYY}-{N}',
  testReport: '{P}-{YYYY}-{N}',
  sticker: '{P}-{YYYY}-{N}',
  vendor: '{P}-{N}',
  vendorType: '{P}-{N}',
  customer: '{P}-{N}',
  purchaseProduct: '{P}-{N}',
  product: '{P}-{N}',
  bulkProduct: '{P}-{N}',
  melange: '{P}-{N}',
  storageLocation: '{P}-{N}',
  staff: '{P}-{N}',
}

/** The prefix·middle·number shape numbering used before patterns existed, read
 *  as the pattern it always meant — a rule saved by an older app version still
 *  files the way the office saved it. */
export function legacyPatternOf(saved: NumberingRule): string {
  const sep = typeof saved.separator === 'string' && saved.separator ? saved.separator : '-'
  const middle = saved.middle === 'year' ? `{YYYY}${sep}` : saved.middle === 'date' ? `{YYYYMMDD}${sep}` : ''
  return `{P}${sep}${middle}{N}`
}

/**
 * The pattern a series runs: what the admin saved, or the built-in shape. The
 * same merge `ruleFor` performs for the client, spelled for the server too —
 * a saved pattern wins, a saved rule with no pattern is read as its legacy
 * shape, and a series nobody configured runs the default. Defensive about
 * garbage (the stored config is device-written JSON): anything that is not a
 * string where a string is expected falls through to the next default.
 */
export function seriesPatternOf(saved: NumberingRule | undefined, key: string): string {
  const trimmed = typeof saved?.pattern === 'string' ? saved.pattern.trim() : ''
  if (trimmed) return trimmed
  if (saved) return legacyPatternOf(saved)
  return DEFAULT_SERIES_PATTERNS[key] ?? '{P}-{N}'
}

/** The stretch of time one run of numbers belongs to, read off a pattern:
 *  `YYYY:2026` for `{P}{YYYY}{N}`, `YYYYMMDD:20260909` for a dated lot, and
 *  the empty string for a pattern that carries no date and so runs unbroken
 *  forever. Mirrors periodKeyFor in numbering.ts over the same tokens —
 *  literals, `{P}` and `{N}` contribute nothing. */
export function periodKeyForPattern(pattern: string, when: Date): string {
  const out: string[] = []
  for (const m of pattern.matchAll(/\{([A-Za-z]+)\}/g)) {
    const token = m[1].toUpperCase()
    const read = PERIOD_TOKENS[token]
    if (read) out.push(`${token}:${read(when)}`)
  }
  return out.join('|')
}
