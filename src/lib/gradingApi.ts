/**
 * Fetch client for POST /api/grading — the Coconut Grading form's one server
 * call (WORKFLOW W7). Same session semantics and Idempotency-Key discipline as
 * the PO client, whose helpers it shares; PoApiError is the shared refusal
 * shape (message plus the guard's code and field details) so the form branches
 * on the guard that refused.
 */
import { call, newIdempotencyKey, read } from './poApi'
import { PoApiError } from './poApi'
import type { StagedGradingRequest, StagedGradingResponse } from './contracts'

export { PoApiError }

/**
 * Posts one staged lot's grades. The key defaults to a fresh one per call —
 * the endpoint's own guards (already_graded, the CAS on the receipt's version)
 * make a re-submitted grading safe even if an operator retries with a new key,
 * and the form's busy flag keeps a double-tap from racing itself.
 */
export async function postStagedGrading(
  body: StagedGradingRequest,
  key = newIdempotencyKey(),
): Promise<StagedGradingResponse> {
  const res = await call('/api/grading', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  return read<StagedGradingResponse>(res)
}
