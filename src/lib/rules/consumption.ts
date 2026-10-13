/**
 * The consumption rules — whether a lot may be drawn for a purpose, and the
 * FEFO order lots are offered in (§3.3-3/7, DECISIONS #8).
 *
 * Two regimes, one switch. Under qc_gate_v2 the hard gate applies: only
 * Released stock may be blended, packed or dispatched — server-enforced
 * (rulesGate) and pre-checked here. With the flag off, the Classic rule
 * stands: bulk sitting in Quarantine may be drawn by a blend or a packing run
 * (posting.ts DRAWABLE), while dispatch was always Released-only.
 *
 * Not imported from posting.ts on purpose: this module compiles under the api
 * project's nodenext tsconfig, which extensionless imports do not survive.
 */
import { GUARD_EXPLANATIONS, type FefoMode } from '../contracts.ts'

export type ConsumePurpose = 'blend' | 'pack' | 'dispatch'

/**
 * The statuses a blend or packing run may draw bulk from today (posting.ts
 * DRAWABLE, mirrored): Available, Quarantine (the Classic blendable case) and
 * Released. Stock QC rejected is in none of them.
 */
export const LEGACY_DRAWABLE = ['Available', 'Quarantine', 'Released'] as const

/** What the consumption question was decided against. */
export interface ConsumptionVerdict {
  ok: boolean
  purpose: ConsumePurpose
  status: string
  /** Which regime judged it — 'legacy' (flag off) or 'v2' (qc_gate_v2 on). */
  mode: 'legacy' | 'v2'
  /** The guard that refused, when one did. */
  guard?: 'released_only'
  /** Plain-language refusal (contracts GUARD_EXPLANATIONS), '' when ok. */
  explanation: string
}

/**
 * May this lot be drawn for that purpose? Under qc_gate_v2: Released only, for
 * every purpose. Legacy: blends and packing runs draw from LEGACY_DRAWABLE
 * (Quarantine bulk is blendable — the rule the flag retires); dispatch has
 * always required Released stock (checkDispatch).
 */
export function canConsumeLot(
  lot: { status: string },
  opts: { purpose: ConsumePurpose; qcGateV2: boolean },
): ConsumptionVerdict {
  const status = lot?.status ?? ''
  const mode = opts.qcGateV2 ? 'v2' : 'legacy'
  const ok = opts.qcGateV2
    ? status === 'Released'
    : opts.purpose === 'dispatch'
      ? status === 'Released'
      : (LEGACY_DRAWABLE as readonly string[]).includes(status)
  return {
    ok,
    purpose: opts.purpose,
    status,
    mode,
    ...(ok ? {} : { guard: 'released_only' as const }),
    explanation: ok ? '' : GUARD_EXPLANATIONS.released_only,
  }
}

/** A lot as FEFO needs to see it — expiry earliest-first is the whole sort. */
export interface FefoLot {
  lot: string
  /** Best-before the stock carries; a lot without one is offered last. */
  expiry?: string
}

/**
 * Lots in first-expiry-first-out order (DECISIONS #8): earliest expiry first,
 * ties broken by lot id so the order is stable, lots with no expiry last.
 * Non-mutating — the input is sorted into a new array.
 *
 * `strict` refuses expired stock a place in the pick entirely (today's date
 * or later only); `relaxed` keeps everything, sorted — the plant's configured
 * mode. Status filtering is not FEFO's business: canConsumeLot decides
 * whether a lot may be drawn at all.
 */
export function fefoOrder<T extends FefoLot>(lots: readonly T[], mode: FefoMode, today?: string): T[] {
  const now = today ?? new Date().toISOString().slice(0, 10)
  const out = [...lots]
  if (mode === 'strict') {
    const live = out.filter((l) => !l.expiry || l.expiry >= now)
    out.length = 0
    out.push(...live)
  }
  return out.sort((a, b) => {
    const ae = a.expiry || '9999-12-31'
    const be = b.expiry || '9999-12-31'
    return ae < be ? -1 : ae > be ? 1 : a.lot < b.lot ? -1 : a.lot > b.lot ? 1 : 0
  })
}
