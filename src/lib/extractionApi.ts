/**
 * Fetch client for POST /api/transformations/close — the Extraction stage
 * form's one server call (WORKFLOW W8). Same session semantics and
 * Idempotency-Key discipline as the PO client, whose helpers it shares;
 * PoApiError is the shared refusal shape so the form branches on the guard
 * that refused (cas_version, already_closed, the spoilage guards).
 */
import { call, newIdempotencyKey, read } from './poApi'
import { PoApiError } from './poApi'
import type { CloseTransformationRequest, CloseTransformationResponse } from './contracts'

export { PoApiError }

/**
 * Closes one run: files the spoilage records, stamps the batch Closed and
 * stores the server-computed mass balance. The key defaults to a fresh one
 * per call — a refusal writes no receipt, so a cas_version retry with a new
 * expectedVersion simply tries again, and a re-submitted close that already
 * landed is refused as already_closed rather than double-filing. (Replaying
 * the SAME key+body returns the stored verdict; the form's busy flag keeps a
 * double-tap from racing itself.)
 */
export async function postRunClose(
  body: CloseTransformationRequest,
  key = newIdempotencyKey(),
): Promise<CloseTransformationResponse> {
  const res = await call('/api/transformations/close', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  return read<CloseTransformationResponse>(res)
}
