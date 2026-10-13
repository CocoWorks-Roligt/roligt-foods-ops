/**
 * The one status palette (GLOSSARY.md — the overhaul's §6 rule: status is
 * never colour-only; every reading is colour + glyph + word).
 *
 * Stored statuses are KEYS the whole history is written in — they are never
 * renamed here. What changes is the reading: a stored key resolves to one
 * palette entry (tone + glyph name + the word the operator sees). Keys the
 * palette does not know (master-data states like Active/Inactive, and stock's
 * Available, which is a quantity not a workflow) keep the legacy rendering:
 * statusLabel + statusClass, no glyph.
 *
 * The exact-match table comes first so context is decided by the full key —
 * QC's 'Pending' is On Hold (awaiting test), an order's 'Open' is Pending —
 * and only genuinely unknown keys fall through to the ordered family match.
 */

export type PaletteTone = 'success' | 'danger' | 'warning' | 'info' | 'brand' | 'neutral'

export interface PaletteEntry {
  /** One of the eleven palette states (or a family label like Cancelled). */
  palette: string
  /** The word the operator reads; defaults to the palette word. */
  label?: string
  tone: PaletteTone
  /** Glyph name resolved by StatusIcons — absent means legacy, no glyph. */
  icon?: string
}

export const PALETTE: Record<string, PaletteEntry> = {
  // Waiting to start — neutral, a clock.
  pending: { palette: 'Pending', tone: 'neutral', icon: 'clock' },
  // Moving — blue while work happens, teal while goods travel.
  inProgress: { palette: 'In Progress', tone: 'info', icon: 'play' },
  dispatched: { palette: 'Dispatched', tone: 'brand', icon: 'truckOut' },
  outForDelivery: { palette: 'Out for Delivery', tone: 'brand', icon: 'truck' },
  // Blocked or waiting on a verdict — amber.
  onHold: { palette: 'On Hold', label: 'On Hold (awaiting QC)', tone: 'warning', icon: 'pause' },
  rework: { palette: 'Rework', tone: 'warning', icon: 'rotate' },
  // Verdicts and completions — green.
  passed: { palette: 'Passed', tone: 'success', icon: 'check' },
  released: { palette: 'Released', tone: 'success', icon: 'checkCircle' },
  delivered: { palette: 'Delivered', tone: 'success', icon: 'homeCheck' },
  // Failure — red.
  failed: { palette: 'Failed', tone: 'danger', icon: 'x' },
  // Back / off — neutral with its own glyph so it never reads as Pending.
  returned: { palette: 'Returned', tone: 'neutral', icon: 'undo' },
  cancelled: { palette: 'Cancelled', tone: 'neutral', icon: 'slash' },
}

/** Stored key → palette entry. Lowercased; longest keys decide first. */
const EXACT: Record<string, PaletteEntry> = {
  // lots / QC (the amber family — these are held, not waiting to start)
  pending: PALETTE.onHold,
  quarantine: PALETTE.onHold,
  'awaiting qc': PALETTE.onHold,
  hold: PALETTE.onHold,
  'in test': PALETTE.inProgress,
  retest: PALETTE.rework,
  rework: PALETTE.rework,
  released: PALETTE.released,
  passed: PALETTE.passed,
  rejected: PALETTE.failed,
  failed: PALETTE.failed,
  // runs
  draft: PALETTE.pending,
  'in progress': PALETTE.inProgress,
  closed: { ...PALETTE.passed, label: 'Closed' },
  // orders / dispatch / shipment
  open: PALETTE.pending,
  dispatched: PALETTE.dispatched,
  'partially dispatched': { ...PALETTE.dispatched, label: 'Partially Dispatched' },
  'in transit': PALETTE.outForDelivery,
  'out for delivery': PALETTE.outForDelivery,
  delivered: PALETTE.delivered,
  'partially delivered': { ...PALETTE.delivered, label: 'Partially Delivered' },
  returned: PALETTE.returned,
  rescheduled: { ...PALETTE.pending, label: 'Rescheduled' },
  cancelled: PALETTE.cancelled,
  // packing picks
  picked: PALETTE.inProgress,
  sampled: PALETTE.inProgress,
  // purchase orders
  sent: PALETTE.pending,
  acknowledged: PALETTE.inProgress,
  received: { ...PALETTE.passed, label: 'Received' },
  // challans
  issued: { ...PALETTE.passed, label: 'Issued' },
  superseded: { ...PALETTE.cancelled, label: 'Superseded' },
  // expiry / destruction read as failure, as today
  expired: { ...PALETTE.failed, label: 'Expired' },
  destroyed: { ...PALETTE.failed, label: 'Destroyed' },
}

/** Unknown keys fall through by family, ordered most-specific first. */
const FAMILY: [string, PaletteEntry][] = [
  ['partially delivered', { ...PALETTE.delivered, label: 'Partially Delivered' }],
  ['partially dispatched', { ...PALETTE.dispatched, label: 'Partially Dispatched' }],
  ['out for delivery', PALETTE.outForDelivery],
  ['in transit', PALETTE.outForDelivery],
  ['delivered', PALETTE.delivered],
  ['dispatched', PALETTE.dispatched],
  ['returned', PALETTE.returned],
  ['cancelled', PALETTE.cancelled],
  ['fail', PALETTE.failed],
  ['reject', PALETTE.failed],
  ['rework', PALETTE.rework],
  ['retest', PALETTE.rework],
  ['pass', PALETTE.passed],
  ['released', PALETTE.released],
  ['hold', PALETTE.onHold],
  ['quarantine', PALETTE.onHold],
  ['awaiting', PALETTE.onHold],
  ['pending', PALETTE.onHold],
  ['in progress', PALETTE.inProgress],
  ['in test', PALETTE.inProgress],
]

export interface StatusReading {
  label: string
  tone: PaletteTone
  icon?: string
}

/** The one reading of a stored status key; undefined = legacy rendering. */
export function readStatus(value: string): StatusReading | undefined {
  const v = (value || '').toLowerCase()
  const exact = EXACT[v]
  if (exact) return { label: exact.label ?? exact.palette, tone: exact.tone, icon: exact.icon }
  // 'inactive' must not fall into any family — it is a master-data state.
  if (v.includes('inactive') || v.includes('retired') || v.includes('suspended')) return undefined
  for (const [needle, entry] of FAMILY) {
    if (v.includes(needle)) return { label: entry.label ?? entry.palette, tone: entry.tone, icon: entry.icon }
  }
  return undefined
}
