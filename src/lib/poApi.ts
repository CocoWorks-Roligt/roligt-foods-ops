/**
 * Fetch client for /api/purchase-orders — the PO register and form's whole
 * server surface (WORKFLOW W4). Carries adminApi's session semantics (same-
 * origin cookie, one 401 is final and swaps in the login screen) plus the
 * Idempotency-Key every mutating call needs, so a double-tap or a flaky
 * connection can never mint two numbers or move a status twice.
 */
import { notifyUnauthorized } from './authEvents'
import { UnauthorizedError } from './dbApi'
import type {
  PurchaseOrder,
  PurchaseOrderCreateRequest,
  PurchaseOrderListResponse,
  PurchaseOrderPatchRequest,
  PurchaseOrderResponse,
  PurchaseOrderVersionExtension,
} from './contracts'

/** A refusal the form can branch on: `code` names the guard, `details` the fields. */
export class PoApiError extends Error {
  readonly code?: string
  readonly details?: Record<string, string>
  constructor(message: string, code?: string, details?: Record<string, string>) {
    super(message)
    this.name = 'PoApiError'
    this.code = code
    this.details = details
  }
}

async function call(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init?.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...headers, ...((init?.headers ?? {}) as Record<string, string>) },
  })
  if (res.status === 401) {
    notifyUnauthorized()
    throw new UnauthorizedError()
  }
  return res
}

/** Reads the shared ApiError shape; only the ok arm returns. */
async function read<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const e = j as { error?: string; code?: string; details?: Record<string, string> }
    throw new PoApiError(e.error ?? `Request failed (HTTP ${res.status}).`, e.code, e.details)
  }
  return j as T
}

/** A fresh key per intent — a retry of the same intent reuses the same key. */
export const newIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `po-${Date.now()}-${Math.random().toString(36).slice(2)}`

export type PurchaseOrderRow = PurchaseOrder & PurchaseOrderVersionExtension

export async function fetchPurchaseOrders(): Promise<PurchaseOrderRow[]> {
  const res = await call('/api/purchase-orders')
  const j = await read<PurchaseOrderListResponse>(res)
  return j.pos
}

export async function createPurchaseOrderCall(
  body: PurchaseOrderCreateRequest,
  key = newIdempotencyKey(),
): Promise<PurchaseOrderResponse['po']> {
  const res = await call('/api/purchase-orders', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  return (await read<PurchaseOrderResponse>(res)).po
}

export async function patchPurchaseOrderCall(
  id: string,
  body: PurchaseOrderPatchRequest,
  key = newIdempotencyKey(),
): Promise<PurchaseOrderResponse['po']> {
  const res = await call(`/api/purchase-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    idempotencyKey: key,
  })
  return (await read<PurchaseOrderResponse>(res)).po
}
