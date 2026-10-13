/**
 * The carton rules — the pouch-to-carton decision BIB dispatch makes at
 * pick/pack (§3.3-9). One transaction decrements pouches and, only when the
 * line goes out BOXED, cartons; LOOSE dispatch leaves carton stock untouched.
 * Partial cartons are allowed: a part-filled carton still costs one carton.
 *
 * Specs are the editable reference data seeded per BIB size (DECISIONS #14);
 * the customer's dispatchPackaging preference (default ASK) decides whether
 * cartons are wanted at all.
 */
import type { BibSize, CartonSpec, DispatchPackaging } from '../contracts.ts'

/** Pouches going out at one BIB size. */
export interface CartonLine {
  bibSize: BibSize
  pouches: number
}

/** What pick/pack suggests for one BIB size. */
export interface CartonSuggestion {
  bibSize: BibSize
  cartonItemId: string
  totalPouches: number
  /** Cartons the pouches fill completely. */
  fullCartons: number
  /** Pouches left over — they ride out in one part-filled carton. */
  partialPouches: number
  /** Cartons the line consumes: full ones, plus one when a partial remains. */
  cartonsNeeded: number
}

/**
 * The suggestion for the dispatch's lines: pouches pooled per BIB size, then
 * measured against that size's ACTIVE spec. A LOOSE customer is offered
 * nothing (carton stock stays untouched); sizes with no active spec are left
 * out rather than guessed at — the master has to answer (DECISIONS #14).
 */
export function suggestCartons(
  lines: readonly CartonLine[],
  cartonSpecs: readonly CartonSpec[],
  customerPref: DispatchPackaging,
): CartonSuggestion[] {
  if (customerPref === 'LOOSE') return []
  const pooled = new Map<BibSize, number>()
  for (const line of lines) {
    if (!(Number(line.pouches) > 0)) continue
    pooled.set(line.bibSize, (pooled.get(line.bibSize) ?? 0) + line.pouches)
  }
  const out: CartonSuggestion[] = []
  for (const [bibSize, totalPouches] of pooled) {
    const spec = cartonSpecs.find((s) => s.active && s.bibSize === bibSize && s.pouchesPerCarton > 0)
    if (!spec) continue
    const fullCartons = Math.floor(totalPouches / spec.pouchesPerCarton)
    const partialPouches = totalPouches % spec.pouchesPerCarton
    out.push({
      bibSize,
      cartonItemId: spec.cartonItemId,
      totalPouches,
      fullCartons,
      partialPouches,
      cartonsNeeded: fullCartons + (partialPouches > 0 ? 1 : 0),
    })
  }
  return out
}

/** What one dispatch line's confirmation takes out of stock. */
export interface CartonDeduction {
  /** Pouches decremented — always, however the line is packed. */
  pouches: number
  /** Cartons decremented — only when BOXED (a partial carton counts as one). */
  cartons: number
  /** The carton item the cartons come off; absent when none are deducted. */
  cartonItemId?: string
}

/**
 * The deduction plan: pouches move whatever the mode; cartons move only when
 * BOXED. A partial carton is allowed and still deducts one carton — the
 * caller passes the cartons the operator confirmed (suggestCartons's
 * cartonsNeeded, confirmed or edited), not a rounding of its own.
 */
export function planDeduction(
  mode: 'BOXED' | 'LOOSE',
  plan: { pouches: number; cartons: number; cartonItemId?: string },
): CartonDeduction {
  const boxed = mode === 'BOXED' && plan.cartons > 0
  return {
    pouches: plan.pouches,
    cartons: boxed ? plan.cartons : 0,
    ...(boxed && plan.cartonItemId ? { cartonItemId: plan.cartonItemId } : {}),
  }
}

/** One period's carton count for one carton item, as the register records it. */
export interface CartonReconEntry {
  cartonItemId: string
  issued: number
  used: number
  damaged: number
}

/** The same counts folded per carton item, with what reconciliation chases. */
export interface CartonReconTotal extends CartonReconEntry {
  /** issued − used − damaged: cartons nobody has accounted for yet (negative
   *  means more accounted for than were ever issued). */
  unaccounted: number
}

/**
 * The reconciliation fold (§3.3-9: carton reconciliation issued / used /
 * damaged): entries pooled per carton item, unaccounted the difference. Pure
 * arithmetic over the register's rows — the report and the dashboard fold the
 * same way, so their numbers match by construction.
 */
export function reconcileCartons(entries: readonly CartonReconEntry[]): CartonReconTotal[] {
  const byItem = new Map<string, CartonReconTotal>()
  for (const e of entries) {
    const total = byItem.get(e.cartonItemId) ?? {
      cartonItemId: e.cartonItemId,
      issued: 0,
      used: 0,
      damaged: 0,
      unaccounted: 0,
    }
    total.issued += Number(e.issued) || 0
    total.used += Number(e.used) || 0
    total.damaged += Number(e.damaged) || 0
    byItem.set(e.cartonItemId, total)
  }
  for (const total of byItem.values()) total.unaccounted = total.issued - total.used - total.damaged
  return [...byItem.values()]
}
