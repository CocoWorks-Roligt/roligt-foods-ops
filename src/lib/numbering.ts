/**
 * Document numbering.
 *
 * Every code the app mints — a receipt, a batch, a challan, a vendor — is the same
 * few things: letters the plant reads the series by, a date, and a running number
 * that only ever goes up. Those shapes used to be spelled out one `if` at a time
 * inside `nextId`, which meant a plant that files its receipts `RFTC20260007` had no
 * way to say so.
 *
 * So the shape is data now: a pattern, where `{P}` is the prefix, `{N}` the running
 * number and `{YYYY}` / `{YYYYMMDD}` the date, and everything else prints literally.
 * A pattern rather than a fixed prefix-date-number order because the order genuinely
 * varies — a GRN reads `RFTC20260001` and a challan `DC0001/2026`, with the year on
 * opposite sides of the number and no separator in sight.
 *
 * The counter itself stays where it was, in `state.counters` — that is what actually
 * advances when a document is written, and nothing here changes that.
 *
 * The one rule the admin screen enforces is that a number is never reissued: a code
 * already carried by a live document cannot be minted again, because two receipts
 * sharing an id would break every reference the ledger keeps.
 */

import { batchKind } from './batches'
import type { Problem } from './posting'
import type { AppState, Config, Counters, NumberingRule } from '../types'

/** A counter that mints a document code. `audit` is a tally, not a series. */
export type SeriesKey = Exclude<keyof Counters, 'audit' | 'farmer'>

export interface SeriesDef {
  key: SeriesKey
  /** The group it sits under on the settings screen. */
  group: string
  label: string
  blurb: string
  prefix: string
  pattern: string
  pad: number
}

/** The dated parts a pattern may ask for, beside `{P}` and `{N}`. */
const two = (n: number) => String(n).padStart(2, '0')

/**
 * Every token reads the *local* clock, deliberately.
 *
 * `{YYYYMMDD}` used to be built from `toISOString()` while `{YYYY}`, `{MM}` and
 * `{DD}` beside it were built from the local getters. In IST that is a five-and-a-half
 * hour disagreement, so every lot booked in before 05:30 — which, at a plant taking
 * in an early harvest, is a lot of them — was stamped with the previous day while the
 * receipt beside it read today. A plant files by the date on its own wall.
 */
export const DATE_TOKENS: Record<string, { label: string; value: (d: Date) => string; shape: string }> = {
  YYYY: { label: 'Year — 2026', value: (d) => String(d.getFullYear()), shape: '\\d{4}' },
  YY: { label: 'Year, short — 26', value: (d) => String(d.getFullYear()).slice(-2), shape: '\\d{2}' },
  YYYYMMDD: {
    label: 'Date — 20260909',
    value: (d) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`,
    shape: '\\d{8}',
  },
  MM: { label: 'Month — 09', value: (d) => two(d.getMonth() + 1), shape: '\\d{2}' },
  DD: { label: 'Day — 09', value: (d) => two(d.getDate()), shape: '\\d{2}' },
}

const PREFIX_TOKENS = ['P', 'PREFIX']
const NUMBER_TOKENS = ['N', 'NUM']

/** The default shape for most documents: `GRN-2026-0001`. */
const YEARLY = '{P}-{YYYY}-{N}'
/** Masters carry no date — `VEN-00001`. */
const PLAIN = '{P}-{N}'

const series = (
  key: SeriesKey,
  group: string,
  label: string,
  blurb: string,
  prefix: string,
  pattern = YEARLY,
  pad = 4,
): SeriesDef => ({ key, group, label, blurb, prefix, pattern, pad })

/**
 * Every series, in the order the settings screen lists them.
 *
 * Receipts and challans carry the plant's own formats — `RFTC20260001` and
 * `DC0001/2026` — so a fresh install files them the way the office already does.
 * Everything else keeps the shape it has always had.
 */
export const NUMBER_SERIES: SeriesDef[] = [
  series('grn', 'Procurement', 'Goods receipt (GRN)', 'One per load received at the gate', 'RFTC', '{P}{YYYY}{N}'),
  series('lot', 'Procurement', 'Raw material lot', 'The lot a receipt puts into store', 'LOT', '{P}-{YYYYMMDD}-{N}', 3),
  series('batch', 'Production', 'Extraction batch', 'A pressing run', 'BAT'),
  series('melangeBatch', 'Production', 'Melange run', 'A blend against a recipe', 'MEL'),
  series('packing', 'Production', 'Packing run', 'Bulk filled into packs', 'PKG'),
  series('order', 'Sales', 'Customer order', 'What a customer asked for', 'ORD'),
  series('dispatch', 'Sales', 'Dispatch', 'One line of goods leaving', 'DSP'),
  series('challan', 'Sales', 'Delivery challan', 'The document that travels with the vehicle', 'DC', '{P}{N}/{YYYY}'),
  series('issue', 'Stock', 'Stock issue', 'Stock out for something that is not a sale', 'ISS'),
  series('pmReceipt', 'Stock', 'Packing material receipt', 'Packing material booked into store', 'PMR'),
  series('qc', 'Quality', 'QC record', 'The check a batch is released on', 'QC'),
  series('testReport', 'Quality', 'Lab report', 'An issued certificate of analysis', 'TR'),
  series('sticker', 'Quality', 'Sticker print job', 'One row in the print history', 'STK'),
  series('vendor', 'Masters', 'Vendor / farmer', 'A supplier on the approved list', 'VEN', PLAIN, 5),
  series('vendorType', 'Masters', 'Vendor type', 'Farmer, vendor, transporter…', 'VT', PLAIN),
  series('customer', 'Masters', 'Customer', 'Whoever the goods are sold to', 'CUS', PLAIN, 5),
  series('purchaseProduct', 'Masters', 'Purchase product', 'What may be bought, and from whom', 'PP', PLAIN),
  series('product', 'Masters', 'Pack product', 'A finished-goods SKU', 'FG', PLAIN),
  series('bulkProduct', 'Masters', 'Bulk product', 'A semi-finished output', 'SF', PLAIN),
  series('melange', 'Masters', 'Melange recipe', 'A blend the plant can run', 'MLG', PLAIN),
  series('storageLocation', 'Masters', 'Storage area', 'A cold room, dry store or hold area', 'LOC', PLAIN),
]

/** The groups, in listing order, with their series. */
export const SERIES_GROUPS = NUMBER_SERIES.reduce<{ group: string; series: SeriesDef[] }[]>(
  (out, s) => {
    const row = out.find((g) => g.group === s.group)
    if (row) row.series.push(s)
    else out.push({ group: s.group, series: [s] })
    return out
  },
  [],
)

export const seriesDef = (key: string): SeriesDef | undefined =>
  NUMBER_SERIES.find((s) => s.key === key)

/**
 * Shapes offered as a pick on the settings screen, so choosing a format is reading
 * one off a list rather than learning the token syntax. Anything not here is still
 * reachable by typing a pattern.
 */
export const SHAPE_CHOICES = [
  YEARLY,
  '{P}{YYYY}{N}',
  '{P}/{YYYY}/{N}',
  '{P}{N}/{YYYY}',
  '{P}-{N}/{YYYY}',
  PLAIN,
  '{P}{N}',
  '{P}-{YYYYMMDD}-{N}',
]

const fallback = (key: string): SeriesDef => ({
  key: key as SeriesKey,
  group: 'Other',
  label: key,
  blurb: '',
  prefix: String(key).toUpperCase(),
  pattern: PLAIN,
  pad: 4,
})

/** The prefix·middle·number shape this replaced, as a pattern. */
const legacyPattern = (saved: NumberingRule) => {
  const sep = saved.separator ?? '-'
  const middle = saved.middle === 'year' ? `{YYYY}${sep}` : saved.middle === 'date' ? `{YYYYMMDD}${sep}` : ''
  return `{P}${sep}${middle}{N}`
}

/**
 * The shape a series is written in: what the admin saved, or the built-in shape.
 * A stored rule is merged field by field so a rule written before a field existed
 * still reads, rather than needing a migration — including the ones saved under the
 * old prefix/middle/separator shape, which are read as the pattern they meant.
 */
export function ruleFor(config: Config | undefined, key: string): NumberingRule {
  const base = seriesDef(key) ?? fallback(key)
  const saved = config?.numbering?.find((r) => r.key === key)
  const pad = Number(saved?.pad) > 0 ? Number(saved?.pad) : base.pad
  return {
    key,
    prefix: saved?.prefix?.trim() || base.prefix,
    pattern: saved?.pattern?.trim() || (saved ? legacyPattern(saved) : base.pattern),
    pad,
  }
}

type Part = { lit: string } | { token: string }

/** A pattern split into its literal runs and its tokens, uppercased. */
function partsOf(pattern: string): Part[] {
  const out: Part[] = []
  let last = 0
  for (const m of pattern.matchAll(/\{([A-Za-z]+)\}/g)) {
    const at = m.index ?? 0
    if (at > last) out.push({ lit: pattern.slice(last, at) })
    out.push({ token: m[1].toUpperCase() })
    last = at + m[0].length
  }
  if (last < pattern.length) out.push({ lit: pattern.slice(last) })
  return out
}

const padded = (rule: NumberingRule, n: number) =>
  String(Math.max(1, Math.round(n) || 1)).padStart(Math.min(9, Math.max(1, Math.round(rule.pad) || 4)), '0')

/** `{P}{YYYY}{N}` + `RFTC` + 7 → `RFTC20260007`. Dates are read off `when`. */
export function formatDocNo(rule: NumberingRule, n: number, when = new Date()) {
  return partsOf(rule.pattern)
    .map((p) => {
      if ('lit' in p) return p.lit
      if (PREFIX_TOKENS.includes(p.token)) return rule.prefix.trim()
      if (NUMBER_TOKENS.includes(p.token)) return padded(rule, n)
      // An unknown token prints as written, so a typo shows up in the preview
      // rather than silently vanishing from every code the series mints.
      return DATE_TOKENS[p.token] ? DATE_TOKENS[p.token].value(when) : `{${p.token}}`
    })
    .join('')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A rule as a regex that recognises codes written in its shape and captures the
 * running number. Built once and reused: scanning a series means testing this
 * against every code the plant has ever issued, and compiling a fresh regex per code
 * is a page that slows to a crawl as the ledger fills up.
 */
export function seriesMatcher(rule: NumberingRule, when?: Date): RegExp {
  const src = partsOf(rule.pattern)
    .map((p) => {
      if ('lit' in p) return escapeRe(p.lit)
      if (PREFIX_TOKENS.includes(p.token)) return escapeRe(rule.prefix.trim())
      if (NUMBER_TOKENS.includes(p.token)) return '(\\d+)'
      const date = DATE_TOKENS[p.token]
      if (!date) return escapeRe(`{${p.token}}`)
      // With a date in hand the token matches only *that* period, which is what makes
      // `DC0001/2027` a fresh series rather than a collision with `DC0142/2026`.
      // Without one it matches any period, for reading a code of unknown vintage.
      return when ? escapeRe(date.value(when)) : date.shape
    })
    .join('')
  return new RegExp(`^${src}$`)
}

/**
 * The stretch of time one run of numbers belongs to — `2026` for a series written
 * `{P}{YYYY}{N}`, `20260909` for a dated lot, and the empty string for a series that
 * carries no date and so runs unbroken forever.
 *
 * This is what tells a counter it has crossed into a new year or a new day and should
 * start again at 1. Without it `LOT-{YYYYMMDD}-{N}` kept climbing across days —
 * `LOT-20260910-0047` on the morning of the tenth — and a challan series that has to
 * restart every financial year had no way to.
 */
export function periodKeyFor(rule: NumberingRule, when = new Date()): string {
  return partsOf(rule.pattern)
    .filter((p): p is { token: string } => 'token' in p && !!DATE_TOKENS[p.token])
    .map((p) => `${p.token}:${DATE_TOKENS[p.token].value(when)}`)
    .join('|')
}

/**
 * Reads the running number back out of a code, or null if the code was not written
 * in this shape. Matching the whole pattern rather than trimming trailing digits is
 * what makes `DC0001/2026` work — its last digits are the year, not the number.
 */
export function numberFromCode(rule: NumberingRule, code: string): number | null {
  return matchNumber(seriesMatcher(rule), code)
}

const matchNumber = (re: RegExp, code: string): number | null => {
  const m = re.exec((code || '').trim())
  return m?.[1] ? Number(m[1]) : null
}

/**
 * Codes this series has already handed out. Read off the records themselves rather
 * than trusted to the counter, because the counter is what an admin is about to
 * change and the records are what would collide.
 */
export function issuedCodes(state: AppState, key: string): string[] {
  switch (key) {
    case 'grn':
      return state.grns.map((g) => g.id)
    case 'lot':
      return state.grns.map((g) => g.lot)
    case 'batch':
      return state.batches.filter((b) => batchKind(b) !== 'Melange').map((b) => b.id)
    case 'melangeBatch':
      return state.batches.filter((b) => batchKind(b) === 'Melange').map((b) => b.id)
    case 'packing':
      return (state.packingRuns || []).map((r) => r.id)
    case 'order':
      return (state.orders || []).map((o) => o.id)
    case 'dispatch':
      return state.dispatches.map((d) => d.id)
    case 'challan':
      return state.dispatches.map((d) => d.challan)
    case 'qc':
      return state.qcs.map((q) => q.id)
    case 'testReport':
      return (state.labReports || []).map((r) => r.id)
    case 'sticker':
      return (state.stickerPrints || []).map((p) => p.id)
    case 'issue':
      return (state.stockIssues || []).map((i) => i.id)
    case 'pmReceipt':
      // A packing-material receipt is one ledger line and has no record of its own,
      // so the ledger is where its codes are filed.
      return state.ledger.filter((l) => l.type === 'PM Receipt').map((l) => l.doc)
    case 'vendor':
      return state.vendors.map((v) => v.id)
    case 'vendorType':
      return state.vendorTypes.map((v) => v.id)
    case 'customer':
      return state.customers.map((c) => c.id)
    case 'purchaseProduct':
      return state.purchaseProducts.map((p) => p.id)
    case 'product':
      return state.products.map((p) => p.id)
    case 'bulkProduct': {
      // A melange recipe mints its own bulk item off the recipe's code, not off this
      // counter, so those are not numbers this series has handed out.
      const owned = new Set((state.melanges || []).map((m) => m.outputItem))
      return state.items
        .filter((i) => i.type === 'Semi Finished' && !owned.has(i.id))
        .map((i) => i.id)
    }
    case 'melange':
      return (state.melanges || []).map((m) => m.id)
    case 'storageLocation':
      return state.storageLocations.map((l) => l.id)
    default:
      return []
  }
}

/**
 * The highest number already issued *in this shape, in this period*.
 *
 * Both halves are deliberate. A plant that renames its receipts from `GRN-2026-0001`
 * to `RFTC20260001` has started a fresh series and may legitimately begin again at 1.
 * And a series whose shape carries a year is a fresh run of numbers each year — so
 * `DC0142/2026` is not a reason to refuse `DC0001/2027`. A series with no date in its
 * shape has one period that never ends, and is unaffected.
 */
export function highestIssued(
  state: AppState,
  key: string,
  rule: NumberingRule,
  when = new Date(),
): number {
  const re = seriesMatcher(rule, when)
  return issuedCodes(state, key).reduce((hi, id) => Math.max(hi, matchNumber(re, id) ?? 0), 0)
}

/**
 * Whether a proposed shape and starting number can be saved. Everything here is
 * either a pattern that could not mint a distinct code, or a refusal to reissue one
 * a live document already carries — the format itself is the admin's business.
 */
export function checkNumbering(
  state: AppState,
  key: string,
  rule: NumberingRule,
  next: number,
): Problem {
  if (!seriesDef(key)) return 'Unknown numbering series.'
  const prefix = rule.prefix.trim()
  const pattern = rule.pattern.trim()
  if (!prefix && pattern.includes('{P}')) return 'Give the series a prefix.'
  if (prefix.length > 16) return 'Keep the prefix to 16 characters or fewer.'
  if (!/^[A-Za-z0-9&/_. -]*$/.test(prefix)) {
    return 'Use letters, digits, spaces or - _ . / & in the prefix.'
  }
  if (!pattern) return 'Give the series a format.'
  if (pattern.length > 48) return 'Keep the format to 48 characters or fewer.'
  const parts = partsOf(pattern)
  const unknown = parts
    .filter((p): p is { token: string } => 'token' in p)
    .map((p) => p.token)
    .filter((t) => !PREFIX_TOKENS.includes(t) && !NUMBER_TOKENS.includes(t) && !DATE_TOKENS[t])
  if (unknown.length) {
    return `{${unknown[0]}} is not a part — use {P}, {N}, ${Object.keys(DATE_TOKENS).map((t) => `{${t}}`).join(', ')}.`
  }
  const numbers = parts.filter((p) => 'token' in p && NUMBER_TOKENS.includes(p.token)).length
  if (numbers !== 1) {
    return numbers
      ? 'The format uses {N} more than once — a code carries one running number.'
      : 'The format needs {N}, or every document would get the same code.'
  }
  // A number pressed straight against a literal digit cannot be read back apart:
  // `RFTC2026` + `0001` is fine, but a `2` typed beside `{N}` is not.
  const idx = parts.findIndex((p) => 'token' in p && NUMBER_TOKENS.includes(p.token))
  const before = parts[idx - 1]
  const after = parts[idx + 1]
  if (before && 'lit' in before && /\d$/.test(before.lit)) {
    return 'The format runs a digit into {N} — put a separator between them.'
  }
  if (after && 'lit' in after && /^\d/.test(after.lit)) {
    return 'The format runs {N} into a digit — put a separator between them.'
  }
  const pad = Math.round(rule.pad)
  if (!(pad >= 1 && pad <= 9)) return 'Padding is between 1 and 9 digits.'
  const start = Math.round(next)
  if (!(start >= 1)) return 'The next number starts at 1.'
  const clean = { ...rule, prefix, pattern }
  const hi = highestIssued(state, key, clean)
  if (hi && start <= hi) {
    return `${formatDocNo(clean, hi)} is already issued — start at ${hi + 1} or later, or change the format.`
  }
  return null
}
