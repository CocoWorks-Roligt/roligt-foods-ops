/**
 * The run-close guards — what a batch needs before it may close (§3.2:
 * spoilage is MANDATORY; an explicit zero is a deliberate entry and counts)
 * and the mass-balance verdict a close recomputes (contracts run machine:
 * Awaiting QC → Closed behind guards spoilage_required + mass_balance_ok).
 */
import { GUARD_EXPLANATIONS, type MassBalanceResult, type SpoilageRecord } from '../contracts.ts'

export type RunCloseGuard = 'spoilage_required' | 'mass_balance_ok'

/** One guard judged for one batch's close. */
export interface RunGuardVerdict {
  guard: RunCloseGuard
  passed: boolean
  /** The plain-language refusal when failed (contracts GUARD_EXPLANATIONS);
   *  empty when the guard passed. */
  explanation: string
}

/**
 * The guards on closing a run: at least one spoilage record for THIS batch
 * (qty 0 satisfies it — the point is that spoilage was said), and the
 * mass-balance variance within tolerance. The mass balance is computed by the
 * caller (computeMassBalance over the batch's lines and records) and judged
 * here so the verdict and the explanation cannot drift apart.
 */
export function closeRunGuards(
  batch: { id: string },
  spoilageRecords: readonly SpoilageRecord[],
  massBalance: MassBalanceResult,
): RunGuardVerdict[] {
  const forThisBatch = spoilageRecords.filter((r) => r.batchId === batch.id)
  return [
    {
      guard: 'spoilage_required',
      passed: forThisBatch.length > 0,
      explanation: forThisBatch.length > 0 ? '' : GUARD_EXPLANATIONS.spoilage_required,
    },
    {
      guard: 'mass_balance_ok',
      passed: massBalance.withinTolerance,
      explanation: massBalance.withinTolerance ? '' : GUARD_EXPLANATIONS.mass_balance_ok,
    },
  ]
}

/** The guards that failed, in verdict order — empty when the close may land. */
export function failedRunGuards(verdicts: readonly RunGuardVerdict[]): RunCloseGuard[] {
  return verdicts.filter((v) => !v.passed).map((v) => v.guard)
}
